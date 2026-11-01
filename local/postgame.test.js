'use strict';

/*
 * Тесты наблюдения за концом матча. Запуск: node local/postgame.test.js
 */

const assert = require('node:assert');
const pg = require('./postgame');

let passed = 0;
let failed = 0;

function test(name, fn) {
  const ok = () => { passed++; console.log('  ok   ' + name); };
  const fail = (err) => { failed++; console.log('  FAIL ' + name + '\n       ' + err.message); };

  let result;
  try {
    result = fn();
  } catch (err) {
    fail(err);
    return Promise.resolve();
  }

  if (result && typeof result.then === 'function') return result.then(ok, fail);
  ok();
  return Promise.resolve();
}

const postGame = (matchid) => ({
  map: { game_state: 'DOTA_GAMERULES_STATE_POST_GAME', matchid: String(matchid) },
});

(async function run() {
  console.log('Наблюдение за GSI:');

  await test('конец матча с matchid начинает слежение', () => {
    const w = pg.createWatch();
    const started = pg.observe(w, postGame(900001), 1000);
    assert.equal(started, true);
    assert.equal(w.matchId, 900001);
    assert.equal(w.status, 'waiting');
    assert.equal(w.finishedAt, 1000);
    assert.equal(w.attempts, 0);
  });

  await test('игровое состояние без POST_GAME игнорируется', () => {
    const w = pg.createWatch();
    const started = pg.observe(w, { map: { game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', matchid: '900002' } });
    assert.equal(started, false);
    assert.equal(w.status, 'idle');
  });

  await test('matchid = 0 не запускает слежение', () => {
    const w = pg.createWatch();
    assert.equal(pg.observe(w, postGame(0)), false);
    assert.equal(w.status, 'idle');
  });

  await test('повторный POST_GAME не сбрасывает прогресс', async () => {
    const w = pg.createWatch();
    pg.observe(w, postGame(900003));
    await pg.check(w, { fetchMatch: async () => null, maxAttempts: 5 });
    const before = w.attempts;
    assert.equal(pg.observe(w, postGame(900003)), false);
    assert.equal(w.attempts, before);
    assert.equal(w.status, 'waiting');
  });

  await test('новый матч перезапускает слежение', () => {
    const w = pg.createWatch();
    pg.observe(w, postGame(900004));
    w.attempts = 7;
    assert.equal(pg.observe(w, postGame(900005)), true);
    assert.equal(w.matchId, 900005);
    assert.equal(w.attempts, 0);
  });

  console.log('\nПроверка готовности:');

  await test('появившийся матч переводит в ready', async () => {
    const w = pg.createWatch();
    pg.observe(w, postGame(900006));
    await pg.check(w, { fetchMatch: async () => ({ players: [] }) });
    assert.equal(w.status, 'ready');
    assert.equal(w.error, null);
  });

  await test('матч ещё не опубликован — остаёмся ждать', async () => {
    const w = pg.createWatch();
    pg.observe(w, postGame(900007));
    await pg.check(w, { fetchMatch: async () => null, maxAttempts: 3 });
    assert.equal(w.status, 'waiting');
    assert.equal(w.attempts, 1);
  });

  await test('после лимита попыток — ошибка', async () => {
    const w = pg.createWatch();
    pg.observe(w, postGame(900008));
    for (let i = 0; i < 3; i++) {
      await pg.check(w, { fetchMatch: async () => null, maxAttempts: 3 });
    }
    assert.equal(w.status, 'error');
    assert.ok(w.error);
  });

  await test('сетевая ошибка не роняет слежение', async () => {
    const w = pg.createWatch();
    pg.observe(w, postGame(900009));
    await pg.check(w, { fetchMatch: async () => { throw new Error('fetch failed'); }, maxAttempts: 3 });
    assert.equal(w.status, 'waiting');
    assert.equal(w.error, 'fetch failed');
  });

  await test('параллельные проверки не дублируются', async () => {
    const w = pg.createWatch();
    pg.observe(w, postGame(900010));
    let calls = 0;
    const slow = () => new Promise((resolve) => { calls++; setTimeout(() => resolve(null), 10); });
    await Promise.all([
      pg.check(w, { fetchMatch: slow, maxAttempts: 5 }),
      pg.check(w, { fetchMatch: slow, maxAttempts: 5 }),
    ]);
    assert.equal(calls, 1);
  });

  console.log('\nИнтерфейс и сброс:');

  await test('snapshot содержит нужные поля', () => {
    const snap = pg.snapshot(pg.createWatch());
    for (const key of ['status', 'matchId', 'finishedAt', 'attempts', 'maxAttempts', 'lastCheckAt', 'error']) {
      assert.ok(key in snap, 'нет поля ' + key);
    }
  });

  await test('dismiss очищает состояние', () => {
    const w = pg.createWatch();
    pg.observe(w, postGame(900011));
    pg.dismiss(w);
    assert.equal(w.status, 'idle');
    assert.equal(w.matchId, null);
    assert.equal(w.attempts, 0);
  });

  await test('после dismiss тот же матч можно поймать снова', () => {
    const w = pg.createWatch();
    pg.observe(w, postGame(900012));
    pg.dismiss(w);
    assert.equal(pg.observe(w, postGame(900012)), true);
  });

  console.log(`\nИтого: ${passed} прошло, ${failed} провалилось`);
  process.exit(failed ? 1 : 0);
})();
