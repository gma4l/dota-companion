'use strict';

/*
 * Dota 2 Draft Assistant — веб-слой.
 *
 * Тонкий HTTP-обработчик: GSI, состояние драфта, статика.
 * Вся логика — в core/draft.js, поэтому тот же код использует
 * и объединённый сервер (local/server.js), и публичная версия.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../../core/draft');
const { heroList } = require('../../core/heroes');

const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

/**
 * Создаёт независимый обработчик со своим состоянием драфта.
 *
 * @param {object} [options]
 * @param {string} [options.staticPrefix] — префикс, под которым раздаётся UI
 *        (например, '/draft'); пустой — корень.
 * @returns {{ handle: Function, state: object }}
 */
function createHandler(options = {}) {
  const state = core.createState();
  const staticPrefix = (options.staticPrefix || '').replace(/\/+$/, '');

  async function handle(req, res, url) {
    url = url || new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (req.method === 'POST' && (p === '/dota2-gsi' || p === '/gsi')) {
      core.applyGsi(state, await readBody(req));
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (req.method === 'GET' && p === '/api/state') {
      sendJson(res, 200, core.snapshot(state));
      return true;
    }

    if (req.method === 'GET' && p === '/api/heroes') {
      sendJson(res, 200, { heroes: heroList() });
      return true;
    }

    // Ручной ввод: демо-режим и паблики (All Pick).
    if (req.method === 'POST' && p === '/api/manual') {
      core.applyManual(state, await readBody(req));
      sendJson(res, 200, { ok: true, recs: core.computeRecommendations(state) });
      return true;
    }

    if (req.method === 'POST' && p === '/api/reset') {
      core.resetDraft(state);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (req.method === 'POST' && p === '/api/side') {
      const body = await readBody(req);
      if (body.side === 'radiant' || body.side === 'dire') state.side = body.side;
      sendJson(res, 200, { ok: true, side: state.side });
      return true;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    // Статика: либо в корне, либо под staticPrefix.
    let staticPath = p;
    if (staticPrefix) {
      if (staticPath !== staticPrefix && !staticPath.startsWith(staticPrefix + '/')) return false;
      staticPath = staticPath.slice(staticPrefix.length) || '/';
    }
    serveStatic(res, staticPath);
    return true;
  }

  return { handle, state };
}

function createServer(options = {}) {
  const { handle } = createHandler(options);
  return http.createServer((req, res) => {
    handle(req, res).catch((err) => sendJson(res, 500, { error: String((err && err.message) || err) }));
  });
}

module.exports = { createHandler, createServer };

// ────────────────────────── Самостоятельный запуск ──────────────────────────

if (require.main === module) {
  const PORT = Number(process.env.PORT || 3210);
  const HOST = process.env.HOST || '127.0.0.1';

  createServer().listen(PORT, HOST, () => {
    console.log('==============================================================');
    console.log('  Dota 2 Draft Assistant');
    console.log(`  Веб-интерфейс:  http://${HOST}:${PORT}`);
    console.log(`  GSI endpoint:   http://${HOST}:${PORT}/dota2-gsi`);
    console.log('  Для теста без игры используй демо-режим в интерфейсе.');
    console.log('==============================================================');
  });
}
