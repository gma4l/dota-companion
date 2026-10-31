"use strict";
/**
 * Трекер прогресса: хранение матчей в SQLite и подсчёт статистики.
 *
 * Данные тянем из OpenDota через SQL-explorer — один запрос на 500 матчей
 * вместо отдельного запроса на каждый матч.
 *
 * База: data/dota.db (создаётся автоматически).
 */

const path = require("node:path");
const fs = require("node:fs");
const { fetchTls12 } = require("../../local/net");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
// Путь к базе можно переопределить — нужно для тестов.
const DB_PATH = process.env.TRACKER_DB || path.join(DATA_DIR, "dota.db");
const OPENDOTA = "https://api.opendota.com";
const PAGE = 500;

let db = null;

function open() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS matches (
      account_id  INTEGER NOT NULL,
      match_id    INTEGER NOT NULL,
      hero_id     INTEGER NOT NULL,
      player_slot INTEGER NOT NULL,
      win         INTEGER NOT NULL,
      kills       INTEGER DEFAULT 0,
      deaths      INTEGER DEFAULT 0,
      assists     INTEGER DEFAULT 0,
      gpm         INTEGER,
      xpm         INTEGER,
      last_hits   INTEGER,
      denies      INTEGER,
      hero_damage INTEGER,
      duration    INTEGER,
      game_mode   INTEGER,
      lobby_type  INTEGER,
      start_time  INTEGER NOT NULL,
      PRIMARY KEY (account_id, match_id)
    );
    CREATE INDEX IF NOT EXISTS idx_matches_account_time
      ON matches (account_id, start_time DESC);

    CREATE TABLE IF NOT EXISTS coach_history (
      account_id INTEGER PRIMARY KEY,
      signature  TEXT NOT NULL,
      text       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

// ─────────────────────────── Синхронизация ───────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** GET с повторами: OpenDota периодически отвечает 429 при частых запросах. */
async function getJson(url, retries = 3) {
  let lastErr = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetchTls12(url, { headers: { Accept: "application/json" } });

      if (res.status === 429) {
        lastErr = new Error("OpenDota: превышен лимит запросов. Подождите минуту и повторите.");
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`OpenDota ответила ${res.status}.`);

      const data = await res.json();
      if (data && data.error) throw new Error("OpenDota: " + data.error);
      return data;
    } catch (e) {
      lastErr = e;
      if (attempt < retries - 1) await sleep(700 * (attempt + 1));
    }
  }

  throw lastErr || new Error("Не удалось получить данные от OpenDota.");
}

/**
 * Список матчей игрока.
 *
 * Раньше здесь использовался SQL-explorer OpenDota, но он отдаёт устаревший
 * срез базы: свежих матчей в нём нет вообще. Поэтому берём обычный REST.
 */
async function fetchMatchList(accountId, offset) {
  const data = await getJson(
    `${OPENDOTA}/api/players/${accountId}/matches?limit=${PAGE}&offset=${offset}`
  );
  return Array.isArray(data) ? data : [];
}

/** Последние 20 матчей — единственный дешёвый источник GPM/XPM/крипов. */
async function fetchRecent(accountId) {
  try {
    const data = await getJson(`${OPENDOTA}/api/players/${accountId}/recentMatches`);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

const UPSERT = `
  INSERT INTO matches (account_id, match_id, hero_id, player_slot, win, kills, deaths,
                       assists, gpm, xpm, last_hits, denies, hero_damage, duration,
                       game_mode, lobby_type, start_time)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (account_id, match_id) DO UPDATE SET
    hero_id = excluded.hero_id,
    player_slot = excluded.player_slot,
    win = excluded.win,
    kills = excluded.kills,
    deaths = excluded.deaths,
    assists = excluded.assists,
    gpm = COALESCE(excluded.gpm, matches.gpm),
    xpm = COALESCE(excluded.xpm, matches.xpm),
    last_hits = COALESCE(excluded.last_hits, matches.last_hits),
    denies = COALESCE(excluded.denies, matches.denies),
    hero_damage = COALESCE(excluded.hero_damage, matches.hero_damage),
    duration = excluded.duration,
    game_mode = excluded.game_mode,
    lobby_type = excluded.lobby_type,
    start_time = excluded.start_time
`;

function countMatches(d, accountId) {
  return d.prepare("SELECT COUNT(*) AS n FROM matches WHERE account_id = ?").get(accountId).n;
}

/** Записывает матчи в базу одной транзакцией. Вынесено отдельно — так тестируется. */
function storeRows(d, accountId, rows) {
  const account = Number(accountId);
  const stmt = d.prepare(UPSERT);

  d.exec("BEGIN");
  try {
    for (const r of rows) {
      const win = (r.player_slot < 128) === r.radiant_win ? 1 : 0;
      stmt.run(
        account,
        r.match_id,
        r.hero_id,
        r.player_slot,
        win,
        r.kills ?? 0,
        r.deaths ?? 0,
        r.assists ?? 0,
        r.gold_per_min ?? null,
        r.xp_per_min ?? null,
        r.last_hits ?? null,
        r.denies ?? null,
        r.hero_damage ?? null,
        r.duration ?? null,
        r.game_mode ?? null,
        r.lobby_type ?? null,
        r.start_time ?? 0
      );
    }
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Тянет матчи и складывает в базу.
 * pages — сколько страниц по 500 матчей запросить.
 */
async function sync(accountId, pages = 1) {
  const d = open();
  const account = Number(accountId);

  const merged = new Map();

  for (let p = 0; p < pages; p++) {
    const chunk = await fetchMatchList(account, p * PAGE);
    if (!chunk.length) break;
    for (const m of chunk) merged.set(m.match_id, m);
    if (chunk.length < PAGE) break;
  }

  // Дополняем свежие матчи полями, которых нет в общем списке.
  const recent = await fetchRecent(account);
  for (const m of recent) {
    merged.set(m.match_id, Object.assign({}, merged.get(m.match_id) || {}, m));
  }

  if (!merged.size) {
    return { fetched: 0, stored: countMatches(d, account), reason: "no_matches" };
  }

  storeRows(d, account, merged.values());

  return { fetched: merged.size, stored: countMatches(d, account), reason: null };
}

function loadMatches(accountId, limit = 2000) {
  const d = open();
  return d
    .prepare(
      `SELECT * FROM matches WHERE account_id = ? ORDER BY start_time ASC LIMIT ?`
    )
    .all(Number(accountId), limit);
}

// ─────────────────────────── Статистика ───────────────────────────

const GAME_MODES = {
  0: "Unknown", 1: "All Pick", 2: "Captain's Mode", 3: "Random Draft", 4: "Single Draft",
  5: "All Random", 11: "Mid Only", 12: "Least Played", 16: "Captain's Draft",
  18: "Ability Draft", 22: "All Pick", 23: "Turbo",
};

const LOBBY = {
  0: "Публичные", 1: "Публичные", 2: "Публичные", 5: "Командные", 6: "Командные",
  7: "Рейтинг", 8: "Рейтинг", 9: "Турнир",
};

function winrate(wins, games) {
  return games ? Math.round((wins / games) * 1000) / 10 : 0;
}

// Имена героев нужны для текстовых выводов — подтягиваем один раз.
let HEROES = null;

async function ensureHeroes() {
  if (HEROES) return HEROES;
  try {
    const r = await fetchTls12(`${OPENDOTA}/api/constants/heroes`, { signal: AbortSignal.timeout(10000) });
    if (r.ok) HEROES = await r.json();
  } catch {
    // без имён выводы будут с номерами героев
  }
  return HEROES || {};
}

function heroLabel(id) {
  const h = HEROES && HEROES[id];
  return h ? h.localized_name || h.name : `герой #${id}`;
}

function pct(wins, games) {
  return games ? Math.round((wins / games) * 100) : 0;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Сессии: матчи с перерывом больше GAP считаем разными сессиями. */
function buildSessions(matches, gapMin = 90) {
  const sessions = [];
  let cur = [];
  for (const m of matches) {
    if (!cur.length || (m.start_time - cur[cur.length - 1].start_time) / 60 <= gapMin) {
      cur.push(m);
    } else {
      sessions.push(cur);
      cur = [m];
    }
  }
  if (cur.length) sessions.push(cur);
  return sessions;
}

function groupBy(matches, keyFn) {
  const map = new Map();
  for (const m of matches) {
    const k = keyFn(m);
    if (k === null || k === undefined) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(m);
  }
  return map;
}

function avg(arr) {
  const vals = arr.filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
  return vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : 0;
}

function computeStats(accountId) {
  const matches = loadMatches(accountId);
  if (!matches.length) {
    return { empty: true, total: 0 };
  }

  const total = matches.length;
  const wins = matches.filter((m) => m.win).length;

  // Последние отрезки
  const last = (n) => matches.slice(-n);
  const wrOf = (arr) => pct(arr.filter((m) => m.win).length, arr.length);

  // Серии
  let curStreak = 0;
  for (let i = matches.length - 1; i >= 0; i--) {
    const w = matches[i].win;
    if (i === matches.length - 1) curStreak = w ? 1 : -1;
    else if ((w && curStreak > 0) || (!w && curStreak < 0)) curStreak += w ? 1 : -1;
    else break;
  }

  let bestWin = 0;
  let bestLoss = 0;
  let runW = 0;
  let runL = 0;
  for (const m of matches) {
    if (m.win) {
      runW++;
      runL = 0;
    } else {
      runL++;
      runW = 0;
    }
    bestWin = Math.max(bestWin, runW);
    bestLoss = Math.max(bestLoss, runL);
  }

  // После победы / после поражения
  let afterWinGames = 0;
  let afterWinWins = 0;
  let afterLossGames = 0;
  let afterLossWins = 0;
  for (let i = 1; i < matches.length; i++) {
    if (matches[i - 1].win) {
      afterWinGames++;
      if (matches[i].win) afterWinWins++;
    } else {
      afterLossGames++;
      if (matches[i].win) afterLossWins++;
    }
  }

  // По часам и дням
  const byHour = [];
  for (let h = 0; h < 24; h++) {
    const list = matches.filter((m) => new Date(m.start_time * 1000).getHours() === h);
    byHour.push({ hour: h, games: list.length, winrate: wrOf(list) });
  }

  const WEEK = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
  const byWeekday = WEEK.map((name, i) => {
    const list = matches.filter((m) => new Date(m.start_time * 1000).getDay() === i);
    return { day: name, games: list.length, winrate: wrOf(list) };
  });

  // По героям
  const byHero = [...groupBy(matches, (m) => m.hero_id)]
    .map(([heroId, list]) => ({
      heroId: Number(heroId),
      games: list.length,
      wins: list.filter((m) => m.win).length,
      winrate: wrOf(list),
      gpm: Math.round(avg(list.map((m) => m.gpm))),
      kda: Math.round(((avg(list.map((m) => m.kills)) + avg(list.map((m) => m.assists))) /
        Math.max(1, avg(list.map((m) => m.deaths)))) * 10) / 10,
    }))
    .sort((a, b) => b.games - a.games);

  // Сессии: усталость
  const sessions = buildSessions(matches);
  const firstGames = [];
  const laterGames = [];
  for (const s of sessions) {
    s.forEach((m, i) => (i < 2 ? firstGames : laterGames).push(m));
  }

  // Скользящий винрейт по 20 матчам
  const rolling = [];
  const W = 20;
  for (let i = W; i <= matches.length; i++) {
    const slice = matches.slice(i - W, i);
    rolling.push({
      t: matches[i - 1].start_time,
      winrate: wrOf(slice),
    });
  }

  // Средние
  const avgGpm = Math.round(avg(matches.map((m) => m.gpm)));
  const avgXpm = Math.round(avg(matches.map((m) => m.xpm)));
  const avgKda = Math.round(
    ((avg(matches.map((m) => m.kills)) + avg(matches.map((m) => m.assists))) /
      Math.max(1, avg(matches.map((m) => m.deaths)))) * 10
  ) / 10;
  const avgDuration = Math.round(avg(matches.map((m) => m.duration)));

  // Последние матчи — для таблицы на странице
  const recent = matches
    .slice(-20)
    .reverse()
    .map((m) => ({
      matchId: m.match_id,
      heroId: m.hero_id,
      win: !!m.win,
      kills: m.kills,
      deaths: m.deaths,
      assists: m.assists,
      gpm: m.gpm,
      xpm: m.xpm,
      duration: m.duration,
      mode: m.game_mode,
      lobby: m.lobby_type,
      startTime: m.start_time,
    }));

  return {
    empty: false,
    total,
    wins,
    losses: total - wins,
    winrate: winrate(wins, total),
    last20: wrOf(last(20)),
    last50: wrOf(last(50)),
    streak: curStreak,
    bestWinStreak: bestWin,
    bestLossStreak: bestLoss,
    afterWin: { games: afterWinGames, winrate: pct(afterWinWins, afterWinGames) },
    afterLoss: { games: afterLossGames, winrate: pct(afterLossWins, afterLossGames) },
    byHour,
    byWeekday,
    byHero,
    sessions: {
      count: sessions.length,
      firstGames: { games: firstGames.length, winrate: pct(firstGames.filter((m) => m.win).length, firstGames.length) },
      laterGames: { games: laterGames.length, winrate: pct(laterGames.filter((m) => m.win).length, laterGames.length) },
      avgLength: Math.round((total / Math.max(1, sessions.length)) * 10) / 10,
    },
    rolling,
    avgGpm,
    avgXpm,
    avgKda,
    avgDuration,
    recent,
    firstMatch: matches[0].start_time,
    lastMatch: matches[matches.length - 1].start_time,
  };
}

/** Короткие выводы по-русски на основе посчитанных цифр. */
function buildInsights(s) {
  const out = [];
  if (s.empty) return out;

  if (s.last20 && s.total >= 20) {
    const diff = s.last20 - s.winrate;
    if (diff >= 8) out.push({ tone: "good", text: `Форма растёт: за последние 20 матчей винрейт ${s.last20}%, а за всё время ${s.winrate}%.` });
    else if (diff <= -8) out.push({ tone: "bad", text: `Форма просела: за последние 20 матчей ${s.last20}% против ${s.winrate}% в среднем.` });
  }

  const hours = s.byHour.filter((h) => h.games >= 5).sort((a, b) => b.winrate - a.winrate);
  if (hours.length >= 2) {
    const best = hours[0];
    const worst = hours[hours.length - 1];
    if (best.winrate - worst.winrate >= 20) {
      out.push({
        tone: "info",
        text: `Лучшее время — ${pad2(best.hour)}:00 (${best.winrate}% за ${best.games} игр), худшее — ${pad2(worst.hour)}:00 (${worst.winrate}%).`,
      });
    }
  }

  const days = s.byWeekday.filter((d) => d.games >= 20).sort((a, b) => b.winrate - a.winrate);
  if (days.length >= 2) {
    const best = days[0];
    const worst = days[days.length - 1];
    if (best.winrate - worst.winrate >= 12) {
      out.push({
        tone: "info",
        text: `Лучший день недели — ${best.day} (${best.winrate}% за ${best.games} игр), худший — ${worst.day} (${worst.winrate}%).`,
      });
    }
  }

  if (s.afterLoss.games >= 10 && s.afterLoss.winrate <= s.winrate - 10) {
    out.push({
      tone: "bad",
      text: `После поражения винрейт падает до ${s.afterLoss.winrate}% (обычно ${s.winrate}%) — похоже на тильт. Пауза после проигрыша реально помогает.`,
    });
  } else if (s.afterLoss.games >= 10 && s.afterLoss.winrate >= s.winrate + 8) {
    out.push({
      tone: "good",
      text: `После поражения винрейт выше обычного — ${s.afterLoss.winrate}% против ${s.winrate}%. Проигрыш тебя не ломает.`,
    });
  }

  if (s.sessions.laterGames.games >= 10 && s.sessions.firstGames.winrate - s.sessions.laterGames.winrate >= 10) {
    out.push({
      tone: "bad",
      text: `Первые игры сессии дают ${s.sessions.firstGames.winrate}%, а дальше — ${s.sessions.laterGames.winrate}%. Играть по 6+ матчей подряд невыгодно.`,
    });
  }

  const heroes = s.byHero.filter((h) => h.games >= 5).sort((a, b) => b.winrate - a.winrate);
  if (heroes.length) {
    const top = heroes[0];
    if (top.winrate >= 55) {
      out.push({
        tone: "good",
        text: `Сильнейший герой — ${heroLabel(top.heroId)}: ${top.winrate}% за ${top.games} игр.`,
      });
    }

    const worst = heroes[heroes.length - 1];
    if (worst.heroId !== top.heroId && worst.games >= 8 && worst.winrate <= 40) {
      out.push({
        tone: "bad",
        text: `Хуже всего идёт ${heroLabel(worst.heroId)}: ${worst.winrate}% за ${worst.games} игр. Либо потренируй его, либо убери из пула.`,
      });
    }
  }

  if (s.streak <= -4) out.push({ tone: "bad", text: `Сейчас серия из ${Math.abs(s.streak)} поражений подряд.` });
  else if (s.streak >= 4) out.push({ tone: "good", text: `Сейчас серия из ${s.streak} побед подряд.` });

  return out;
}

// ───────────────────────── Кэш AI-разбора ─────────────────────────

/** Возвращает сохранённый разбор, если данные с тех пор не менялись. */
function getReview(accountId, signature) {
  const d = open();
  const row = d
    .prepare("SELECT signature, text FROM coach_history WHERE account_id = ?")
    .get(Number(accountId));
  return row && row.signature === signature ? row.text : null;
}

function saveReview(accountId, signature, text) {
  const d = open();
  d.prepare(
    `INSERT INTO coach_history (account_id, signature, text, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (account_id) DO UPDATE SET
       signature = excluded.signature,
       text = excluded.text,
       created_at = excluded.created_at`
  ).run(Number(accountId), signature, text, Math.floor(Date.now() / 1000));
}

/** Закрывает соединение с базой (вызывается при остановке сервера). */
function close() {
  if (db) {
    try { db.close(); } catch {}
    db = null;
  }
}

module.exports = {
  open,
  close,
  sync,
  storeRows,
  computeStats,
  buildInsights,
  ensureHeroes,
  heroLabel,
  getReview,
  saveReview,
  DB_PATH,
};
