'use strict';

/*
 * Dota 2 Draft Assistant — локальный сервер.
 *
 * Тонкий HTTP-слой: раздаёт интерфейс, принимает GSI от Dota 2
 * и отдаёт состояние драфта. Вся логика — в core/draft.js.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../../core/draft');
const { heroList } = require('../../core/heroes');

const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || '127.0.0.1';
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

const state = core.createState();

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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
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

async function route(req, res, url) {
  if (req.method === 'POST' && (url.pathname === '/dota2-gsi' || url.pathname === '/gsi')) {
    core.applyGsi(state, await readBody(req));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    sendJson(res, 200, core.snapshot(state));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/heroes') {
    sendJson(res, 200, { heroes: heroList() });
    return;
  }

  // Ручной ввод: демо-режим и паблики (All Pick).
  if (req.method === 'POST' && url.pathname === '/api/manual') {
    core.applyManual(state, await readBody(req));
    sendJson(res, 200, { ok: true, recs: core.computeRecommendations(state) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/reset') {
    core.resetDraft(state);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/side') {
    const body = await readBody(req);
    if (body.side === 'radiant' || body.side === 'dire') state.side = body.side;
    sendJson(res, 200, { ok: true, side: state.side });
    return;
  }

  serveStatic(res, url.pathname);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    await route(req, res, url);
  } catch (err) {
    sendJson(res, 500, { error: String((err && err.message) || err) });
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
