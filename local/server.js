'use strict';

/*
 * Dota Companion — единая локальная точка входа.
 *
 * Один порт и один процесс:
 *   /            — анализатор матчей и AI-тренер
 *   /progress.html — трекер прогресса
 *   /draft       — помощник по драфту (All Pick)
 *   /dota2-gsi   — приём данных от Dota 2
 *
 * Запуск:  node local/server.js
 */

const http = require('node:http');
const { spawn } = require('node:child_process');

const analyzer = require('../apps/analyzer/server');
const draft = require('../apps/draft/server');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';

const draftHandler = draft.createHandler({ staticPrefix: '/draft' });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
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
