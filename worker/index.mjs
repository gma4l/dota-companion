'use strict';

/*
 * Dota Companion — публичное API (Cloudflare Worker).
 *
 * Без ИИ и без состояния: только чистые вычисления и прокси к OpenDota.
 * Логика драфта берётся из core/ — тот же код, что и в локальной версии.
 */

import draftCore from '../core/draft.js';
import heroesModule from '../core/heroes.js';

const { heroList } = heroesModule;

const OPENDOTA = 'https://api.opendota.com/api';
const MAX_BODY_BYTES = 32 * 1024;
const CACHE_TTL = 300;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS,
    },
  });
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('Слишком большой запрос.');
  if (!text) return {};
  return JSON.parse(text);
}

/** Приводит входной драфт к безопасному виду. */
function sanitizeDraft(body) {
  const list = (v, max) =>
    (Array.isArray(v) ? v : [])
      .filter((x) => typeof x === 'string' && x.length <= 64)
      .slice(0, max);

  return {
    side: body.side === 'dire' ? 'dire' : 'radiant',
    ownHero: typeof body.ownHero === 'string' ? body.ownHero : null,
    radiantPicks: list(body.radiantPicks, 5),
    radiantBans: list(body.radiantBans, 7),
    direPicks: list(body.direPicks, 5),
    direBans: list(body.direBans, 7),
  };
}

/** Прокси к OpenDota с кэшем на 5 минут: бережём бесплатный лимит. */
async function proxyOpenDota(path) {
  const upstream = await fetch(OPENDOTA + path, {
    headers: { Accept: 'application/json' },
    cf: { cacheEverything: true, cacheTtl: CACHE_TTL },
  });

  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${CACHE_TTL}`,
      ...CORS,
    },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      if (request.method === 'GET' && url.pathname === '/api/health') {
        return json({ ok: true, service: 'dota-companion', ai: false });
      }

      if (request.method === 'GET' && url.pathname === '/api/heroes') {
        return json({ heroes: heroList() });
      }

      if (request.method === 'POST' && url.pathname === '/api/draft') {
        const state = draftCore.createState();
        draftCore.applyManual(state, sanitizeDraft(await readJson(request)));
        return json(draftCore.snapshot(state));
      }

      const match = url.pathname.match(/^\/api\/match\/(\d{6,})$/);
      if (request.method === 'GET' && match) {
        return proxyOpenDota(`/matches/${match[1]}`);
      }

      if (request.method === 'GET' && url.pathname === '/api/constants/heroes') {
        return proxyOpenDota('/constants/heroes');
      }

      const player = url.pathname.match(/^\/api\/player\/(\d{1,12})$/);
      if (request.method === 'GET' && player) {
        return proxyOpenDota(`/players/${player[1]}`);
      }

      return json({ error: 'Такого адреса нет.' }, 404);
    } catch (err) {
      return json({ error: String((err && err.message) || err) }, 500);
    }
  },
};
