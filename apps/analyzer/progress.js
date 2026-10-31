"use strict";

// ─────────────────────────── Состояние ───────────────────────────

const state = {
  account: null,
  stats: null,
  heroes: {},
  profileCache: null,
};

let STORAGE_KEY = "dota.tracker.account";
let syncing = false;

// ─────────────────────────── Утилиты ───────────────────────────

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function setStatus(msg, isError = false) {
  const s = document.getElementById("status");
  if (!msg) {
    s.hidden = true;
    return;
  }
  s.hidden = false;
  s.textContent = msg;
  s.className = "status " + (isError ? "error" : "info");
}

function fmtDate(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function fmtDuration(sec) {
  if (!sec) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function heroName(id) {
  const h = state.heroes[id];
  return h ? h.localized_name || h.name : `Герой ${id}`;
}

function heroKey(id) {
  const h = state.heroes[id];
  if (!h || !h.name) return "";
  return h.name.replace(/^npc_dota_hero_/, "");
}

/** Steam ID (17 цифр), ссылка на профиль или готовый account_id. */
function parseAccount(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;

  const STEAM_BASE = 76561197960265728n;

  const fromSteam64 = (v) => {
    try {
      const n = BigInt(v) - STEAM_BASE;
      return n > 0n ? Number(n) : null;
    } catch {
      return null;
    }
  };

  if (/^\d{17}$/.test(s)) return fromSteam64(s);

  const link = s.match(/profiles\/(\d{17})/);
  if (link) return fromSteam64(link[1]);

  if (/^\d{1,10}$/.test(s)) return Number(s);

  return null;
}

// ─────────────────────────── Загрузка данных ───────────────────────────

async function loadConstants() {
  try {
    const r = await fetch("https://api.opendota.com/api/constants/heroes");
    if (r.ok) state.heroes = await r.json();
  } catch {
    // не критично — будут номера героев
  }
}

async function loadProfile() {
  try {
    const r = await fetch(`/api/profile?account=${state.account}`);
    const j = await r.json();
    if (j.profile) {
      state.profileCache = j.profile;
      renderProfile(j.profile);
    }
  } catch {
    // профиль необязателен
  }
}

async function refresh() {
  setStatus("Считаем статистику…");
  try {
    const r = await fetch(`/api/stats?account=${state.account}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error);

    state.stats = j.stats;
    if (j.stats.empty) {
      setStatus("В базе пока нет матчей для этого профиля. Нажмите «Загрузить».", true);
      return;
    }

    // Панель должна быть видимой: иначе canvas имеет нулевую ширину.
    document.getElementById("dash").hidden = false;
    renderDashboard(j.stats, j.insights || []);
    setStatus("");
  } catch (e) {
    state.stats = null;
    setStatus(e.message, true);
  }
}

function showNoMatchesHelp(account) {
  const s = document.getElementById("status");
  s.hidden = false;
  s.className = "status error";
  s.innerHTML =
    "OpenDota не видит ни одного матча этого профиля. Обычно причина одна — " +
    "в Dota 2 выключены общедоступные данные о матчах.<br><br>" +
    "Включите: <b>Настройки → Социальные → «Общедоступные данные о матчах»</b>, " +
    "сыграйте матч и нажмите «Загрузить» ещё раз.<br><br>" +
    `<a href="https://www.opendota.com/players/${account}" target="_blank" rel="noopener">Проверить профиль на OpenDota</a>`;
}

async function syncNow() {
  const input = document.getElementById("account");
  const btn = document.getElementById("sync-btn");
  const account = parseAccount(input.value);

  if (!account) {
    setStatus("Не понял профиль. Нужна ссылка на Steam или число account_id.", true);
    return;
  }

  if (syncing) {
    setStatus("Загрузка уже идёт…", true);
    return;
  }

  state.account = account;
  localStorage.setItem(STORAGE_KEY, String(account));

  // Чтобы страницу можно было добавить в закладки с нужным профилем
  try {
    const url = new URL(location.href);
    url.searchParams.set("account", String(account));
    history.replaceState(null, "", url);
  } catch {
    // не критично
  }

  const pages = Number(document.getElementById("depth").value) || 1;
  btn.disabled = true;
  setStatus(`Загружаем матчи с OpenDota (${pages * 500} максимум)…`);
  syncing = true;

  try {
    const r = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account, pages }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);

    if (j.reason === "no_matches") {
      showNoMatchesHelp(account);
      return;
    }

    setStatus(`Готово: в базе ${j.stored} матчей.`);
    await loadProfile();
    await refresh();

    // История могла измениться — старый разбор больше не актуален
    document.getElementById("hist-out").hidden = true;
    document.getElementById("hist-refresh").hidden = true;
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    btn.disabled = false;
    syncing = false;
  }
}

// ─────────────────────────── Рендер ───────────────────────────

function renderProfile(p) {
  const box = document.getElementById("profile-card");
  box.innerHTML = "";

  const img = el("img");
  img.src = p.avatarfull || p.avatarmedium || "";
  img.alt = "";
  box.appendChild(img);

  const info = el("div");
  info.appendChild(el("div", "profile-name", p.personaname || "Игрок"));
  info.appendChild(
    el("div", "profile-sub", `account_id ${p.account_id}` + (p.loccountrycode ? ` · ${p.loccountrycode}` : ""))
  );
  box.appendChild(info);

  const stats = state.stats;
  if (stats && !stats.empty) {
    const period = el("div", "profile-period");
    period.textContent = `${fmtDate(stats.firstMatch)} — ${fmtDate(stats.lastMatch)}`;
    box.appendChild(period);
  }
}

function renderSummary(s) {
  const wrap = document.getElementById("summary");
  wrap.innerHTML = "";

  const cards = [
    { k: "Матчей", v: `${s.total}`, sub: `${s.wins} побед · ${s.losses} поражений` },
    { k: "Винрейт", v: `${s.winrate}%`, cls: s.winrate >= 50 ? "radiant" : "dire" },
    { k: "Последние 20", v: `${s.last20}%`, cls: s.last20 >= 50 ? "radiant" : "dire" },
    { k: "Средний KDA", v: `${s.avgKda}` },
    { k: "Средний GPM", v: `${s.avgGpm}` },
    { k: "Средний XPM", v: `${s.avgXpm}` },
    {
      k: "Длительность",
      v: fmtDuration(s.avgDuration),
      sub: "средняя за матч",
    },
    {
      k: "Серия",
      v: s.streak >= 0 ? `+${s.streak}` : `${s.streak}`,
      cls: s.streak >= 0 ? "radiant" : "dire",
      sub: `лучшая: +${s.bestWinStreak} / ${s.bestLossStreak}`,
    },
  ];

  for (const c of cards) {
    const card = el("div", "summary-card");
    card.appendChild(el("div", "k", c.k));
    card.appendChild(el("div", "v" + (c.cls ? " " + c.cls : ""), c.v));
    if (c.sub) card.appendChild(el("div", "sub", c.sub));
    wrap.appendChild(card);
  }
}

function renderInsights(list) {
  const wrap = document.getElementById("insights");
  wrap.innerHTML = "";
  if (!list.length) return;

  for (const item of list) {
    const div = el("div", `insight ${item.tone}`);
    div.textContent = item.text;
    wrap.appendChild(div);
  }
}

function renderRecent(list) {
  const wrap = document.getElementById("recent");
  wrap.innerHTML = "";

  if (!list || !list.length) {
    wrap.appendChild(el("div", "empty-note", "Матчей пока нет."));
    return;
  }

  for (const m of list) {
    const row = el("div", "recent-row " + (m.win ? "win" : "loss"));
    row.title = "Открыть матч в анализаторе";
    row.addEventListener("click", () => {
      location.href = `index.html?match=${m.matchId}`;
    });

    const key = heroKey(m.heroId);
    if (key) {
      const img = el("img");
      img.src = `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/${key}.png`;
      img.alt = "";
      img.onerror = () => {
        img.style.visibility = "hidden";
      };
      row.appendChild(img);
    }

    const nameWrap = el("div", "recent-hero");
    nameWrap.appendChild(el("div", "recent-name", heroName(m.heroId)));
    nameWrap.appendChild(el("div", "recent-date", fmtDate(m.startTime)));
    row.appendChild(nameWrap);

    row.appendChild(el("div", "recent-result " + (m.win ? "win" : "loss"), m.win ? "Победа" : "Поражение"));
    row.appendChild(el("div", "recent-kda", `${m.kills}/${m.deaths}/${m.assists}`));
    row.appendChild(el("div", "recent-gpm", m.gpm ? `${m.gpm} GPM` : "—"));
    row.appendChild(el("div", "recent-dur", fmtDuration(m.duration)));

    wrap.appendChild(row);
  }
}

function renderHeroes(heroes) {
  const wrap = document.getElementById("heroes");
  wrap.innerHTML = "";

  const list = heroes.filter((h) => h.games >= 3).slice(0, 12);
  if (!list.length) {
    wrap.appendChild(el("div", "empty-note", "Пока мало данных по героям."));
    return;
  }

  for (const h of list) {
    const row = el("div", "hero-row");

    const key = heroKey(h.heroId);
    if (key) {
      const img = el("img");
      img.src = `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/${key}.png`;
      img.alt = "";
      img.onerror = () => {
        img.style.visibility = "hidden";
      };
      row.appendChild(img);
    }

    row.appendChild(el("div", "hero-name", heroName(h.heroId)));
    row.appendChild(el("div", "hero-games", `${h.games} игр`));

    const barWrap = el("div", "hero-bar-wrap");
    const bar = el("div", "hero-bar " + (h.winrate >= 50 ? "good" : "bad"));
    bar.style.width = `${h.winrate}%`;
    barWrap.appendChild(bar);
    row.appendChild(barWrap);

    row.appendChild(el("div", "hero-wr " + (h.winrate >= 50 ? "good" : "bad"), `${h.winrate}%`));

    wrap.appendChild(row);
  }
}

// ─────────────────────────── Графики ───────────────────────────

const COL = {
  accent: "#4f8cff",
  good: "#3ddc84",
  bad: "#ff6b6b",
  muted: "#8b95a5",
  grid: "#2a3240",
  text: "#e6eaf0",
};

function fitCanvas(canvas, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(240, canvas.clientWidth || 800);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  canvas.style.height = cssHeight + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h: cssHeight };
}

function drawRolling(canvas, rolling) {
  const { ctx, w, h } = fitCanvas(canvas, 190);
  ctx.clearRect(0, 0, w, h);

  const padL = 34;
  const padR = 10;
  const padT = 12;
  const padB = 22;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  if (!rolling.length) {
    ctx.fillStyle = COL.muted;
    ctx.font = "13px Segoe UI, sans-serif";
    ctx.fillText("Нужно минимум 20 матчей", padL, h / 2);
    return;
  }

  let lo = Math.min(...rolling.map((p) => p.winrate));
  let hi = Math.max(...rolling.map((p) => p.winrate));
  lo = Math.min(lo, 45) - 5;
  hi = Math.max(hi, 55) + 5;
  lo = Math.max(0, lo);
  hi = Math.min(100, hi);

  const x = (i) => padL + (rolling.length === 1 ? plotW / 2 : (i / (rolling.length - 1)) * plotW);
  const y = (v) => padT + plotH - ((v - lo) / (hi - lo || 1)) * plotH;

  // сетка
  ctx.strokeStyle = COL.grid;
  ctx.lineWidth = 1;
  ctx.fillStyle = COL.muted;
  ctx.font = "11px Segoe UI, sans-serif";
  ctx.textAlign = "right";

  for (const v of [lo, (lo + hi) / 2, hi]) {
    const yy = y(v);
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(w - padR, yy);
    ctx.stroke();
    ctx.fillText(`${Math.round(v)}%`, padL - 6, yy + 4);
  }

  // линия 50%
  if (lo < 50 && hi > 50) {
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "#3d4657";
    ctx.beginPath();
    ctx.moveTo(padL, y(50));
    ctx.lineTo(w - padR, y(50));
    ctx.stroke();
    ctx.restore();
  }

  // заливка
  const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
  grad.addColorStop(0, "rgba(79,140,255,0.28)");
  grad.addColorStop(1, "rgba(79,140,255,0.02)");
  ctx.beginPath();
  ctx.moveTo(x(0), padT + plotH);
  rolling.forEach((p, i) => ctx.lineTo(x(i), y(p.winrate)));
  ctx.lineTo(x(rolling.length - 1), padT + plotH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // линия
  ctx.beginPath();
  rolling.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.winrate)) : ctx.moveTo(x(i), y(p.winrate))));
  ctx.strokeStyle = COL.accent;
  ctx.lineWidth = 2;
  ctx.stroke();

  // последняя точка
  const lastP = rolling[rolling.length - 1];
  ctx.beginPath();
  ctx.arc(x(rolling.length - 1), y(lastP.winrate), 3.5, 0, Math.PI * 2);
  ctx.fillStyle = lastP.winrate >= 50 ? COL.good : COL.bad;
  ctx.fill();

  // подписи дат
  ctx.fillStyle = COL.muted;
  ctx.font = "11px Segoe UI, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(fmtDate(rolling[0].t), padL, h - 6);
  ctx.textAlign = "right";
  ctx.fillText(fmtDate(lastP.t), w - padR, h - 6);
}

function drawHours(canvas, byHour) {
  const { ctx, w, h } = fitCanvas(canvas, 190);
  ctx.clearRect(0, 0, w, h);

  const padL = 34;
  const padR = 10;
  const padT = 12;
  const padB = 24;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const slot = plotW / 24;
  const barW = Math.max(4, slot - 4);

  ctx.strokeStyle = COL.grid;
  ctx.fillStyle = COL.muted;
  ctx.font = "11px Segoe UI, sans-serif";
  ctx.textAlign = "right";

  for (const v of [0, 50, 100]) {
    const yy = padT + plotH - (v / 100) * plotH;
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(w - padR, yy);
    ctx.stroke();
    ctx.fillText(`${v}%`, padL - 6, yy + 4);
  }

  byHour.forEach((cell, i) => {
    const bh = (cell.winrate / 100) * plotH;
    const bx = padL + i * slot + (slot - barW) / 2;
    const by = padT + plotH - bh;

    ctx.fillStyle =
      cell.games < 3 ? "#3a4354" : cell.winrate >= 50 ? COL.good : COL.bad;
    ctx.fillRect(bx, by, barW, Math.max(2, bh));

    if (i % 3 === 0) {
      ctx.fillStyle = COL.muted;
      ctx.textAlign = "center";
      ctx.fillText(String(cell.hour), padL + i * slot + slot / 2, h - 6);
    }
  });
}

function renderCharts(s) {
  drawRolling(document.getElementById("chart-rolling"), s.rolling);
  drawHours(document.getElementById("chart-hour"), s.byHour);
}

function renderDashboard(s, insights) {
  renderSummary(s);
  renderInsights(insights);
  renderRecent(s.recent);
  renderCharts(s);
  renderHeroes(s.byHero);

  if (state.profileCache) renderProfile(state.profileCache);
}

// ─────────────────────────── Старт ───────────────────────────

// ─────────────────────── AI-разбор истории ───────────────────────

let histAbort = null;

async function runHistory(refresh = false) {
  const runBtn = document.getElementById("hist-run");
  const reBtn = document.getElementById("hist-refresh");
  const out = document.getElementById("hist-out");
  const note = document.getElementById("hist-note");

  if (!state.account) return;

  note.hidden = true;
  out.hidden = false;
  out.innerHTML = '<div class="coach-meta">Модель думает… первый разбор может занять до минуты.</div>';
  runBtn.disabled = true;
  reBtn.disabled = true;

  let text = "";
  let lastPaint = 0;
  const started = Date.now();
  const paint = () => {
    out.innerHTML = renderMarkdown(text) + '<span class="coach-cursor"></span>';
  };

  histAbort = new AbortController();

  try {
    const res = await fetch("/api/coach-history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: state.account, refresh }),
      signal: histAbort.signal,
    });

    if (!res.ok || !res.body) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `Сервер ответил ошибкой ${res.status}.`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let cached = false;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;

        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }

        if (msg.error) throw new Error(msg.error);
        if (msg.t) {
          text += msg.t;
          const now = Date.now();
          if (now - lastPaint > 70) {
            lastPaint = now;
            paint();
          }
        }
        if (msg.cached) cached = true;
      }
    }

    paint();
    const secs = Math.round((Date.now() - started) / 1000);
    out.appendChild(el("div", "coach-meta", cached ? "Из кэша · данные не менялись" : `Готово за ${secs} с`));
    reBtn.hidden = false;
  } catch (e) {
    if (e.name === "AbortError") {
      out.innerHTML = renderMarkdown(text) + '<div class="coach-meta">Остановлено.</div>';
    } else if (text) {
      out.innerHTML = renderMarkdown(text);
      note.hidden = false;
      note.textContent = e.message;
    } else {
      out.hidden = true;
      note.hidden = false;
      note.textContent = e.message;
    }
  } finally {
    runBtn.disabled = false;
    reBtn.disabled = false;
    histAbort = null;
  }
}

async function init() {
  // Тема: общая с анализатором, выбор сохраняется.
  let theme = "dark";
  try {
    theme = localStorage.getItem("theme") || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  } catch {}
  const applyTheme = () => {
    document.body.dataset.theme = theme === "light" ? "light" : "dark";
    const btn = document.getElementById("theme-toggle");
    if (btn) btn.textContent = theme === "light" ? "☀️" : "🌙";
  };
  applyTheme();
  const themeBtn = document.getElementById("theme-toggle");
  if (themeBtn) {
    themeBtn.addEventListener("click", () => {
      theme = theme === "light" ? "dark" : "light";
      applyTheme();
      try { localStorage.setItem("theme", theme); } catch {}
    });
  }

  document.getElementById("sync-btn").addEventListener("click", syncNow);
  document.getElementById("account").addEventListener("keydown", (e) => {
    if (e.key === "Enter") syncNow();
  });
  document.getElementById("hist-run").addEventListener("click", () => runHistory(false));
  document.getElementById("hist-refresh").addEventListener("click", () => runHistory(true));

  let redrawTimer = null;
  window.addEventListener("resize", () => {
    if (!state.stats || state.stats.empty) return;
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(() => renderCharts(state.stats), 150);
  });

  await loadConstants();

  // Ссылку можно сохранить в закладки: progress.html?account=123
  const fromUrl = parseAccount(new URLSearchParams(location.search).get("account"));
  const saved = fromUrl || Number(localStorage.getItem(STORAGE_KEY)) || null;

  if (saved) {
    state.account = saved;
    document.getElementById("account").value = String(saved);
    await loadProfile();
    await refresh();
    if (state.stats && !state.stats.empty) document.getElementById("dash").hidden = false;
  }
}

document.addEventListener("DOMContentLoaded", init);
