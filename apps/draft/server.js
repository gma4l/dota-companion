'use strict';

/*
 * Dota 2 Draft Assistant — сервер (без внешних зависимостей).
 * Принимает Game State Integration (GSI) от Dota 2, парсит драфт
 * (пики/баны radiant и dire), определяет сторону игрока и выдаёт
 * топ-5 героев по каждой позиции (1–5) на основе контрпиков,
 * синергий и ролей.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3210;
const HOST = '127.0.0.1';

// ---------------------------------------------------------------------------
// Загрузка базы героев
// ---------------------------------------------------------------------------
const heroesData = JSON.parse(fs.readFileSync(path.join(__dirname, 'heroes.json'), 'utf8'));
const HEROES = heroesData.heroes;

// Алиасы имён -> канонический ключ в heroes.json
const CLASS_ALIASES = {
  'bristleback': 'bristleback',
  'nature_prophet': 'furion',
  'furion': 'furion',
  'windranger': 'windrunner',
  'windrunner': 'windrunner',
  'wraith_king': 'skeleton_king',
  'skeleton_king': 'skeleton_king',
  'lifestealer': 'life_stealer',
  'life_stealer': 'life_stealer',
  'doom': 'doom_bringer',
  'doom_bringer': 'doom_bringer',
  'clockwerk': 'rattletrap',
  'rattletrap': 'rattletrap',
  'timbersaw': 'shredder',
  'shredder': 'shredder',
  'shadow_fiend': 'nevermore',
  'nevermore': 'nevermore',
  'zeus': 'zuus',
  'zuus': 'zuus',
  'necrophos': 'necrolyte',
  'necrolyte': 'necrolyte',
  'outworld_destroyer': 'obsidian_destroyer',
  'obsidian_destroyer': 'obsidian_destroyer',
  'queen_of_pain': 'queenofpain',
  'queenofpain': 'queenofpain',
  'io': 'wisp',
  'wisp': 'wisp',
  'magnus': 'magnataur',
  'magnataur': 'magnataur',
  'treant_protector': 'treant',
  'treant': 'treant',
  'underlord': 'abyssal_underlord',
  'abyssal_underlord': 'abyssal_underlord',
};

function resolveClass(cls) {
  if (!cls) return null;
  const c = cls.toLowerCase().replace(/^npc_dota_hero_/, '').trim();
  if (HEROES[c]) return c;
  if (CLASS_ALIASES[c]) return CLASS_ALIASES[c];
  return null;
}

// Нормализуем counters/synergy к каноническим ключам (защита от синонимов)
function canonicalizeList(list) {
  const out = [];
  for (const k of list || []) {
    const c = resolveClass(k) || k;
    if (c && HEROES[c] && !out.includes(c)) out.push(c);
  }
  return out;
}
for (const [key, h] of Object.entries(HEROES)) {
  h.counters = canonicalizeList(h.counters);
  h.synergy = canonicalizeList(h.synergy);
}

// Обратный индекс: hero -> список героев, которые его контрят
const COUNTERED_BY = {};
for (const [key, h] of Object.entries(HEROES)) {
  for (const target of h.counters) {
    if (!COUNTERED_BY[target]) COUNTERED_BY[target] = [];
    COUNTERED_BY[target].push(key);
  }
}

// ---------------------------------------------------------------------------
// Состояние драфта (в памяти)
// ---------------------------------------------------------------------------
let state = {
  connected: false,
  gameState: null,
  side: null,          // 'radiant' | 'dire' | null (неизвестно, по умолч. radiant)
  radiant: { picks: [], bans: [] },
  dire: { picks: [], bans: [] },
  pickPhase: null,     // true = пик, false = бан
  activeTeam: null,    // 2 | 3
  lastUpdate: null,
};

function resetDraft() {
  state = { ...state, radiant: { picks: [], bans: [] }, dire: { picks: [], bans: [] }, pickPhase: null, activeTeam: null };
}

function normHeroList(list) {
  const out = [];
  for (const item of list || []) {
    const key = resolveClass(item);
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Парсинг GSI-пейлоада
// ---------------------------------------------------------------------------
function parseGsi(payload) {
  if (!payload) return;

  const draft = payload.draft;
  if (draft) {
    const t2 = draft.team2 || {};
    const t3 = draft.team3 || {};

    const radiantPicks = [];
    const radiantBans = [];
    const direPicks = [];
    const direBans = [];

    for (let i = 0; i < 5; i++) {
      const p2 = t2[`pick${i}_class`];
      const p3 = t3[`pick${i}_class`];
      if (p2) radiantPicks.push(p2);
      if (p3) direPicks.push(p3);
    }
    for (let i = 0; i < 7; i++) {
      const b2 = t2[`ban${i}_class`];
      const b3 = t3[`ban${i}_class`];
      if (b2) radiantBans.push(b2);
      if (b3) direBans.push(b3);
    }

    state.radiant = { picks: normHeroList(radiantPicks), bans: normHeroList(radiantBans) };
    state.dire = { picks: normHeroList(direPicks), bans: normHeroList(direBans) };
    state.pickPhase = typeof draft.pick === 'boolean' ? draft.pick : null;
    state.activeTeam = draft.activeteam || null;
    state.connected = true;
    state.lastUpdate = Date.now();
  }

  if (payload.map && payload.map.game_state) {
    state.gameState = payload.map.game_state;
  }

  // Сторона игрока
  const pname = payload.player && payload.player.team_name;
  if (pname === 'radiant' || pname === 'dire') {
    state.side = pname;
  }
}

// ---------------------------------------------------------------------------
// Движок рекомендаций
// ---------------------------------------------------------------------------
function heroInfo(key) {
  const h = HEROES[key];
  if (!h) return null;
  return { key, name: h.name, ru: h.ru, attr: h.attr, roles: h.roles };
}

function alliesAndEnemies() {
  const side = state.side || 'radiant';
  const allies = side === 'radiant' ? state.radiant.picks : state.dire.picks;
  const enemies = side === 'radiant' ? state.dire.picks : state.radiant.picks;
  return { side, allies, enemies };
}

const round1 = (x) => Math.round(x * 10) / 10;

function computeRecommendations() {
  const { side, allies, enemies } = alliesAndEnemies();
  const allTaken = new Set([
    ...state.radiant.picks, ...state.dire.picks,
    ...state.radiant.bans, ...state.dire.bans,
  ]);

  const positions = {};
  for (let p = 1; p <= 5; p++) {
    const scored = [];

    for (const [key, h] of Object.entries(HEROES)) {
      if (allTaken.has(key)) continue;
      if (!h.roles.includes(p)) continue;

      let counter = 0;
      const countersVs = [];   // кого из врагов этот герой контрит
      const counteredBy = [];  // кто из врагов контрит этого героя
      for (const e of enemies) {
        if (h.counters.includes(e)) { counter += 2; countersVs.push(e); }
        if ((COUNTERED_BY[key] || []).includes(e)) { counter -= 2; counteredBy.push(e); }
      }

      let synergy = 0;
      const synWith = [];
      for (const a of allies) {
        if (h.synergy.includes(a)) { synergy += 1.5; synWith.push(a); }
      }

      // универсальность: закрывает сразу несколько проблем драфта
      let versatility = 0;
      if (countersVs.length >= 2) versatility += 1;
      if (synWith.length >= 2) versatility += 0.5;

      const roleBonus = h.roles[0] === p ? 2 : 1;
      const score = counter + synergy + roleBonus + versatility;

      scored.push({
        key, name: h.name, ru: h.ru, attr: h.attr, roles: h.roles,
        score: round1(score), countersVs, counteredBy, synWith,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    positions[p] = scored.slice(0, 5);
  }

  return {
    side, allies, enemies, positions,
    bans: computeBans(allies, enemies, allTaken),
    threats: computeThreats(allies, enemies),
    composition: computeComposition(allies),
  };
}

// Кого забанить: герои, которые контрят твою команду или усиливают врага
function computeBans(allies, enemies, allTaken) {
  const scored = [];
  for (const [key, h] of Object.entries(HEROES)) {
    if (allTaken.has(key)) continue;
    let score = 0;
    const reasons = [];
    for (const a of allies) {
      if (h.counters.includes(a)) { score += 2; reasons.push('бьёт ' + HEROES[a].name); }
    }
    for (const e of enemies) {
      if (h.synergy.includes(e) || (HEROES[e] && HEROES[e].synergy.includes(key))) {
        score += 1.5; reasons.push('усилит ' + HEROES[e].name);
      }
    }
    if (score > 0) {
      scored.push({
        key, name: h.name, ru: h.ru, attr: h.attr,
        score: round1(score), reasons: [...new Set(reasons)].slice(0, 3),
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 7);
}

// Угрозы: враги, которые контрят твоих героев
function computeThreats(allies, enemies) {
  const threats = [];
  for (const e of enemies) {
    const eh = HEROES[e];
    if (!eh) continue;
    const vs = [];
    for (const a of allies) {
      if (eh.counters.includes(a)) vs.push(a);
    }
    if (vs.length) threats.push({ key: e, name: eh.name, ru: eh.ru, attr: eh.attr, vs });
  }
  return threats;
}

// Анализ состава 5v5
function computeComposition(allies) {
  const roleCoverage = { 1: false, 2: false, 3: false, 4: false, 5: false };
  const attrCount = { str: 0, agi: 0, int: 0 };
  for (const a of allies) {
    const h = HEROES[a];
    if (!h) continue;
    for (const r of h.roles) roleCoverage[r] = true;
    attrCount[h.attr] = (attrCount[h.attr] || 0) + 1;
  }

  const notes = [];
  if (allies.length === 0) {
    notes.push('Добавь своих героев — анализ состава появится.');
  } else {
    if (attrCount.str === 0) notes.push('Нет героя-силача — команда без фронтлайна.');
    if (attrCount.int === 0) notes.push('Нет героя-интеллекта — мало магии и контроля.');
    const missing = [1, 2, 3, 4, 5].filter((p) => !roleCoverage[p]);
    if (missing.length) notes.push('Свободные позиции: ' + missing.join(', ') + '.');
    if (!missing.length) notes.push('Все позиции закрыты.');
  }

  return { roleCoverage, attrCount, notes };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(__dirname, 'public', path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 2e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'POST' && (url.pathname === '/dota2-gsi' || url.pathname === '/gsi')) {
      const payload = await readBody(req);
      parseGsi(payload);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      sendJson(res, 200, {
        connected: state.connected,
        gameState: state.gameState,
        side: state.side,
        pickPhase: state.pickPhase,
        activeTeam: state.activeTeam,
        lastUpdate: state.lastUpdate,
        radiant: state.radiant,
        dire: state.dire,
        recs: computeRecommendations(),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/heroes') {
      const list = Object.entries(HEROES).map(([key, h]) => ({
        key, name: h.name, ru: h.ru, attr: h.attr, roles: h.roles,
      }));
      sendJson(res, 200, { heroes: list });
      return;
    }

    // Демо-режим: ручная установка драфта для теста без игры
    if (req.method === 'POST' && url.pathname === '/api/manual') {
      const body = await readBody(req);
      resetDraft();
      state.side = body.side || state.side || 'radiant';
      state.radiant = {
        picks: normHeroList(body.radiantPicks),
        bans: normHeroList(body.radiantBans),
      };
      state.dire = {
        picks: normHeroList(body.direPicks),
        bans: normHeroList(body.direBans),
      };
      state.connected = false;
      state.lastUpdate = Date.now();
      sendJson(res, 200, { ok: true, recs: computeRecommendations() });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/reset') {
      resetDraft();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/side') {
      const body = await readBody(req);
      if (body.side === 'radiant' || body.side === 'dire') state.side = body.side;
      sendJson(res, 200, { ok: true, side: state.side });
      return;
    }

    serveStatic(req, res, url.pathname);
  } catch (err) {
    sendJson(res, 500, { error: String(err && err.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log('==============================================================');
  console.log('  Dota 2 Draft Assistant');
  console.log(`  Веб-интерфейс:  http://${HOST}:${PORT}`);
  console.log(`  GSI endpoint:   http://${HOST}:${PORT}/dota2-gsi`);
  console.log('  Для теста без игры используй демо-режим в интерфейсе.');
  console.log('==============================================================');
});
