'use strict';

/*
 * Тесты ядра драфта. Запуск: node core/draft.test.js
 */

const assert = require('node:assert');
const core = require('./draft');
const { resolveClass, HEROES } = require('./heroes');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL ' + name);
    console.log('       ' + err.message);
  }
}

console.log('Имена героев:');

test('алиас из GSI приводится к ключу базы', () => {
  assert.equal(resolveClass('npc_dota_hero_nevermore'), 'nevermore');
  assert.equal(resolveClass('shadow_fiend'), 'nevermore');
  assert.equal(resolveClass('zuus'), 'zuus');
});

test('неизвестный герой даёт null', () => {
  assert.equal(resolveClass('npc_dota_hero_who'), null);
  assert.equal(resolveClass(''), null);
});

test('списки контрпиков нормализованы', () => {
  for (const hero of Object.values(HEROES)) {
    for (const key of hero.counters) assert.ok(HEROES[key], 'неизвестный контр: ' + key);
    for (const key of hero.synergy) assert.ok(HEROES[key], 'неизвестная синергия: ' + key);
  }
});

console.log('\nGSI — Captains Mode:');

test('пики и баны разбираются по сторонам', () => {
  const s = core.createState();
  core.applyGsi(s, {
    draft: {
      pick: true,
      activeteam: 2,
      team2: { pick0_class: 'npc_dota_hero_axe', pick1_class: 'npc_dota_hero_lina', ban0_class: 'npc_dota_hero_pudge' },
      team3: { pick0_class: 'npc_dota_hero_nevermore', ban0_class: 'npc_dota_hero_zuus' },
    },
    player: { team_name: 'radiant' },
    map: { game_state: 'DOTA_GAMERULES_STATE_HERO_SELECTION' },
  });
  assert.deepEqual(s.radiant.picks, ['axe', 'lina']);
  assert.deepEqual(s.dire.picks, ['nevermore']);
  assert.deepEqual(s.radiant.bans, ['pudge']);
  assert.deepEqual(s.dire.bans, ['zuus']);
  assert.equal(s.side, 'radiant');
  assert.equal(s.connected, true);
  assert.equal(s.pickPhase, true);
  assert.equal(s.activeTeam, 2);
});

console.log('\nGSI — All Pick:');

test('свой герой добавляется в команду автоматически', () => {
  const s = core.createState();
  core.applyGsi(s, {
    player: { team_name: 'dire' },
    hero: { name: 'npc_dota_hero_juggernaut' },
    map: { game_state: 'DOTA_GAMERULES_STATE_PRE_GAME' },
  });
  assert.equal(s.side, 'dire');
  assert.equal(s.ownHero, 'juggernaut');
  assert.deepEqual(s.dire.picks, ['juggernaut']);
  assert.deepEqual(s.radiant.picks, []);
  assert.equal(s.gameState, 'DOTA_GAMERULES_STATE_PRE_GAME');
});

test('повторный GSI не дублирует героя', () => {
  const s = core.createState();
  const payload = { player: { team_name: 'radiant' }, hero: { name: 'axe' } };
  core.applyGsi(s, payload);
  core.applyGsi(s, payload);
  assert.deepEqual(s.radiant.picks, ['axe']);
});

test('без GSI-героя состояние не ломается', () => {
  const s = core.createState();
  core.applyGsi(s, { map: { game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS' } });
  assert.equal(s.ownHero, undefined);
  assert.deepEqual(s.radiant.picks, []);
});

test('новый матч очищает прошлый драфт', () => {
  const s = core.createState();
  core.applyGsi(s, {
    map: { matchid: '1001', game_state: 'DOTA_GAMERULES_STATE_POST_GAME' },
    player: { team_name: 'dire' },
    hero: { name: 'juggernaut' },
  });
  assert.equal(s.matchId, 1001);

  core.applyManual(s, { side: 'dire', radiantPicks: ['axe'], direPicks: ['juggernaut'] });
  assert.deepEqual(s.radiant.picks, ['axe']);

  core.applyGsi(s, {
    map: { matchid: '1002', game_state: 'DOTA_GAMERULES_STATE_HERO_SELECTION' },
    player: { team_name: 'radiant' },
  });
  assert.equal(s.matchId, 1002);
  assert.deepEqual(s.radiant.picks, []);
  assert.deepEqual(s.dire.picks, []);
  assert.equal(s.ownHero, null);
});

test('тот же матч не сбрасывает введённых героев', () => {
  const s = core.createState();
  core.applyGsi(s, { map: { matchid: '2001' } });
  core.applyManual(s, { side: 'radiant', radiantPicks: ['axe'], direPicks: ['pudge'] });
  core.applyGsi(s, { map: { matchid: '2001' } });
  assert.deepEqual(s.radiant.picks, ['axe']);
  assert.deepEqual(s.dire.picks, ['pudge']);
});

console.log('\nРучной ввод:');

test('manual задаёт стороны и героев', () => {
  const s = core.createState();
  core.applyManual(s, {
    side: 'dire',
    radiantPicks: ['axe', 'lina'],
    direPicks: ['npc_dota_hero_nevermore'],
    direBans: ['pudge'],
  });
  assert.equal(s.side, 'dire');
  assert.deepEqual(s.radiant.picks, ['axe', 'lina']);
  assert.deepEqual(s.dire.picks, ['nevermore']);
  assert.deepEqual(s.dire.bans, ['pudge']);
  assert.equal(s.connected, false);
});

test('manual убирает дубли и мусор', () => {
  const s = core.createState();
  core.applyManual(s, { side: 'radiant', radiantPicks: ['axe', 'axe', 'nope'] });
  assert.deepEqual(s.radiant.picks, ['axe']);
});

test('manual сохраняет своего героя из GSI', () => {
  const s = core.createState();
  core.applyGsi(s, { player: { team_name: 'dire' }, hero: { name: 'juggernaut' } });
  core.applyManual(s, { side: 'dire', ownHero: 'juggernaut', radiantPicks: ['axe'] });
  assert.deepEqual(s.dire.picks, ['juggernaut']);
});

test('в пиках не больше пяти героев', () => {
  const s = core.createState();
  core.applyManual(s, {
    side: 'radiant',
    radiantPicks: ['axe', 'lina', 'pudge', 'zuus', 'nevermore', 'slark', 'riki'],
  });
  assert.equal(s.radiant.picks.length, 5);
});

test('неизвестная сторона приводится к radiant', () => {
  const s = core.createState();
  core.applyManual(s, { side: 'middle' });
  assert.equal(s.side, 'radiant');
});

console.log('\nРекомендации:');

test('пять позиций, по пять героев, без уже взятых', () => {
  const s = core.createState();
  core.applyManual(s, {
    side: 'radiant',
    radiantPicks: ['axe'],
    direPicks: ['nevermore', 'pudge'],
  });
  const recs = core.computeRecommendations(s);
  for (let p = 1; p <= 5; p++) {
    assert.equal(recs.positions[p].length, 5, 'позиция ' + p);
    for (const hero of recs.positions[p]) {
      assert.ok(!['axe', 'nevermore', 'pudge'].includes(hero.key), 'взят: ' + hero.key);
    }
  }
});

test('рекомендации отсортированы по убыванию очков', () => {
  const s = core.createState();
  core.applyManual(s, { side: 'radiant', direPicks: ['phantom_assassin'] });
  const recs = core.computeRecommendations(s);
  for (let p = 1; p <= 5; p++) {
    const scores = recs.positions[p].map((h) => h.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'позиция ' + p);
  }
});

test('контрпик получает бонус к очку', () => {
  const s = core.createState();
  core.applyManual(s, { side: 'radiant', direPicks: ['phantom_assassin'] });
  const recs = core.computeRecommendations(s);
  const all = [1, 2, 3, 4, 5].flatMap((p) => recs.positions[p]);
  const axe = all.find((h) => h.key === 'axe');
  assert.ok(axe && axe.countersVs.includes('phantom_assassin'));
});

test('угрозы находят врагов, контрящих твоих героев', () => {
  const s = core.createState();
  core.applyManual(s, { side: 'radiant', radiantPicks: ['phantom_assassin'], direPicks: ['axe'] });
  const recs = core.computeRecommendations(s);
  assert.ok(recs.threats.some((t) => t.key === 'axe'));
});

test('состав отмечает свободные позиции', () => {
  const s = core.createState();
  core.applyManual(s, { side: 'radiant', radiantPicks: ['axe'] });
  const recs = core.computeRecommendations(s);
  assert.ok(recs.composition.notes.some((n) => n.includes('позиции')));
});

test('пустой драфт не падает', () => {
  const s = core.createState();
  const recs = core.computeRecommendations(s);
  assert.equal(recs.allies.length, 0);
  assert.equal(recs.positions[1].length, 5);
  assert.ok(recs.composition.notes.length > 0);
});

console.log('\nСнимок состояния:');

test('snapshot содержит всё, что ждёт интерфейс', () => {
  const s = core.createState();
  const snap = core.snapshot(s);
  for (const key of ['connected', 'gameState', 'matchId', 'side', 'ownHero', 'pickPhase', 'activeTeam', 'lastUpdate', 'radiant', 'dire', 'recs']) {
    assert.ok(key in snap, 'нет поля ' + key);
  }
});

console.log(`\nИтого: ${passed} прошло, ${failed} провалилось`);
process.exit(failed ? 1 : 0);
