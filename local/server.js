'use strict';

/*
 * Dota Companion — единая локальная точка входа.
 *
 * Один порт и один процесс:
 *   /             — анализатор матчей и AI-тренер
 *   /progress.html — трекер прогресса
 *   /draft        — помощник по драфту (All Pick)
 *   /dota2-gsi    — приём данных от Dota 2
 *
 * После матча GSI присылает POST_GAME с номером игры; сервер сам ждёт,
 * пока OpenDota его опубликует, и сообщает об этом интерфейсу.
 *
 * Запуск:  node local/server.js
 */

const http = require('node:http');
const { spawn } = require('node:child_process');

const analyzer = require('../apps/analyzer/server');
const draft = require('../apps/draft/server');
const postgame = require('./postgame');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';

// Наблюдение за завершённым матчем.
const watch = postgame.createWatch();
let firstCheckTimer = null;

function scheduleFirstCheck() {
  if (firstCheckTimer) return;
  // Даём игре и OpenDota несколько секунд форы.
  firstCheckTimer = setTimeout(() => {
    firstCheckTimer = null;
    postgame.check(watch).catch(() => {});
  }, 5000);
  firstCheckTimer.unref?.();
}

const draftHandler = draft.createHandler({
  staticPrefix: '/draft',
  onGsi: (payload) => {
    if (postgame.observe(watch, payload)) scheduleFirstCheck();
  },
});

setInterval(() => {
  postgame.check(watch).catch(() => {});
}, postgame.CHECK_INTERVAL_MS).unref?.();

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/postgame' && req.method === 'GET') {
      sendJson(res, 200, postgame.snapshot(watch));
      return;
    }

    if (url.pathname === '/api/postgame/dismiss' && req.method === 'POST') {
      postgame.dismiss(watch);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (await draftHandler.handle(req, res, url)) return;
    await analyzer.handle(req, res);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: String((err && err.message) || err) }));
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Порт ${PORT} занят. Другой порт:  set PORT=8081 && node local/server.js\n`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Dota Companion запущен:  ${url}`);
  console.log(`  Драфт (All Pick):        ${url}/draft`);
  console.log(`  Прогресс:                ${url}/progress.html`);
  console.log(`  GSI endpoint:            ${url}/dota2-gsi`);
  console.log('  Остановить: Ctrl+C\n');

  if (process.env.OPEN_BROWSER !== '0') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }
});
