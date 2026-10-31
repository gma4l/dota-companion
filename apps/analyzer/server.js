"use strict";
/**
 * Dota 2 Анализатор — локальный сервер.
 *
 * Делает две вещи:
 *   1. Раздаёт статику (index.html, app.js, style.css).
 *   2. Проксирует запросы к локальному Ollama для AI-тренера.
 *      Браузер не может обратиться к Ollama напрямую (другой порт → CORS),
 *      поэтому запрос идёт через этот сервер, а ответ стримится обратно.
 *
 * Запуск:  node server.js
 *
 * Переменные окружения:
 *   PORT            — порт сайта            (по умолчанию 8080)
 *   OLLAMA_URL      — адрес Ollama          (по умолчанию http://127.0.0.1:11437)
 *   COACH_MODEL     — модель                (по умолчанию qwen3:8b)
 *   COACH_KEEP_ALIVE— сколько держать модель в памяти (по умолчанию 5m)
 *   OPEN_BROWSER    — "0", чтобы не открывать браузер автоматически
 */

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8080);
const configuredOllamaUrl = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
// Ollama по умолчанию слушает 11434. Старый порт 11437 оставлен как fallback
// для уже настроенных установок, но больше не является адресом по умолчанию.
const OLLAMA_CANDIDATES = [...new Set([
  configuredOllamaUrl,
  "http://127.0.0.1:11434",
  "http://localhost:11434",
  "http://127.0.0.1:11437",
])];
let OLLAMA_URL = configuredOllamaUrl;
const COACH_MODEL = process.env.COACH_MODEL || "qwen3:8b";
// Короткое удержание снижает расход ОЗУ после завершения разбора.
const KEEP_ALIVE = process.env.COACH_KEEP_ALIVE || "5m";
const MAX_BODY_BYTES = 512 * 1024;
// Около 3.5–4k токенов вместе с системными инструкциями и ответом.
const MAX_PROMPT_CHARS = 14000;
const MODEL_OPTIONS = {
  temperature: Number(process.env.COACH_TEMPERATURE || 0.55),
  // Достаточно для подробного, но не бесконечного ответа.
  num_predict: Number(process.env.COACH_NUM_PREDICT || 1200),
  // Меньший контекст заметно снижает память; исходные данные дополнительно ограничиваются.
  num_ctx: Number(process.env.COACH_NUM_CTX || 4096),
  top_p: 0.9,
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// ─────────────────────────── Логирование ───────────────────────────

const LOG = {
  info: (msg) => console.log(`[${new Date().toISOString()}] INFO: ${msg}`),
  warn: (msg) => console.warn(`[${new Date().toISOString()}] WARN: ${msg}`),
  error: (msg) => console.error(`[${new Date().toISOString()}] ERROR: ${msg}`),
};

// ─────────────────────────── Промпты ───────────────────────────

const SEV_RU = { critical: "критично", major: "важно", minor: "совет" };

const SYSTEM_PLAYER = `Ты — тренер по Dota 2. Работаешь с игроками уровня Legend–Immortal, разбираешь матчи по статистике.

Правила:
- Отвечай только по-русски.
- Опирайся ТОЛЬКО на переданные данные. Чего нет в данных — не выдумывай.
- Учитывай роль: советы керри и пятой позиции разные.
- Не пересказывай цифры — делай из них выводы.
- Будь конкретным и выполнимым: не «играй аккуратнее», а «после 15-й минуты не выходи на линию без видения». Цифры подставляй под роль игрока, а не бери из примеров.
- Пиши живо, грамотным русским языком, без канцелярита, без вступлений вроде «Итак, давайте разберём».
- Не используй таблицы.
- В разделе «Что получалось» перечисляй только то, что действительно сильно по цифрам. Если хвалить нечего — скажи это прямо, не выдумывай достижения.
- Если игрок сыграл сильно (победа, мало смертей, KDA заметно лучше команды) — не выдумывай проблем: скажи, что критических ошибок нет, и перечисли, что закрепить. Но если смертей много, ошибки есть всегда, даже при победе.
- Не давай опасных советов: не советуй ходить в одиночку без видения, жертвовать собой без цели или игнорировать фарм.

Структура ответа (Markdown, 450–650 слов; не сокращай анализ до общих фраз):
## Главное
Кратко объясни, что сильнее всего повлияло на результат и почему это важно именно для этой роли.
## Что получалось
3–4 пункта: привязывай каждый вывод к конкретной цифре или находке из данных.
## Ошибки и причинно-следственная связь
Разбери 2–4 главные проблемы в формате «наблюдение → почему это повредило игре → как исправить».
## Три действия на следующий матч
Нумерованный список из трёх измеримых действий с таймингом или условием выполнения.
## Над чем работать в долгую
2–3 предложения о тренировке навыка и критерии прогресса.

Не повторяй один и тот же совет разными словами. Если данных недостаточно, прямо укажи это.`;

const SYSTEM_MATCH = `Ты — аналитик Dota 2. Разбираешь матч целиком по статистике обеих команд.

Правила:
- Отвечай только по-русски.
- Опирайся ТОЛЬКО на переданные данные. Чего нет — не выдумывай.
- Не пересказывай цифры — объясняй, почему матч сложился именно так.
- Пиши живо и конкретно, без канцелярита и вступлений.
- Не используй таблицы.

Структура ответа (Markdown, 500–750 слов; объясняй причинно-следственные связи):
## Что решило матч
3–4 предложения: сравни темп, драки, фарм и ключевые ошибки по данным.
## Как развивалась игра
Опиши раннюю, среднюю и позднюю стадии только по доступным показателям; не выдумывай события.
## Ключевые ошибки Radiant
2–4 пункта в формате «факт → последствие → исправление».
## Ключевые ошибки Dire
2–4 пункта в формате «факт → последствие → исправление».
## Что делать в похожем матче
3 конкретных командных правила.
## Вывод
Главный урок матча в 2–3 предложениях.

Не повторяй цифры без вывода. Если данных для стадии игры нет, так и напиши.`;

function sevRu(s) {
  return SEV_RU[s] || s;
}

function num(v, suffix = "") {
  if (v === null || v === undefined) return "нет данных";
  return String(v) + suffix;
}

function share(part, total) {
  if (!total) return 0;
  return Math.round((Number(part || 0) / total) * 100);
}

function findingsText(list) {
  if (!Array.isArray(list) || !list.length) return "- явных ошибок не найдено";
  return list.filter(Boolean).map((f) => `- [${sevRu(f.sev)}] ${f.title}${f.detail ? ` — ${f.detail}` : ""}`).join("\n");
}

function rosterText(players) {
  const list = Array.isArray(players) ? players : [];
  if (!list.length) return "- нет данных об игроках";
  return list
    .filter(Boolean)
    .map(
      (p) =>
        `- ${p.heroName} (${p.posLabel}): ${p.kills}/${p.deaths}/${p.assists}, ` +
        `GPM ${p.gpm}, XPM ${p.xpm}, крипы ${p.lastHits}`
    )
    .join("\n");
}

function matchHeader(d) {
  return [
    `Матч #${d.matchId}`,
    `Режим: ${d.modeName || "неизвестен"}`,
    `Длительность: ${d.duration}`,
    `Счёт: Radiant ${d.radiantKills} : ${d.direKills} Dire`,
    `Победитель: ${d.radiantWin ? "Radiant" : "Dire"}`,
  ].join("\n");
}

// Норма крипов в минуту по позициям — чтобы модель не выдумывала ориентиры.
const CS_BENCH = { 1: 6.5, 2: 6.0, 3: 5.0, 4: 1.2, 5: 0.8 };

function posOf(p) {
  if (p.pos) return Number(p.pos);
  const m = String(p.posLabel || "").match(/\((\d)\)/);
  return m ? Number(m[1]) : 0;
}

function buildSignals(p, players, minutes, teamKills, teamDmg) {
  const out = [];
  const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);

  // Смерти: абсолютный порог + сравнение с командой.
  const deaths = p.deaths || 0;
  const deathCap = p.isCore ? 8 : 10;
  const avgDeaths = avg(players.map((x) => x.deaths || 0));
  const dVerdict =
    deaths >= deathCap
      ? `много, это проблема независимо от команды (ориентир до ${deathCap - 1})`
      : deaths > avgDeaths * 1.4
      ? "выше среднего по команде"
      : deaths < avgDeaths * 0.6
      ? "ниже среднего по команде — хорошо"
      : "на уровне остальных";
  out.push(`Смерти: ${deaths} (среднее по команде ${avgDeaths.toFixed(1)}) — ${dVerdict}.`);

  // Крипы: норма по роли + эффективность.
  const bench = CS_BENCH[posOf(p)];
  const csMin = (p.lastHits || 0) / Math.max(1, minutes);
  const csBase = `Крипы: ${p.lastHits || 0} (${csMin.toFixed(1)}/мин)`;
  out.push(
    bench
      ? `${csBase} — ${csMin >= bench ? "на уровне нормы" : `ниже нормы (~${bench}/мин)`} для роли «${p.posLabel}».`
      : `${csBase}.`
  );

  // Участие в убийствах команды.
  const kp = teamKills > 0 ? share((p.kills || 0) + (p.assists || 0), teamKills) : 0;
  if (teamKills > 0) {
    const kpVerdict =
      kp < 20
        ? "низкое, игрок сильно отрылся от команды"
        : kp < 35
        ? "умеренный, beteiligt в умеренной мере"
        : kp < 50
        ? "высокое, был ключевым участником событий"
        : "очень высокое, доминировал в Killing";
    out.push(`Участие в убийствах команды: ${kp}% — ${kpVerdict}.`);
  }

  // Урон по героям: доля от урона команды + эффективность.
  if (p.heroDamage != null && teamDmg > 0) {
    const dmgShare = share(p.heroDamage, teamDmg);
    const dmgPerMin = Math.round((p.heroDamage || 0) / Math.max(1, minutes / 60));
    const dmgVerdict =
      dmgShare < 8
        ? "редко дрался, возможно, играл в поддержку или на безопасной линии"
        : dmgShare < 15
        ? "в пределах нормы"
        : dmgShare < 25
        ? "большой вклад в урон"
        : "главный источник урона команды";
    out.push(
      `Урон по героям: ${dmgShare}% от урона команды — ${dmgVerdict}. Урон в минуту: ${dmgPerMin}.`
    );
  }

  // Урон по строениям (есть в данных).
  if (p.towerDamage != null && teamTowerDmg != null) {
    const tShare = share(p.towerDamage, teamTowerDmg);
    out.push(`Урон по строениям: ${tShare}% от урона команды.`);
  }

  // Обсерверы иватры: оценка в контексте длины матча.
  if (p.obs != null) {
    const needObs = Math.max(3, Math.round(minutes / 7));
    const obsVerdict = p.obs >= needObs ? "достаточно" : "мало, команда играла без вижна";
    out.push(`Обсерверы: ${p.obs} при ориентире ~${needObs} — ${obsVerdict}.`);
  }

  // Байбеки: как эффективно использовались.
  if (p.buybacks != null) {
    const buybackMin = Math.max(1, minutes / 60);
    const buybackEff = (p.kills || 0) / Math.max(1, p.buybacks);
    out.push(
      `Байбеки: ${p.buybacks} (${buybackEff.toFixed(1)} kills per buyback).`
    );
  }

  // GPM/XPM анализ относительно команды.
  if (p.gpm != null && teamAvgGpm != null) {
    const gpmEff = Math.round((p.gpm / teamAvgGpm) * 100);
    out.push(`GPM: ${p.gpm} (${gpmEff}% от средней команды).`);
  }
  if (p.xpm != null && teamAvgXpm != null) {
    const xpmEff = Math.round((p.xpm / teamAvgXpm) * 100);
    out.push(`XPM: ${p.xpm} (${xpmEff}% от средней команды).`);
  }

  return out.join("\n");
}

/** Считает средний GPM/XPM по команде. */
function teamGpmXpm(players) {
  if (!players || !players.length) return { gpm: 0, xpm: 0 };
  const gpm = avg(players.map((p) => p.gpm));
  const xpm = avg(players.map((p) => p.xpm));
  return { gpm: Math.round(gpm), xpm: Math.round(xpm) };
}

function buildPlayerPrompt(d) {
  const side = d.side === "dire" ? "dire" : "radiant";
  const team = d[side] && typeof d[side] === "object" ? d[side] : { players: [], findings: [] };
  const enemySide = side === "radiant" ? "dire" : "radiant";
  const enemy = d[enemySide] && typeof d[enemySide] === "object" ? d[enemySide] : { players: [], findings: [] };
  const players = Array.isArray(team.players) ? team.players : [];
  const p = players[d.playerIndex] || players[0];
  if (!p) return "Нет данных об игроке.";

  const minutes = Math.max(1, Number(d.minutes) || 1);
  const teamKills = players.reduce((s, x) => s + (x.kills || 0), 0);
  const teamDmg = players.reduce((s, x) => s + (x.heroDamage || 0), 0);

  const kp = share((p.kills || 0) + (p.assists || 0), teamKills);
  const dmgShare = share(p.heroDamage, teamDmg);
  const lhPerMin = ((p.lastHits || 0) / minutes).toFixed(1);

  return `# Данные для разбора

## Матч
${matchHeader(d)}

## Игрок, которого разбираем
- Герой: ${p.heroName}
- Сторона: ${side === "radiant" ? "Radiant" : "Dire"} (${p.win ? "победа" : "поражение"})
- Роль: ${p.posLabel}
- KDA: ${p.kills}/${p.deaths}/${p.assists}
- Участие в убийствах команды: ${kp}%
- Уровень: ${num(p.level)}
- Крипы: ${num(p.lastHits)} (${lhPerMin}/мин), денаи: ${num(p.denies)}
- GPM: ${num(p.gpm)}, XPM: ${num(p.xpm)}
- Нетворс: ${num(p.netWorth)}
- Урон по героям: ${num(p.heroDamage)} (${dmgShare}% от урона команды)
- Урон по строениям: ${num(p.towerDamage)}
- Лечение союзников: ${num(p.heroHealing)}
- Обсервер-варды: ${num(p.obs)}, сентри: ${num(p.sen)}
- Байбеки: ${num(p.buybacks)}
- Предметы на конец игры: ${p.items && p.items.length ? p.items.join(", ") : "нет данных"}

## Что нашёл автоматический анализатор
${findingsText(p.findings)}

## Оценки по метрикам (уже посчитаны — используй как есть, не пересчитывай)
${buildSignals(p, players, minutes, teamKills, teamDmg)}

## Находки по команде
${findingsText(team.findings)}

## Состав своей команды (${side === "radiant" ? "Radiant" : "Dire"})
${rosterText(players)}

## Состав противников
${rosterText(enemy.players || [])}

## Задача
Разбери игру этого игрока. Скажи, что именно решило исход, что он делал хорошо и три конкретных действия на следующий матч.`;
}

function buildMatchPrompt(d) {
  const rad = d.radiant && typeof d.radiant === "object" ? d.radiant : { players: [], findings: [] };
  const dire = d.dire && typeof d.dire === "object" ? d.dire : { players: [], findings: [] };

  return `# Данные для разбора

## Матч
${matchHeader(d)}

## Radiant
${rosterText(rad.players || [])}

Находки анализатора по Radiant:
${findingsText(rad.findings)}

## Dire
${rosterText(dire.players || [])}

Находки анализатора по Dire:
${findingsText(dire.findings)}

## Задача
Разбери матч целиком: что решило исход, какие ключевые ошибки были у каждой стороны и какой главный вывод.`;
}

// ─────────────────────── Работа с Ollama ───────────────────────

function limitPrompt(prompt) {
  const text = String(prompt || "");
  if (text.length <= MAX_PROMPT_CHARS) return text;
  // Сохраняем начало (метрики) и конец (задачу), удаляем только избыточный roster.
  const head = Math.floor(MAX_PROMPT_CHARS * 0.72);
  const tail = MAX_PROMPT_CHARS - head;
  return text.slice(0, head) + "\n\n[Часть второстепенных данных сокращена для экономии памяти]\n\n" + text.slice(-tail);
}

async function fetchOllama(pathname, options = {}, signal) {
  let lastError;
  for (const base of OLLAMA_CANDIDATES) {
    try {
      const response = await fetch(`${base}${pathname}`, {
        ...options,
        signal: signal || options.signal || AbortSignal.timeout(8000),
      });
      // Не переключаемся на другой адрес из-за ошибки модели/API: адрес живой.
      OLLAMA_URL = base;
      return response;
    } catch (error) {
      if (error.name === "AbortError") throw error;
      lastError = error;
    }
  }
  throw lastError || new Error("нет доступных адресов Ollama");
}

async function ollamaChat(prompt, system, signal) {
  const payload = {
    model: COACH_MODEL,
    stream: true,
    think: false,
    keep_alive: KEEP_ALIVE,
    messages: [
      { role: "system", content: system },
      { role: "user", content: limitPrompt(prompt) },
    ],
    options: MODEL_OPTIONS,
  };
  return fetchOllama("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, signal);
}

async function readRequestBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      const error = new Error("Слишком большой запрос.");
      error.statusCode = 413;
      throw error;
    }
  }
  return raw;
}

/** Общий стриминг ответа модели в браузер (NDJSON, один JSON на строку). */
async function streamChat(req, res, prompt, system, onComplete) {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });

  const write = (obj) => res.write(JSON.stringify(obj) + "\n");
  const abort = new AbortController();
  req.on("close", () => abort.abort());

  let upstream;
  try {
    upstream = await ollamaChat(prompt, system, abort.signal);
  } catch (e) {
    write({
      error: `Ollama недоступна. Проверены адреса: ${OLLAMA_CANDIDATES.join(", ")}. Запустите «ollama serve» или приложение Ollama. (${e.message})`,
    });
    return res.end();
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    let msg = `Ollama ответила ошибкой ${upstream.status}.`;
    if (/model/i.test(text) && /not found/i.test(text)) {
      msg = `Модель «${COACH_MODEL}» не найдена. Проверьте: ollama list`;
    }
    write({ error: msg, detail: text.slice(0, 400) });
    return res.end();
  }

  const decoder = new TextDecoder();
  let buf = "";
  let full = "";

  try {
    for await (const chunk of upstream.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;

        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }

        if (obj.error) write({ error: String(obj.error) });
        const piece = obj.message && obj.message.content;
        if (piece) {
          full += piece;
          write({ t: piece });
        }
        if (obj.done) write({ done: true });
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") write({ error: "Поток прервался: " + e.message });
  }

  if (onComplete && full.trim()) {
    try {
      onComplete(full);
    } catch {
      // кэш не критичен — не ломаем ответ из-за него
    }
  }

  write({ done: true });
  res.end();
}

async function handleCoach(req, res) {
  let d;
  try {
    d = JSON.parse(await readRequestBody(req));
  } catch (e) {
    if (e.statusCode === 413) return sendJson(res, 413, { error: e.message });
    return sendJson(res, 400, { error: "Некорректный JSON в запросе." });
  }

  const isMatch = d.mode === "match";
  const prompt = isMatch ? buildMatchPrompt(d) : buildPlayerPrompt(d);
  const system = isMatch ? SYSTEM_MATCH : SYSTEM_PLAYER;

  if (process.env.DEBUG_PROMPT === "1") {
    console.log("\n=== PROMPT ===\n" + prompt + "\n=== END PROMPT ===\n");
  }

  return streamChat(req, res, prompt, system);
}

// ─────────────────── Разбор истории целиком ───────────────────

const SYSTEM_HISTORY = `Ты — тренер по Dota 2. Анализируешь историю игрока целиком, а не отдельный матч.

Правила:
- Отвечай только по-русски.
- Опирайся ТОЛЬКО на переданные данные, ничего не выдумывай.
- Ищи закономерности: время суток, длина сессии, тильт после поражений, герои.
- Не пересказывай цифры списком — делай из них выводы.
- Будь конкретным: «не играй больше четырёх матчей подряд», а не «следи за усталостью».
- В разделе «Что мешает» не выдумывай проблем там, где разница слабая: так и напиши, что закономерности нет.
- Пиши грамотным русским языком, без канцелярита и без вступлений.
- Не используй таблицы.

Структура ответа (Markdown, 450–650 слов):
## Главная закономерность
2–3 предложения с самым надёжным выводом и размером разницы.
## Что работает
3 пункта: факт, возможная причина и как это сохранить.
## Что мешает
2–4 пункта; не называй слабую разницу проблемой.
## План на неделю
4 нумерованных шага с измеримым критерием успеха.
## Как проверить прогресс
Одно предложение: какие показатели сравнить после следующей серии матчей.`;

function hoursText(byHour) {
  const rows = (byHour || []).filter((h) => h.games >= 8);
  if (!rows.length) return "нет данных";
  return rows
    .map((h) => `- ${String(h.hour).padStart(2, "0")}:00 — ${h.games} игр, ${h.winrate}%`)
    .join("\n");
}

function weekdayText(byWeekday) {
  const rows = (byWeekday || []).filter((d) => d.games >= 20);
  if (!rows.length) return "нет данных";
  return rows.map((d) => `- ${d.day} — ${d.games} игр, ${d.winrate}%`).join("\n");
}

function heroListText(byHero, limit = 10) {
  const rows = (byHero || []).slice(0, limit);
  if (!rows.length) return "нет данных";
  return rows
    .map((h) => `- ${tracker.heroLabel(h.heroId)}: ${h.games} игр, ${h.winrate}%`)
    .join("\n");
}

function strength(diff) {
  if (diff >= 15) return "сильная закономерность";
  if (diff >= 8) return "заметная разница";
  return "разница слабая, закономерности нет";
}

/** Готовые выводы по цифрам — чтобы модель не путала лучший день с худшим. */
function historySignals(s) {
  const out = [];

  const hours = (s.byHour || []).filter((h) => h.games >= 5).sort((a, b) => b.winrate - a.winrate);
  if (hours.length >= 2) {
    const best = hours[0];
    const worst = hours[hours.length - 1];
    const diff = best.winrate - worst.winrate;
    out.push(
      `Часы: лучший ${String(best.hour).padStart(2, "0")}:00 — ${best.winrate}% (${best.games} игр), ` +
        `худший ${String(worst.hour).padStart(2, "0")}:00 — ${worst.winrate}% (${worst.games} игр). ` +
        `Разница ${diff} п.п. — ${strength(diff)}.`
    );
  }

  const days = (s.byWeekday || []).filter((d) => d.games >= 20).sort((a, b) => b.winrate - a.winrate);
  if (days.length >= 2) {
    const best = days[0];
    const worst = days[days.length - 1];
    const diff = best.winrate - worst.winrate;
    out.push(
      `Дни недели: лучший ${best.day} — ${best.winrate}% (${best.games} игр), ` +
        `худший ${worst.day} — ${worst.winrate}% (${worst.games} игр). Разница ${diff} п.п. — ${strength(diff)}.`
    );
  }

  const tilt = s.afterWin.winrate - s.afterLoss.winrate;
  out.push(
    `Тильт: после победы ${s.afterWin.winrate}%, после поражения ${s.afterLoss.winrate}%. ` +
      `Разница ${Math.abs(tilt)} п.п. — ${strength(Math.abs(tilt))}` +
      `${tilt >= 8 ? " (после поражений играешь хуже)" : ""}.`
  );

  const fatigue = s.sessions.firstGames.winrate - s.sessions.laterGames.winrate;
  out.push(
    `Усталость: первые две игры сессии ${s.sessions.firstGames.winrate}%, ` +
      `дальнейшие ${s.sessions.laterGames.winrate}%. Разница ${Math.abs(fatigue)} п.п. — ${strength(Math.abs(fatigue))}.`
  );

  if (s.total >= 20) {
    const diff = s.last20 - s.winrate;
    out.push(
      `Форма: последние 20 матчей ${s.last20}%, за всё время ${s.winrate}% — ` +
        `${Math.abs(diff)} п.п. ${diff >= 0 ? "выше" : "ниже"} среднего.`
    );
  }

  return out.join("\n");
}

function buildHistoryPrompt(s) {
  const streak =
    s.streak > 0
      ? `${s.streak} побед подряд`
      : s.streak < 0
      ? `${Math.abs(s.streak)} поражений подряд`
      : "нет";

  return `# История игрока

## Общее
- Матчей: ${s.total} (${s.wins} побед, ${s.losses} поражений), винрейт ${s.winrate}%
- Последние 20 матчей: ${s.last20}%
- Последние 50 матчей: ${s.last50}%
- Текущая серия: ${streak}
- Лучшая серия побед: ${s.bestWinStreak}, худшая серия поражений: ${s.bestLossStreak}
- Средний KDA: ${s.avgKda}, GPM: ${s.avgGpm}, XPM: ${s.avgXpm}

## Готовые наблюдения — опирайся в первую очередь на них
${historySignals(s)}

## Справочные данные

Часы (только 8+ игр):
${hoursText(s.byHour)}

Дни недели (только 20+ игр):
${weekdayText(s.byWeekday)}

После победы и после поражения:
- после победы: ${s.afterWin.winrate}% (${s.afterWin.games} матчей)
- после поражения: ${s.afterLoss.winrate}% (${s.afterLoss.games} матчей)

Сессии:
- всего сессий: ${s.sessions.count}, в среднем ${s.sessions.avgLength} матча за подход
- первые две игры сессии: ${s.sessions.firstGames.winrate}% (${s.sessions.firstGames.games} матчей)
- последующие игры: ${s.sessions.laterGames.winrate}% (${s.sessions.laterGames.games} матчей)

Герои по количеству игр:
${heroListText(s.byHero)}

## Задача
Найди главные закономерности в этой истории и дай план улучшения на неделю.
Не пересчитывай цифры и не выдумывай новые — используй готовые наблюдения.`;
}

async function handleHistory(req, res) {
  let body;
  try {
    body = JSON.parse((await readRequestBody(req)) || "{}");
  } catch (e) {
    if (e.statusCode === 413) return sendJson(res, 413, { error: e.message });
    return sendJson(res, 400, { error: "Некорректный JSON." });
  }

  const account = Number(body.account);
  if (!Number.isInteger(account) || account <= 0) {
    return sendJson(res, 400, { error: "Нужен числовой account_id." });
  }

  let stats;
  try {
    await tracker.ensureHeroes();
    stats = tracker.computeStats(account);
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }

  if (stats.empty) {
    return sendJson(res, 400, { error: "Нет данных: сначала загрузите матчи." });
  }

  // Кэш привязан к количеству матчей и дате последнего: новые матчи его сбрасывают.
  const signature = `${stats.total}:${stats.lastMatch}`;

  if (!body.refresh) {
    const cached = tracker.getReview(account, signature);
    if (cached) {
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
      });
      res.write(JSON.stringify({ t: cached }) + "\n");
      res.write(JSON.stringify({ done: true, cached: true }) + "\n");
      return res.end();
    }
  }

  const prompt = buildHistoryPrompt(stats);
  if (process.env.DEBUG_PROMPT === "1") {
    console.log("\n=== HISTORY PROMPT ===\n" + prompt + "\n=== END PROMPT ===\n");
  }

  return streamChat(req, res, prompt, SYSTEM_HISTORY, (text) => {
    tracker.saveReview(account, signature, text);
  });
}

async function handleHealth(req, res) {
  try {
    const r = await fetchOllama("/api/tags", {}, AbortSignal.timeout(4000));
    const data = await r.json();
    const models = (data.models || []).map((m) => m.name);
    sendJson(res, 200, {
      ok: true,
      ollama: OLLAMA_URL,
      candidates: OLLAMA_CANDIDATES,
      model: COACH_MODEL,
      modelReady: models.includes(COACH_MODEL),
      models,
    });
  } catch (e) {
    sendJson(res, 200, {
      ok: false,
      ollama: OLLAMA_URL,
      candidates: OLLAMA_CANDIDATES,
      model: COACH_MODEL,
      error: `Не удалось подключиться к Ollama. Проверены адреса: ${OLLAMA_CANDIDATES.join(", ")}. ${e.message}`,
      hint: "Запустите Ollama командой «ollama serve» или приложение Ollama.",
    });
  }
}

// ────────────────────────── Статика ──────────────────────────

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return sendJson(res, 400, { error: "Неверный формат пути." });
  }
  if (rel === "/") rel = "/index.html";

  const normalized = path.normalize(rel).replace(/^([/\\\\])+/, "");
  const filePath = path.join(ROOT, normalized);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    return sendJson(res, 403, { error: "forbidden" });
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return sendJson(res, 404, { error: "not found" });

    const isHtml = filePath.toLowerCase().endsWith(".html");
    const headers = {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Content-Length": stat.size,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": isHtml ? "no-cache" : "max-age=3600",
    };
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  } catch {
    sendJson(res, 404, { error: "not found" });
  }
}

// ────────────────────────── Трекер ──────────────────────────

const tracker = require("./tracker");

/** Проверяет account_id (положительное целое, не больше 10 миллиардов). */
function isValidAccountId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 10_000_000_000;
}

/** Проверяет ID матча (число не менее 6 цифр). */
function isValidMatchId(v) {
  return /^\d{6,}$/.test(String(v));
}

function accountParam(url) {
  const raw = url.searchParams.get("account") || "";
  if (!/^\d{1,12}$/.test(raw)) return null;
  return Number(raw);
}

async function handleProfile(url, res) {
  const id = accountParam(url);
  if (!id || !isValidAccountId(id)) {
    return sendJson(res, 400, { error: "Нужен числовой account_id." });
  }
  LOG.info(`Профиль: запрос account_id=${id}`);

  try {
    const r = await fetch(`https://api.opendota.com/api/players/${id}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return sendJson(res, r.status, { error: `OpenDota ответила ${r.status}.` });
    const data = await r.json();
    if (!data.profile) return sendJson(res, 404, { error: "Игрок не найден." });
    sendJson(res, 200, { profile: data.profile });
  } catch (e) {
    LOG.error(`Профиль account_id=${id}: ${e.message}`);
    sendJson(res, 502, { error: "Не удалось получить профиль: " + e.message });
  }
}

async function handleStats(url, res) {
  const id = accountParam(url);
  if (!id || !isValidAccountId(id)) {
    return sendJson(res, 400, { error: "Нужен числовой account_id." });
  }
  LOG.info(`Статистика: запрос account_id=${id}`);

  try {
    await tracker.ensureHeroes();
    const stats = tracker.computeStats(id);
    sendJson(res, 200, { accountId: id, stats, insights: tracker.buildInsights(stats) });
  } catch (e) {
    LOG.error(`Статистика account_id=${id}: ${e.message}`);
    sendJson(res, 500, { error: e.message });
  }
}

async function handleSync(req, res) {
  let raw = "";
  for await (const chunk of req) raw += chunk;

  let body;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return sendJson(res, 400, { error: "Некорректный JSON." });
  }

  const id = Number(body.account);
  if (!isValidAccountId(id)) return sendJson(res, 400, { error: "Нужен числовой account_id." });
  LOG.info(`Синхронизация: account_id=${id}, pages=${body.pages}`);

  const pages = Math.min(10, Math.max(1, Number(body.pages) || 1));

  try {
    const result = await tracker.sync(id, pages);
    sendJson(res, 200, result);
  } catch (e) {
    sendJson(res, 502, { error: e.message });
  }
}

// ─────────────────────────── Сервер ───────────────────────────

// ── Кэш матчей OpenDota ──
// Повторный разбор того же матча не тратит лимит запросов: ответ отдаётся из кэша.
// Распарсенные матчи живут 12 часов, нераспарсенные 30 минут — они ещё дозагружаются.
const MATCH_TTL_PARSED = 12 * 60 * 60 * 1000;
const MATCH_TTL_UNPARSED = 30 * 60 * 1000;
const MATCH_CACHE_MAX = 60;
const matchCache = new Map(); // id -> { at, data }

function matchCacheGet(id) {
  const hit = matchCache.get(id);
  if (!hit) return null;
  const parsed = hit.data && Array.isArray(hit.data.players) && hit.data.players.some((p) => p.obs_placed !== undefined || Array.isArray(p.lh_t));
  const ttl = parsed ? MATCH_TTL_PARSED : MATCH_TTL_UNPARSED;
  if (Date.now() - hit.at > ttl) {
    matchCache.delete(id);
    return null;
  }
  return hit.data;
}

function matchCachePut(id, data) {
  if (matchCache.size >= MATCH_CACHE_MAX) {
    const oldest = matchCache.keys().next().value;
    matchCache.delete(oldest);
  }
  matchCache.set(id, { at: Date.now(), data });
}

async function handleMatchProxy(url, res) {
  const id = String(url.pathname.split("/").pop() || "");
  if (!isValidMatchId(id)) return sendJson(res, 400, { error: "Нужен числовой ID матча." });
  LOG.info(`Матч: запрос match_id=${id}`);

  const cached = matchCacheGet(id);
  if (cached) return sendJson(res, 200, cached);

  try {
    const r = await fetch(`${API_OPEN_DOTA}/api/matches/${id}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) {
      if (r.status === 429) return sendJson(res, 429, { error: "Слишком много запросов к OpenDota. Подождите минуту." });
      return sendJson(res, r.status, { error: `OpenDota ответила ${r.status}.` });
    }
    const data = await r.json();
    if (!data || !data.players || !data.players.length) {
      return sendJson(res, 404, { error: "Матч ещё не распарсен или данных нет." });
    }
    matchCachePut(id, data);
    sendJson(res, 200, data);
  } catch (e) {
    sendJson(res, 502, { error: "Не удалось получить матч: " + e.message });
  }
}

const API_OPEN_DOTA = "https://api.opendota.com";

// ── Необязательная защита паролем (для размещения в интернете) ──
// ACCESS_PASSWORD=секрет node server.js  →  все /api требуют заголовок X-Auth.
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || "";

function checkAuth(req) {
  if (!ACCESS_PASSWORD) return true;
  return req.headers["x-auth"] === ACCESS_PASSWORD;
}


// ── Простой rate limiter для тяжёлых /api ──
// Ограничивает частое выставление на OpenDota и нагрузку на локальную модель.
const RATE_LIMIT = { max: 20, perSeconds: 60 };
const rateBuckets = new Map();

function checkRateLimit(key) {
  const now = Date.now();
  if (!rateBuckets.has(key)) rateBuckets.set(key, []);
  const bucket = rateBuckets.get(key);
  const cutoff = now - RATE_LIMIT.perSeconds * 1000;
  while (bucket.length && bucket[0] < cutoff) bucket.shift();
  if (bucket.length >= RATE_LIMIT.max) return false;
  bucket.push(now);
  return true;
}


const PROTECTED_API = new Set(["/api/coach", "/api/coach-history", "/api/health", "/api/profile", "/api/stats", "/api/sync", "/api/match"]);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");

    const isProtected = [...PROTECTED_API].some((p) => url.pathname === p || url.pathname.startsWith(p + "/"));
    if (isProtected && !checkAuth(req)) {
      return sendJson(res, 401, { error: "Требуется пароль.", authRequired: true });
    }

    // Тяжёлые /api ограничиваем rate limiter-ом (локальный, не для публичного сервиса).
    const isHeavyApi = url.pathname === "/api/coach" || url.pathname === "/api/coach-history" || url.pathname === "/api/sync";
    if (isHeavyApi && !checkRateLimit(url.pathname)) {
      return sendJson(res, 429, { error: "Слишком много запросов. Попробуйте позже." });
    }


    if (url.pathname === "/api/coach" && req.method === "POST") return handleCoach(req, res);
    if (url.pathname === "/api/coach-history" && req.method === "POST") return handleHistory(req, res);
    if (url.pathname === "/api/health") return handleHealth(req, res);
    if (url.pathname === "/api/profile") return handleProfile(url, res);
    if (url.pathname === "/api/stats") return handleStats(url, res);
    if (url.pathname === "/api/sync" && req.method === "POST") return handleSync(req, res);
    if (url.pathname.startsWith("/api/match/")) return handleMatchProxy(url, res);
    if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" });

    return serveStatic(req, res);
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`\n  Порт ${PORT} занят. Задайте другой:  set PORT=8081 && node server.js\n`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Dota 2 Анализатор запущен:  ${url}`);
  console.log(`  AI-тренер: ${COACH_MODEL} @ ${OLLAMA_URL}`);
  console.log(`  Остановить: Ctrl+C\n`);

  if (process.env.OPEN_BROWSER !== "0") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  }
});

// ────────────────────────── Graceful shutdown ──────────────────────────

function shutdown(signal) {
  LOG.info(`Получен сигнал ${signal}, завершение работы…`);
  try {
    tracker.close();
  } catch {}
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
