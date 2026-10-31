const API = "https://api.opendota.com";

// Кэш констант
let HEROES = {}; // id -> {name, localized_name}
let ITEMS = {}; // id -> {name, localized_name}

// ---- Загрузка констант ----
let constantsPromise = null;
function loadConstants() {
  if (!constantsPromise) {
    constantsPromise = (async () => {
      try {
        const [heroesRes, itemsRes] = await Promise.all([
          fetch(`${API}/api/constants/heroes`),
          fetch(`${API}/api/constants/items`),
        ]);
        if (heroesRes.ok) {
          const h = await heroesRes.json();
          HEROES = h || {};
        }
        if (itemsRes.ok) {
          const it = await itemsRes.json();
          ITEMS = it || {};
        }
      } catch (e) {
        // не критично — есть fallback
      }
    })();
  }
  return constantsPromise;
}

function heroName(id) {
  const h = HEROES[id];
  if (h) return h.localized_name || h.name || `Герой ${id}`;
  return `Герой ${id}`;
}

function heroKey(id) {
  const h = HEROES[id];
  if (h && h.name) return h.name.replace(/^npc_dota_hero_/, "");
  return "";
}

function itemNameById(id) {
  const it = ITEMS[id];
  if (it) return it.localized_name || prettyItemName(it.name) || `item_${id}`;
  return `item_${id}`;
}

function prettyItemName(name) {
  if (!name) return "";
  return name
    .replace(/^item_/, "")
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ---- Форматирование ----
function fmtDuration(sec) {
  if (!sec) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const GAME_MODES = {
  1: "All Pick", 2: "Captain's Mode", 3: "Random Draft", 4: "Single Draft",
  5: "All Random", 16: "Captain's Draft", 22: "All Pick", 23: "Turbo",
};

function gameModeName(id) {
  return GAME_MODES[id] || `Режим ${id}`;
}

// ---- Фарм-предметы и тайминги ----
const FARM_ITEMS = {
  bfury: { label: "Battle Fury", typical: 16 },
  radiance: { label: "Radiance", typical: 20 },
  hand_of_midas: { label: "Hand of Midas", typical: 10 },
  maelstrom: { label: "Maelstrom", typical: 15 },
  mjollnir: { label: "Mjollnir", typical: 20 },
  echo_sabre: { label: "Echo Sabre", typical: 15 },
  desolator: { label: "Desolator", typical: 16 },
  diffusal_blade: { label: "Diffusal Blade", typical: 13 },
  orchid: { label: "Orchid Malevolence", typical: 15 },
};

const HERO_FARM = {
  antimage: ["bfury"],
  phantom_assassin: ["bfury", "desolator"],
  juggernaut: ["bfury", "maelstrom"],
  wraith_king: ["radiance"],
  spectre: ["radiance"],
  alchemist: ["radiance"],
  doom: ["radiance"],
  necrophos: ["radiance"],
  faceless_void: ["maelstrom", "mjollnir"],
  sniper: ["maelstrom", "mjollnir"],
  windranger: ["maelstrom", "mjollnir"],
  ember_spirit: ["bfury"],
  phantom_lancer: ["diffusal_blade"],
  void_spirit: ["echo_sabre"],
};

// ---- Пороги анализа ----
const CFG = {
  core: { minLhPerMin: 4.0, minGpm: 400, laningLh10: 32, highDeaths: 7 },
  support: { minObs: 5, minSentry: 3, highDeaths: 10, maxLhPerMin: 3.0 },
  killParticipation: 30, // % ниже = мало участвовал
  heroDamageShare: 12, // % от команды ниже = не воевал
  buybackWaste: 2,
};

// ---- Позиции игроков ----
function assignTeamPositions(team) {
  const mids = team.filter((p) => (p.lane_role ?? 0) === 2);
  mids.forEach((p) => { p.pos = 2; p.isCore = true; });

  const safes = team.filter((p) => (p.lane_role ?? 0) === 1);
  safes.sort((a, b) => (b.last_hits || 0) - (a.last_hits || 0));
  if (safes.length >= 2) {
    safes[0].pos = 1; safes[0].isCore = true;
    safes[1].pos = 5; safes[1].isCore = false;
  } else if (safes.length === 1) {
    safes[0].pos = 1; safes[0].isCore = true;
  }

  const offs = team.filter((p) => (p.lane_role ?? 0) === 3);
  offs.sort((a, b) => (b.last_hits || 0) - (a.last_hits || 0));
  if (offs.length >= 2) {
    offs[0].pos = 3; offs[0].isCore = true;
    offs[1].pos = 4; offs[1].isCore = false;
  } else if (offs.length === 1) {
    offs[0].pos = 3; offs[0].isCore = true;
  }

  team.filter((p) => p.pos === undefined).forEach((p) => {
    p.pos = 4; p.isCore = false;
  });

  // если не удалось определить никого по линиям — по фарму
  const defined = team.filter((p) => p.pos !== 4);
  if (defined.length === 0) {
    team.sort((a, b) => (b.last_hits || 0) - (a.last_hits || 0));
    team[0].pos = 1; team[0].isCore = true;
    team[1].pos = 2; team[1].isCore = true;
    team[2].pos = 3; team[2].isCore = true;
    team[3].pos = 4; team[3].isCore = false;
    team[4].pos = 5; team[4].isCore = false;
  }

  team.forEach((p) => { if (p.is_roaming) p.isCore = false; });
}

function posLabel(p) {
  const names = { 1: "Керри (1)", 2: "Мид (2)", 3: "Оффлейн (3)", 4: "Саппорт (4)", 5: "Саппорт (5)" };
  return names[p.pos] || "—";
}

// ---- Анализ одного игрока ----
function analyzePlayer(p, teamKills, teamHeroDamage, minutes) {
  const findings = [];
  const isCore = p.isCore;

  // --- Смерти ---
  const deaths = p.deaths || 0;
  const deathCap = isCore ? CFG.core.highDeaths : CFG.support.highDeaths;
  if (deaths >= deathCap + 2) {
    findings.push({
      sev: "critical",
      title: `Слишком много смертей: ${deaths}`,
      detail: `${isCore ? "Керри/кор" : "Саппорт"} умер ${deaths} раз. Каждая смерть кора кормит врага золотом и выбивает команду из темпа.`,
    });
  } else if (deaths >= deathCap) {
    findings.push({
      sev: "major",
      title: `Много смертей: ${deaths}`,
      detail: "Стоит осторожнее позиционироваться и не ходить в одиночку по тёмной карте.",
    });
  }

  // --- Фарм (только коры) ---
  if (isCore && minutes > 0) {
    const lhPerMin = (p.last_hits || 0) / minutes;
    const gpm = p.gold_per_min || 0;
    if (lhPerMin < CFG.core.minLhPerMin) {
      findings.push({
        sev: "critical",
        title: `Низкий фарм: ${(p.last_hits || 0)} крипов (${lhPerMin.toFixed(1)}/мин)`,
        detail: `Керри должен стабильно добивать. При ${minutes.toFixed(0)} мин ожидается от ${(CFG.core.minLhPerMin * minutes).toFixed(0)}+ крипов.`,
      });
    }
    if (gpm < CFG.core.minGpm) {
      findings.push({
        sev: "major",
        title: `Низкий GPM: ${gpm}`,
        detail: `Золото в минуту ниже ${CFG.core.minGpm} — отставание от темпа предметов.`,
      });
    }

    // --- Лайнинг (первые 10 минут) ---
    if (Array.isArray(p.lh_t) && minutes >= 10) {
      const lh10 = p.lh_t.slice(0, 10).reduce((s, x) => s + (x || 0), 0);
      if (lh10 < CFG.core.laningLh10) {
        findings.push({
          sev: "major",
          title: `Слабый лайнинг: ${lh10} крипов за 10 мин`,
          detail: "Мало добил на линии. Стоит разобраться: мешают харасы или не хватает тайминга добивания.",
        });
      }
    }
  }

  // --- Отбирание фарма саппортом ---
  if (!isCore && minutes > 0) {
    const lhPerMin = (p.last_hits || 0) / minutes;
    if (lhPerMin > CFG.support.maxLhPerMin) {
      findings.push({
        sev: "minor",
        title: `Отбирает фарм у кора: ${(p.last_hits || 0)} крипов`,
        detail: `Саппорт добил слишком много (${lhPerMin.toFixed(1)}/мин). Последние удары лучше отдавать кору.`,
      });
    }
  }

  // --- Варды (саппорты) ---
  if (!isCore && p.obs_placed !== undefined) {
    const obs = p.obs_placed;
    const sen = p.sen_placed ?? 0;
    const obsNeed = Math.max(3, Math.floor(minutes / 7));
    if (obs < CFG.support.minObs) {
      findings.push({
        sev: "major",
        title: `Мало обсерверов: ${obs}`,
        detail: `Поставлено ${obs} обсервер-вардов (ожидалось от ${obsNeed}). Команда играет вслепую.`,
      });
    }
    if (p.sen_placed !== undefined && sen < CFG.support.minSentry) {
      findings.push({
        sev: "minor",
        title: `Мало сентри: ${sen}`,
        detail: "Не хватает девардинга — вражеские варды и невидимость остаются безнаказанными.",
      });
    }
  }

  // --- Участие в драках ---
  if (teamKills > 0) {
    const kp = ((p.kills || 0) + (p.assists || 0)) / teamKills * 100;
    if (kp < CFG.killParticipation) {
      findings.push({
        sev: isCore ? "major" : "minor",
        title: `Мало участвует в драках: ${kp.toFixed(0)}%`,
        detail: `Килл-участие ${kp.toFixed(0)}% — большую часть убийств команды сделал без него.`,
      });
    }
  }

  // --- Урон по героям (коры) ---
  if (isCore && teamHeroDamage > 0) {
    const share = ((p.hero_damage || 0) / teamHeroDamage) * 100;
    if (share < CFG.heroDamageShare) {
      findings.push({
        sev: "major",
        title: `Фармит, но не дерётся: ${share.toFixed(0)}% урона`,
        detail: "Доля урона по героям слишком мала — кор в основном фармил в стороне, а не наносил урон в драках.",
      });
    }
  }

  // --- Бесполезные байбеки ---
  if (p.buyback_count != null && p.buyback_count >= CFG.buybackWaste) {
    findings.push({
      sev: "minor",
      title: `Много байбеков: ${p.buyback_count}`,
      detail: "Байбек стоил золота и заблокировал фарм. Если выкупался без цели — это потеря темпа.",
    });
  }

  // --- Ливер ---
  if (p.leaver_status && p.leaver_status > 0) {
    findings.push({
      sev: "critical",
      title: "Покинул матч / АФК",
      detail: "Игрок вышел или был отключён, команда играла в меньшинстве.",
    });
  }

  // Предметные сборки намеренно не оцениваем по статическому списку.
  // Мета и назначение предметов меняются от патча к патчу, поэтому совет
  // «ты не собрал X» часто устаревает и вводит игрока в заблуждение.
  // AI получает фактические предметы на конец игры и может обсудить их
  // только в контексте остальных метрик матча.
  return findings;
}

// ---- Анализ команды ----
function analyzeTeam(team, match) {
  const minutes = (match.duration || 0) / 60;
  const teamKills = team.reduce((s, p) => s + (p.kills || 0), 0);
  const teamHeroDamage = team.reduce((s, p) => s + (p.hero_damage || 0), 0);

  assignTeamPositions(team);

  const teamFindings = [];
  const hasObs = team.some((p) => p.obs_placed !== undefined);
  const totalObs = team.reduce((s, p) => s + (p.obs_placed || 0), 0);
  const obsNeed = Math.floor(minutes / 3.5);
  if (hasObs && totalObs < obsNeed) {
    teamFindings.push({
      sev: "major",
      title: `Команда мало ставила вардов: ${totalObs} обсерверов`,
      detail: `На ${minutes.toFixed(0)} мин ожидалось ~${obsNeed}. Плохой вижн — частая причина потерь.`,
    });
  }

  const players = team.map((p) => ({
    slot: p.player_slot,
    accountId: p.account_id,
    heroId: p.hero_id,
    heroName: heroName(p.hero_id),
    pos: p.pos,
    posLabel: posLabel(p),
    isCore: p.isCore,
    win: p.win,
    kills: p.kills || 0,
    deaths: p.deaths || 0,
    assists: p.assists || 0,
    level: p.level || 0,
    lastHits: p.last_hits || 0,
    denies: p.denies || 0,
    gpm: p.gold_per_min || 0,
    xpm: p.xp_per_min || 0,
    netWorth: p.net_worth ?? p.total_gold ?? null,
    heroDamage: p.hero_damage ?? null,
    towerDamage: p.tower_damage ?? null,
    heroHealing: p.hero_healing ?? null,
    obs: p.obs_placed ?? null,
    sen: p.sen_placed ?? null,
    buybacks: p.buyback_count ?? null,
    items: [p.item_0, p.item_1, p.item_2, p.item_3, p.item_4, p.item_5]
      .filter((i) => i && i > 0)
      .map((i) => itemNameById(i)),
    findings: analyzePlayer(p, teamKills, teamHeroDamage, minutes),
  }));

  players.sort((a, b) => a.pos - b.pos);

  return { players, findings: teamFindings, kills: teamKills };
}

// ---- Главный анализ ----
function analyze(match) {
  const radiant = match.players.filter((p) => p.player_slot < 128);
  const dire = match.players.filter((p) => p.player_slot >= 128);

  const radiantTeam = analyzeTeam(radiant, match);
  const direTeam = analyzeTeam(dire, match);

  const parsed =
    (match.od_data && match.od_data.has_parsed) ||
    match.players.some((p) => p.obs_placed !== undefined || p.lh_t !== undefined || p.purchase_log !== undefined);

  return {
    matchId: match.match_id,
    duration: fmtDuration(match.duration),
    minutes: ((match.duration || 0) / 60).toFixed(0),
    mode: gameModeName(match.game_mode),
    radiantWin: !!match.radiant_win,
    radiantKills: radiantTeam.kills,
    direKills: direTeam.kills,
    radiant: radiantTeam,
    dire: direTeam,
    parsed,
  };
}

// ---- Получение матча ----
/** Пароль доступа, если сервер запущен с ACCESS_PASSWORD (для размещения в интернете). */
function authHeaders() {
  const headers = { "Content-Type": "application/json" };
  try {
    const pwd = localStorage.getItem("accessPassword");
    if (pwd) headers["X-Auth"] = pwd;
  } catch {
    // localStorage недоступен — работаем без пароля.
  }
  return headers;
}

async function fetchMatch(id) {
  let res;
  // Через сервер — с кэшем и единой обработкой ошибок; при недоступности сервера — напрямую в OpenDota.
  if (coachServed()) {
    try {
      res = await fetch(`/api/match/${id}`, { headers: authHeaders() });
    } catch {
      res = null;
    }
  }
  if (!res || !res.ok) {
    res = await fetch(`${API}/api/matches/${id}`);
  }
  if (!res.ok) {
    if (res.status === 404) throw new Error("Матч не найден. Проверьте ID — матч должен быть публичным.");
    if (res.status === 429) throw new Error("Слишком много запросов к OpenDota. Подождите минуту и повторите.");
    if (res.status === 401) {
      const pwd = prompt("Сервер запрошен пароль (ACCESS_PASSWORD):");
      if (pwd) {
        try { localStorage.setItem("accessPassword", pwd); } catch {}
        return fetchMatch(id); // повтор уже с паролем
      }
      throw new Error("Доступ закрыт паролем сервера.");
    }
    throw new Error(`Ошибка OpenDota: ${res.status}`);
  }
  const data = await res.json();
  if (!data || !data.players || !data.players.length) {
    throw new Error("Матч ещё не распарсен или данных нет.");
  }
  return data;
}

// ---- Рендер ----
function sevLabel(sev) {
  return { critical: "Критично", major: "Важно", minor: "Совет" }[sev] || sev;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function renderSummary(r) {
  const wrap = document.getElementById("match-summary");
  wrap.innerHTML = "";

  const cards = [
    { k: "Матч", v: `#${r.matchId}` },
    { k: "Длительность", v: r.duration },
    { k: "Режим", v: r.mode },
    { k: "Победитель", v: r.radiantWin ? "Radiant" : "Dire", cls: r.radiantWin ? "radiant" : "dire" },
    { k: "Счёт убийств", v: `${r.radiantKills} : ${r.direKills}` },
  ];
  for (const c of cards) {
    const card = el("div", "summary-card");
    card.appendChild(el("div", "k", c.k));
    card.appendChild(el("div", "v" + (c.cls ? " " + c.cls : ""), c.v));
    wrap.appendChild(card);
  }

  // Преимущество по нетворсу: показывает, кто выигрывал экономику.
  const sumNW = (t) => t.players.reduce((s, p) => s + (p.netWorth || 0), 0);
  const radNW = sumNW(r.radiant);
  const direNW = sumNW(r.dire);
  if (radNW + direNW > 0) {
    const radShare = Math.round((radNW / (radNW + direNW)) * 100);
    const diff = radNW - direNW;
    const block = el("div", "gold-advantage");
    const head = el("div", "ga-head");
    head.appendChild(el("span", "", `Radiant · ${fmtGold(radNW)}`));
    head.appendChild(el("span", "", `${fmtGold(direNW)} · Dire`));
    block.appendChild(head);
    const bar = el("div", "ga-bar");
    const fill = el("div", "ga-fill");
    fill.style.width = `${Math.abs(radShare - 50) * 2}%`;
    if (radShare < 50) {
      fill.style.left = "auto";
      fill.style.right = "50%";
      fill.style.background = "linear-gradient(270deg, rgba(255,107,107,0.55), var(--dire))";
      fill.style.borderRadius = "0 6px 6px 0";
    }
    bar.appendChild(fill);
    block.appendChild(bar);
    block.appendChild(el("div", "ga-label", diff === 0 ? "Экономика равна" : diff > 0 ? `Radiant впереди на ${fmtGold(diff)}` : `Dire впереди на ${fmtGold(-diff)}`));
    wrap.appendChild(block);
  }
}

function fmtGold(v) {
  if (v == null) return "—";
  const sign = v < 0 ? "−" : "";
  v = Math.abs(v);
  if (v >= 1000) return `${sign}${(v / 1000).toFixed(v >= 10000 ? 1 : 2)}k 🪙`;
  return `${sign}${v} 🪙`;
}

function renderFindings(container, findings) {
  if (!findings.length) {
    container.appendChild(el("div", "finding minor", ""));
    const ok = container.lastElementChild;
    ok.classList.remove("finding", "minor");
    ok.classList.add("ok-note");
    ok.textContent = "Явных ошибок не найдено.";
    ok.style.cssText = "color: var(--good); font-size: 13px; padding: 4px 2px;";
    return;
  }
  for (const f of findings) {
    const div = el("div", `finding ${f.sev}`);
    const title = el("div", "ftitle");
    title.appendChild(document.createTextNode(f.title));
    title.appendChild(el("span", `sev-tag ${f.sev}`, sevLabel(f.sev)));
    div.appendChild(title);
    div.appendChild(el("div", "fdetail", f.detail));
    container.appendChild(div);
  }
}

function renderPlayer(p, side) {
  const card = el("div", "player");
  card.dataset.side = side;

  const head = el("div", "player-head");
  const img = el("img");
  img.src = `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/${heroKey(p.heroId)}.png`;
  img.alt = p.heroName;
  img.onerror = () => { img.style.visibility = "hidden"; };
  head.appendChild(img);

  const nameWrap = el("div");
  nameWrap.appendChild(el("div", "pname", p.heroName));
  nameWrap.appendChild(el("div", "pmeta", p.posLabel + (p.win ? " · Победа" : " · Поражение")));
  head.appendChild(nameWrap);

  const score = el("div", "score");
  const kda = el("div", "kda");
  kda.appendChild(el("span", "k", String(p.kills)));
  kda.appendChild(document.createTextNode(" / "));
  kda.appendChild(el("span", "d", String(p.deaths)));
  kda.appendChild(document.createTextNode(" / "));
  kda.appendChild(el("span", "a", String(p.assists)));
  score.appendChild(kda);

  const badges = el("div", "badges");
  badges.appendChild(el("span", "badge role", p.posLabel));
  const sevs = { critical: 0, major: 0, minor: 0 };
  p.findings.forEach((f) => sevs[f.sev]++);
  if (sevs.critical) badges.appendChild(el("span", "badge sev-crit", `Критично ${sevs.critical}`));
  if (sevs.major) badges.appendChild(el("span", "badge sev-major", `Важно ${sevs.major}`));
  if (sevs.minor) badges.appendChild(el("span", "badge sev-minor", `Совет ${sevs.minor}`));
  score.appendChild(badges);
  head.appendChild(score);

  card.appendChild(head);

  const body = el("div", "player-body");
  const grid = el("div", "stats-grid");
  const stats = [
    ["Уровень", p.level],
    ["Крипы", p.lastHits],
    ["Денаи", p.denies],
    ["GPM", p.gpm],
    ["XPM", p.xpm],
    ["Нетворс", p.netWorth],
    ["Урон по героям", p.heroDamage],
    ["Урон по башням", p.towerDamage],
    ["Хил", p.heroHealing],
    ["Обс. варды", p.obs],
    ["Сентри", p.sen],
    ["Байбеки", p.buybacks],
  ];
  for (const [k, v] of stats) {
    const s = el("div", "stat");
    s.appendChild(el("div", "k", k));
    s.appendChild(el("div", "v", v == null ? "—" : String(v)));
    grid.appendChild(s);
  }
  body.appendChild(grid);

  if (p.items.length) {
    const itemsRow = el("div", "stat");
    itemsRow.appendChild(el("div", "k", "Предметы"));
    itemsRow.appendChild(el("div", "v", p.items.join(" · ")));
    body.appendChild(itemsRow);
  }

  const fw = el("div");
  renderFindings(fw, p.findings);
  body.appendChild(fw);

  card.appendChild(body);
  body.style.display = "none";

  head.addEventListener("click", () => {
    body.style.display = body.style.display === "none" ? "block" : "none";
  });

  return card;
}

async function requestParse(id) {
  try {
    const res = await fetch(`${API}/api/request/${id}`, { method: "POST" });
    return res.ok;
  } catch (e) {
    return false;
  }
}

function renderParseBanner(r) {
  const wrap = document.getElementById("parse-banner");
  wrap.innerHTML = "";
  if (r.parsed) return;

  const banner = el("div", "parse-banner");
  const txt = el("span");
  txt.textContent =
    "⚠️ OpenDota ещё не разобрал этот реплей, поэтому детальный анализ (варды, лайнинг, тайминги предметов, байбеки) недоступен. Основные ошибки по смертям и фарму показаны.";
  banner.appendChild(txt);

  const btn = el("button", "parse-btn", "Запросить разбор");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Запрос отправлен…";
    const ok = await requestParse(r.matchId);
    if (ok) {
      btn.textContent = "Запрошено — проверьте через 2–5 минут";
      const note = el("div", "parse-note", "После разбора нажмите «Анализировать» ещё раз.");
      banner.appendChild(note);
    } else {
      btn.textContent = "Не удалось отправить запрос";
      btn.disabled = false;
    }
  });
  banner.appendChild(btn);
  wrap.appendChild(banner);
}

function renderReport(r) {
  currentReport = r;
  renderParseBanner(r);
  renderSummary(r);
  initCoach(r);

  const teamErr = document.getElementById("team-errors");
  teamErr.innerHTML = "";

  const playersWrap = document.getElementById("players");
  playersWrap.innerHTML = "";

  for (const [side, team] of [["radiant", r.radiant], ["dire", r.dire]]) {
    const tb = el("div", "team-block");
    const h = el("h2", side, side === "radiant" ? "Radiant" : "Dire");
    tb.appendChild(h);
    renderFindings(tb, team.findings);
    teamErr.appendChild(tb);

    for (const p of team.players) {
      playersWrap.appendChild(renderPlayer(p, side));
    }
  }
  const filter = document.getElementById("team-filter");
  if (filter) {
    filter.hidden = false;
    filter.querySelectorAll(".chip").forEach((chip) => {
      chip.onclick = () => setTeamFilter(chip.dataset.side);
    });
    setTeamFilter("all");
  }
}

// ---- UI ----
const statusEl = () => document.getElementById("status");
const reportEl = () => document.getElementById("report");

function setStatus(msg, isError = false) {
  const s = statusEl();
  s.hidden = false;
  s.textContent = msg;
  s.className = "status " + (isError ? "error" : "info");
}

function hideStatus() {
  statusEl().hidden = true;
}

/** Достаёт ID матча из числа или ссылки (OpenDota, Dotabuff, Stratz). */
function parseMatchId(raw) {
  const s = String(raw || "").trim();
  if (/^\d{6,}$/.test(s)) return s;

  const m = s.match(/(?:matches?|match_id=)\/?(\d{6,})/i);
  if (m) return m[1];

  return null;
}

async function runAnalysis() {
  const input = document.getElementById("match-id");
  const btn = document.getElementById("analyze-btn");
  const id = parseMatchId(input.value);
  if (!id) {
    setStatus("Введите ID матча или ссылку на него.", true);
    return;
  }

  btn.disabled = true;
  reportEl().hidden = true;
  setStatus("Загружаем матч и анализируем…");

  try {
    const [match] = await Promise.all([fetchMatch(id), loadConstants()]);
    const report = analyze(match);
    try {
      localStorage.setItem("lastMatchId", id);
      saveRecentMatch(id);
    } catch {
      // localStorage может быть недоступен — не критично.
    }
    renderReport(report);
    hideStatus();
    reportEl().hidden = false;
  } catch (e) {
    setStatus(e.message || "Не удалось загрузить матч.", true);
  } finally {
    btn.disabled = false;
  }
}

function init() {
  document.getElementById("analyze-btn").addEventListener("click", runAnalysis);
  document.getElementById("match-id").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runAnalysis();
  });
  document.getElementById("sample-btn").addEventListener("click", () => {
    document.getElementById("match-id").value = "7409157232";
    runAnalysis();
  });
  loadConstants();
  initCoachControls();
  initTheme();
  renderRecentChips();

  // Переход из трекера: index.html?match=123456
  const preset = new URLSearchParams(location.search).get("match");
  if (preset && /^\d+$/.test(preset)) {
    document.getElementById("match-id").value = preset;
    runAnalysis();
  } else {
    // Восстанавливаем последний разобранный матч — страницу часто открывают заново.
    try {
      const lastMatch = localStorage.getItem("lastMatchId");
      if (lastMatch && /^\d+$/.test(lastMatch)) {
        document.getElementById("match-id").value = lastMatch;
        setStatus(`Последний матч: ${lastMatch}. Нажмите «Анализировать», чтобы открыть снова.`);
      }
    } catch {
      // localStorage может быть недоступен в приватном режиме — не критично.
    }
  }
}

document.addEventListener("DOMContentLoaded", init);

// ─────────────────── Чипы последних матчей ───────────────────

function recentMatches() {
  try {
    const raw = JSON.parse(localStorage.getItem("recentMatches") || "[]");
    return Array.isArray(raw) ? raw.filter((m) => /^\d{6,}$/.test(String(m.id))) : [];
  } catch {
    return [];
  }
}

function saveRecentMatch(id) {
  const list = recentMatches().filter((m) => m.id !== id);
  list.unshift({ id, at: Date.now() });
  try {
    localStorage.setItem("recentMatches", JSON.stringify(list.slice(0, 8)));
  } catch {}
}

function renderRecentChips() {
  const wrap = document.getElementById("recent-chips");
  if (!wrap) return;
  const list = recentMatches();
  wrap.hidden = list.length === 0;
  wrap.innerHTML = "";
  list.forEach((m) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.title = `Открыть матч ${m.id}`;
    const when = new Date(m.at).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
    chip.textContent = `#${m.id} · ${when}`;
    chip.addEventListener("click", () => {
      document.getElementById("match-id").value = m.id;
      runAnalysis();
    });
    wrap.appendChild(chip);
  });
}

// ─────────────────── Фильтр игроков по команде ───────────────────

function setTeamFilter(side) {
  const wrap = document.getElementById("players");
  if (!wrap) return;
  wrap.dataset.filter = side;
  [...wrap.children].forEach((card) => {
    card.hidden = side !== "all" && card.dataset.side !== side;
  });
  document.querySelectorAll("#team-filter .chip").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.side === side);
  });
}

// ─────────────────── Тема ───────────────────────────

function applyTheme(theme) {
  document.body.dataset.theme = theme === "light" ? "light" : "dark";
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.textContent = theme === "light" ? "☀️" : "🌙";
}

function initTheme() {
  let theme = "dark";
  try {
    theme = localStorage.getItem("theme") || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  } catch {
    // localStorage недоступен — остаёмся в тёмной теме.
  }
  applyTheme(theme);
  const btn = document.getElementById("theme-toggle");
  if (btn) {
    btn.addEventListener("click", () => {
      const next = document.body.dataset.theme === "light" ? "dark" : "light";
      applyTheme(next);
      try { localStorage.setItem("theme", next); } catch {}
    });
  }
}

// ─────────────────────────── AI-тренер ───────────────────────────

let currentReport = null;
let coachAbort = null;

function coachServed() {
  return location.protocol === "http:" || location.protocol === "https:";
}

function coachNote(msg) {
  const note = document.getElementById("coach-note");
  if (!msg) {
    note.hidden = true;
    note.textContent = "";
    return;
  }
  note.hidden = false;
  note.textContent = msg;
}

function fillCoachSelect(r) {
  const sel = document.getElementById("coach-player");
  sel.innerHTML = "";

  const all = document.createElement("option");
  all.value = "match";
  all.textContent = "Весь матч целиком";
  sel.appendChild(all);

  for (const [side, label] of [["radiant", "Radiant"], ["dire", "Dire"]]) {
    const group = document.createElement("optgroup");
    group.label = label;
    r[side].players.forEach((p, i) => {
      const opt = document.createElement("option");
      opt.value = side + ":" + i;
      opt.textContent = `${p.heroName} — ${p.posLabel}`;
      group.appendChild(opt);
    });
    sel.appendChild(group);
  }
}

function initCoach(r) {
  const section = document.getElementById("coach");
  const out = document.getElementById("coach-out");
  const runBtn = document.getElementById("coach-run");

  section.hidden = false;
  out.hidden = true;
  out.innerHTML = "";
  coachNote("");
  const copyBtn = document.getElementById("coach-copy");
  const downloadBtn = document.getElementById("coach-download");
  if (copyBtn) { copyBtn.hidden = true; copyBtn.textContent = "Копировать"; }
  if (downloadBtn) downloadBtn.hidden = true;
  runBtn.disabled = false;
  fillCoachSelect(r);

  if (!coachServed()) {
    runBtn.disabled = true;
    coachNote(
      "AI-тренер работает только через локальный сервер. Запустите start.cmd — откроется http://localhost:8080"
    );
  } else {
    coachHealth();
  }
}

async function coachHealth() {
  if (!coachServed()) return;
  const refreshBtn = document.getElementById("coach-refresh");
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Проверяю…";
  }
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    const j = await res.json();

    const label = document.getElementById("coach-model");
    if (label && j.model) label.textContent = j.model;

    if (!j.ok) {
      coachNote(`${j.error || "Ollama недоступна."} ${j.hint || ""}`.trim());
    } else if (!j.modelReady) {
      coachNote(`Ollama подключена (${j.ollama}), но модель «${j.model}» не найдена. Установите её: ollama pull ${j.model}. Доступные: ${(j.models || []).join(", ") || "нет"}`);
    }
  } catch (e) {
    coachNote("Не удалось проверить состояние Ollama: " + e.message);
  } finally {
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.textContent = "Проверить Ollama";
    }
  }
}

// Мини-разметка (escapeHtml, inlineMd, renderMarkdown) — в markdown.js.

async function runCoach() {
  const sel = document.getElementById("coach-player");
  const runBtn = document.getElementById("coach-run");
  const stopBtn = document.getElementById("coach-stop");
  const out = document.getElementById("coach-out");

  if (!currentReport) return;

  coachNote("");
  out.hidden = false;
  out.innerHTML = '<div class="coach-meta">Модель думает… первый запуск может занять до минуты.</div>';
  runBtn.disabled = true;
  stopBtn.hidden = false;

  let payload;
  if (sel.value === "match") {
    payload = Object.assign({}, currentReport, { mode: "match" });
  } else {
    const parts = sel.value.split(":");
    payload = Object.assign({}, currentReport, {
      mode: "player",
      side: parts[0],
      playerIndex: Number(parts[1]),
    });
  }

  const modelLabel = document.getElementById("coach-model").textContent;
  const started = Date.now();
  let text = "";
  let lastPaint = 0;

  const paint = () => {
    out.innerHTML = renderMarkdown(text) + '<span class="coach-cursor"></span>';
  };

  coachAbort = new AbortController();

  try {
    const res = await fetch("/api/coach", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload),
      signal: coachAbort.signal,
    });

    if (!res.ok || !res.body) {
      if (res.status === 401) {
        const pwd = prompt("Сервер запрошен пароль (ACCESS_PASSWORD):");
        if (pwd) {
          try { localStorage.setItem("accessPassword", pwd); } catch {}
          return runCoach();
        }
        throw new Error("Доступ закрыт паролем сервера.");
      }
      throw new Error(`Сервер ответил ошибкой ${res.status}. Запущен ли server.js?`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

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
      }
    }

  paint();
  const secs = Math.round((Date.now() - started) / 1000);
  out.appendChild(el("div", "coach-meta", `Готово за ${secs} с · ${modelLabel}`));
  const copyBtn = document.getElementById("coach-copy");
  if (copyBtn) copyBtn.hidden = false;
  const dlBtn = document.getElementById("coach-download");
  if (dlBtn) {
    dlBtn.hidden = false;
    dlBtn.onclick = () => {
      const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      const who = document.getElementById("coach-player").selectedOptions[0]?.textContent || "матч";
      a.download = `razbor-${currentReport?.matchId || "match"}-${who.replace(/[^\wа-яА-ЯёЁ ]+/g, "").trim().slice(0, 40) || "ai"}.md`;
      a.click();
      URL.revokeObjectURL(a.href);
    };
  }
  } catch (e) {
    if (e.name === "AbortError") {
      out.innerHTML = renderMarkdown(text) + '<div class="coach-meta">Остановлено.</div>';
    } else if (text) {
      out.innerHTML = renderMarkdown(text);
      coachNote(e.message);
    } else {
      out.hidden = true;
      coachNote(e.message);
    }
  } finally {
    runBtn.disabled = false;
    stopBtn.hidden = true;
    coachAbort = null;
  }
}

function initCoachControls() {
  document.getElementById("coach-run").addEventListener("click", runCoach);
  document.getElementById("coach-refresh").addEventListener("click", coachHealth);
  document.getElementById("coach-copy").addEventListener("click", async () => {
    const btn = document.getElementById("coach-copy");
    const text = document.getElementById("coach-out").innerText.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Скопировано ✓";
    } catch {
      // Fallback для страниц без доступа к clipboard API.
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        btn.textContent = "Скопировано ✓";
      } catch {
        btn.textContent = "Не удалось скопировать";
      }
      ta.remove();
    }
    setTimeout(() => { btn.textContent = "Копировать"; }, 2000);
  });
  document.getElementById("coach-stop").addEventListener("click", () => {
    if (coachAbort) coachAbort.abort();
  });
  coachHealth();
}

