"use strict";
/**
 * Регрессионные тесты. Запуск: node tests.js
 * Сеть не нужна — база и данные синтетические.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const TMP_DB = path.join(os.tmpdir(), `dota-test-${process.pid}.db`);
process.env.TRACKER_DB = TMP_DB;

const tracker = require("./tracker");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok   " + name);
  } catch (e) {
    failed++;
    console.log("  FAIL " + name);
    console.log("       " + e.message);
  }
}

// ─────────────────────────── Данные ───────────────────────────

const ACCOUNT = 1;
const BASE = Math.floor(new Date(2026, 0, 5, 12, 0, 0).getTime() / 1000);

// 20 матчей: 4 сессии по 5 игр, внутри сессии — каждые 30 минут.
const SEQ = [1, 1, 0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1];
const WINS = SEQ.filter((x) => x === 1).length; // 13

function buildRows() {
  const rows = [];
  for (let s = 0; s < 4; s++) {
    for (let k = 0; k < 5; k++) {
      const i = s * 5 + k;
      rows.push({
        match_id: 1000 + i,
        player_slot: 0,
        radiant_win: SEQ[i] === 1,
        hero_id: (i % 3) + 1,
        kills: 5,
        deaths: 4,
        assists: 7,
        gold_per_min: 500,
        xp_per_min: 600,
        last_hits: 200,
        denies: 10,
        hero_damage: 15000,
        duration: 2400,
        game_mode: 22,
        lobby_type: 7,
        start_time: BASE + s * 86400 + k * 1800,
      });
    }
  }
  return rows;
}

const db = tracker.open();
tracker.storeRows(db, ACCOUNT, buildRows());
const stats = tracker.computeStats(ACCOUNT);

// ─────────────────────── Статистика ───────────────────────

console.log("\nСтатистика:");

test("всего матчей", () => assert.strictEqual(stats.total, 20));
test("побед и поражений", () => {
  assert.strictEqual(stats.wins, WINS);
  assert.strictEqual(stats.losses, 20 - WINS);
});
test("винрейт", () => assert.strictEqual(stats.winrate, 65));
test("последние 20 = все матчи", () => assert.strictEqual(stats.last20, 65));
test("текущая серия побед", () => assert.strictEqual(stats.streak, 3));
test("лучшая серия побед", () => assert.strictEqual(stats.bestWinStreak, 3));

test("сессии разбиты по разрыву во времени", () => {
  assert.strictEqual(stats.sessions.count, 4);
  assert.strictEqual(stats.sessions.firstGames.games, 8);
  assert.strictEqual(stats.sessions.laterGames.games, 12);
});

test("суммы по срезам совпадают с числом матчей", () => {
  const sum = (arr, key) => arr.reduce((s, x) => s + x[key], 0);
  assert.strictEqual(sum(stats.byHour, "games"), 20);
  assert.strictEqual(sum(stats.byWeekday, "games"), 20);
  assert.strictEqual(sum(stats.byHero, "games"), 20);
});

test("винрейт по часам", () => {
  const h12 = stats.byHour.find((h) => h.hour === 12);
  const h13 = stats.byHour.find((h) => h.hour === 13);
  const h14 = stats.byHour.find((h) => h.hour === 14);
  assert.strictEqual(h12.games, 8);
  assert.strictEqual(h13.games, 8);
  assert.strictEqual(h14.games, 4);
});

test("скользящий винрейт", () => {
  assert.strictEqual(stats.rolling.length, 1); // 20 матчей → одна точка
  assert.strictEqual(stats.rolling[0].winrate, 65);
});

test("список последних матчей — от свежих к старым", () => {
  assert.strictEqual(stats.recent.length, 20);
  assert.strictEqual(stats.recent[0].matchId, 1019);
  assert.strictEqual(stats.recent[19].matchId, 1000);
});

test("инсайты возвращаются массивом", () => {
  assert.ok(Array.isArray(tracker.buildInsights(stats)));
});

test("инсайты находят тильт и худшего героя", () => {
  const fake = {
    empty: false,
    total: 200,
    winrate: 50,
    last20: 50,
    streak: 1,
    afterWin: { games: 100, winrate: 52 },
    afterLoss: { games: 100, winrate: 35 },
    sessions: {
      firstGames: { games: 60, winrate: 55 },
      laterGames: { games: 140, winrate: 48 },
    },
    byHour: [
      { hour: 9, games: 30, winrate: 30 },
      { hour: 21, games: 30, winrate: 65 },
    ],
    byWeekday: [
      { day: "Ср", games: 40, winrate: 35 },
      { day: "Сб", games: 40, winrate: 60 },
    ],
    byHero: [
      { heroId: 1, games: 20, winrate: 60 },
      { heroId: 2, games: 12, winrate: 25 },
    ],
  };

  const texts = tracker.buildInsights(fake).map((i) => i.text).join(" | ");
  assert.ok(/тильт/i.test(texts), "должен быть вывод про тильт");
  assert.ok(/Хуже всего идёт/i.test(texts), "должен быть вывод про худшего героя");
  assert.ok(/09:00/.test(texts), "часы должны быть с ведущим нулём");
  assert.ok(/Лучший день недели/i.test(texts), "должен быть вывод про день недели");
});

// ─────────────────────── Запись в базу ───────────────────────

console.log("\nЗапись в базу:");

test("повторная запись не дублирует матчи", () => {
  tracker.storeRows(db, ACCOUNT, buildRows());
  const n = db.prepare("SELECT COUNT(*) AS n FROM matches WHERE account_id = ?").get(ACCOUNT).n;
  assert.strictEqual(n, 20);
});

test("пустые поля не затирают уже сохранённые", () => {
  const first = buildRows()[0];
  const before = db
    .prepare("SELECT gpm, xpm, last_hits FROM matches WHERE account_id = ? AND match_id = ?")
    .get(ACCOUNT, first.match_id);

  tracker.storeRows(db, ACCOUNT, [
    Object.assign({}, first, {
      gold_per_min: null,
      xp_per_min: null,
      last_hits: null,
      denies: null,
      hero_damage: null,
    }),
  ]);

  const after = db
    .prepare("SELECT gpm, xpm, last_hits FROM matches WHERE account_id = ? AND match_id = ?")
    .get(ACCOUNT, first.match_id);

  assert.strictEqual(before.gpm, 500);
  assert.strictEqual(after.gpm, 500);
  assert.strictEqual(after.xpm, 600);
  assert.strictEqual(after.last_hits, 200);
});

test("кэш разбора сбрасывается при смене данных", () => {
  assert.strictEqual(tracker.getReview(ACCOUNT, "20:1000"), null);
  tracker.saveReview(ACCOUNT, "20:1000", "текст разбора");
  assert.strictEqual(tracker.getReview(ACCOUNT, "20:1000"), "текст разбора");
  assert.strictEqual(tracker.getReview(ACCOUNT, "21:2000"), null);
});

test("пустая база не падает", () => {
  const empty = tracker.computeStats(999999);
  assert.strictEqual(empty.empty, true);
  assert.deepStrictEqual(tracker.buildInsights(empty), []);
});

// ─────────────────────── Markdown ───────────────────────

console.log("\nРазметка:");

function loadMarkdown() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "markdown.js"), "utf8"), ctx);
  return ctx;
}

test("заголовки, списки и жирный", () => {
  const { renderMarkdown } = loadMarkdown();
  const html = renderMarkdown("## Итог\n- пункт **важно**\n1. раз\n2. два");
  assert.ok(html.includes("<h4>Итог</h4>"));
  assert.ok(html.includes("<ul><li>пункт <strong>важно</strong></li></ul>"));
  assert.ok(html.includes("<ol><li>раз</li><li>два</li></ol>"));
});

test("HTML из ответа экранируется", () => {
  const { renderMarkdown } = loadMarkdown();
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!html.includes("<script>"), "тег не должен проходить как есть");
  assert.ok(html.includes("&lt;script&gt;"));
});

// ─────────────────────── Анализ матча ───────────────────────

console.log("\nАнализ матча:");

function loadApp() {
  const stub = () => ({
    appendChild() {},
    addEventListener() {},
    style: {},
    classList: { add() {}, remove() {} },
    set textContent(v) {},
    set innerHTML(v) {},
  });

  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    TextDecoder,
    AbortController,
    fetch,
    URLSearchParams,
    location: { protocol: "http:", search: "" },
    document: {
      addEventListener() {},
      getElementById: () => stub(),
      createElement: () => stub(),
      createTextNode: () => ({}),
    },
  };

  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "app.js"), "utf8"), ctx);
  return ctx;
}

function player(slot, heroId, laneRole, extra) {
  return Object.assign(
    {
      player_slot: slot,
      hero_id: heroId,
      lane_role: laneRole,
      kills: 5,
      deaths: 4,
      assists: 8,
      last_hits: 200,
      denies: 10,
      gold_per_min: 500,
      xp_per_min: 600,
      level: 20,
      win: true,
      net_worth: 20000,
      hero_damage: 15000,
      tower_damage: 1000,
      hero_healing: 0,
      obs_placed: 5,
      sen_placed: 3,
      buyback_count: 0,
      leaver_status: 0,
      item_0: 1,
      item_1: 2,
    },
    extra || {}
  );
}

test("находит высокое число смертей", () => {
  const ctx = loadApp();
  const match = {
    match_id: 42,
    duration: 2400,
    game_mode: 22,
    radiant_win: true,
    players: [
      player(0, 1, 1, { deaths: 12, last_hits: 300 }),
      player(1, 2, 2, { deaths: 2 }),
      player(2, 3, 3, { deaths: 11, last_hits: 60 }),
      player(3, 4, 1, { deaths: 3, last_hits: 40 }),
      player(4, 5, 3, { deaths: 5, last_hits: 35 }),
      player(128, 6, 1, { deaths: 2 }),
      player(129, 7, 2, { deaths: 3 }),
      player(130, 8, 3, { deaths: 4 }),
      player(131, 9, 1, { deaths: 5 }),
      player(132, 10, 3, { deaths: 6 }),
    ],
  };

  const report = ctx.analyze(match);
  assert.strictEqual(report.matchId, 42);
  assert.strictEqual(report.radiant.players.length, 5);
  assert.strictEqual(report.dire.players.length, 5);

  const all = report.radiant.players.flatMap((p) => p.findings);
  assert.ok(
    all.some((f) => f.sev === "critical" && /смертей/i.test(f.title)),
    "должна быть находка о большом числе смертей"
  );
});

test("слабый фарм кора отмечается", () => {
  const ctx = loadApp();
  const match = {
    match_id: 43,
    duration: 2400,
    game_mode: 22,
    radiant_win: false,
    players: [
      player(0, 1, 1, { last_hits: 40, gold_per_min: 250 }),
      player(1, 2, 2, {}),
      player(2, 3, 3, {}),
      player(3, 4, 1, {}),
      player(4, 5, 3, {}),
      player(128, 6, 1, {}),
      player(129, 7, 2, {}),
      player(130, 8, 3, {}),
      player(131, 9, 1, {}),
      player(132, 10, 3, {}),
    ],
  };

  const report = ctx.analyze(match);
  const all = report.radiant.players.flatMap((p) => p.findings);
  assert.ok(all.some((f) => /фарм/i.test(f.title)), "должна быть находка о фарме");
});

test("ID матча достаётся из ссылки", () => {
  const ctx = loadApp();
  assert.strictEqual(ctx.parseMatchId("9065929055"), "9065929055");
  assert.strictEqual(ctx.parseMatchId("https://www.opendota.com/matches/9065929055"), "9065929055");
  assert.strictEqual(ctx.parseMatchId("https://www.dotabuff.com/matches/9065929055?utm=x"), "9065929055");
  assert.strictEqual(ctx.parseMatchId("https://stratz.com/matches/9065929055"), "9065929055");
  assert.strictEqual(ctx.parseMatchId("не матч"), null);
});

// ─────────────────────── Профиль трекера ───────────────────────

console.log("\nПрофиль трекера:");

function loadProgress() {
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    TextDecoder,
    AbortController,
    fetch,
    URLSearchParams,
    localStorage: { getItem: () => null, setItem() {} },
    location: { protocol: "http:", search: "", href: "http://localhost/progress.html" },
    history: { replaceState() {} },
    window: { addEventListener() {} },
    document: {
      addEventListener() {},
      getElementById: () => stub(),
      createElement: () => stub(),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "progress.js"), "utf8"), ctx);
  return ctx;
}

test("account_id из числа, ссылки Steam и SteamID64", () => {
  const ctx = loadProgress();
  assert.strictEqual(ctx.parseAccount("779811439"), 779811439);
  assert.strictEqual(ctx.parseAccount("https://steamcommunity.com/profiles/76561198740077167/"), 779811439);
  assert.strictEqual(ctx.parseAccount("76561198740077167"), 779811439);
  assert.strictEqual(ctx.parseAccount("не профиль"), null);
});

// ─────────────────────────── Итог ───────────────────────────

db.close();
try {
  fs.unlinkSync(TMP_DB);
} catch {
  // временный файл мог остаться — не критично
}

console.log(`\nИтого: ${passed} прошло, ${failed} провалилось\n`);
process.exitCode = failed ? 1 : 0;
