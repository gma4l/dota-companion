'use strict';

const IMG = (key) => `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/${key}.png`;

const POS_LABELS = {
  1: { name: 'Керри', sub: 'Pos 1' },
  2: { name: 'Мид', sub: 'Pos 2' },
  3: { name: 'Оффлейн', sub: 'Pos 3' },
  4: { name: 'Софт-саппорт', sub: 'Pos 4' },
  5: { name: 'Фулл-саппорт', sub: 'Pos 5' },
};

const ATTR_ICON = { str: '💪', agi: '⚡', int: '🧠' };
const ATTR_NAME = { str: 'Сила', agi: 'Ловкость', int: 'Интеллект' };

const GAME_STATES = {
  'DOTA_GAMERULES_STATE_HERO_SELECTION': 'Выбор героев (All Pick)',
  'DOTA_GAMERULES_STATE_STRATEGY_TIME': 'Стратегическая пауза',
  'DOTA_GAMERULES_STATE_PRE_GAME': 'Подготовка',
  'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS': 'Игра идёт',
  'DOTA_GAMERULES_STATE_INIT': 'Загрузка',
  'DOTA_GAMERULES_STATE_POST_GAME': 'Игра окончена',
};

let HERO_MAP = {};
let lastState = null;
let manual = { radiantPicks: [], radiantBans: [], direPicks: [], direBans: [] };
let activeTarget = 'direPicks';
let attrFilter = '';
// true, если игрок сам переключил категорию — тогда не перебиваем её стороной
let targetTouched = false;
let visibleHeroes = [];

// ---------------------------------------------------------------------------
async function loadHeroes() {
  try {
    const r = await fetch('/api/heroes');
    const d = await r.json();
    for (const h of d.heroes) HERO_MAP[h.key] = h;
    buildPicker();
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function heroImg(key, cls) {
  const img = document.createElement('img');
  img.src = IMG(key);
  img.className = cls || '';
  img.alt = key;
  img.onerror = () => { img.style.visibility = 'hidden'; };
  return img;
}

// ---------------------------------------------------------------------------
function renderDraft(state) {
  const side = state.side || 'radiant';
  document.getElementById('radiantTag').textContent = side === 'radiant' ? 'союзники' : 'враги';
  document.getElementById('direTag').textContent = side === 'dire' ? 'союзники' : 'враги';

  renderTeam('radiantPicks', state.radiant.picks, 5, false);
  renderTeam('radiantBans', state.radiant.bans, 7, true);
  renderTeam('direPicks', state.dire.picks, 5, false);
  renderTeam('direBans', state.dire.bans, 7, true);
}

function renderTeam(containerId, keys, total, banned) {
  const c = document.getElementById(containerId);
  c.innerHTML = '';
  const arr = keys || [];
  for (let i = 0; i < Math.max(arr.length, total); i++) {
    const key = arr[i];
    const slot = el('div', 'hero-slot');
    if (key && HERO_MAP[key]) {
      slot.appendChild(heroImg(key, banned ? 'banned' : ''));
      slot.appendChild(el('div', 'slot-name', HERO_MAP[key].name));
      if (banned) slot.classList.add('banned');
    } else {
      slot.appendChild(el('div', 'empty'));
    }
    c.appendChild(slot);
  }
}

// ---------------------------------------------------------------------------
function renderRecs(recs) {
  const grid = document.getElementById('recsGrid');
  grid.innerHTML = '';

  for (let p = 1; p <= 5; p++) {
    const col = el('div', `pos-col pos-${p}`);
    const head = el('div', 'pos-head');
    head.appendChild(el('span', '', POS_LABELS[p].name));
    head.appendChild(el('span', 'pos-num', POS_LABELS[p].sub));
    col.appendChild(head);

    const list = recs.positions[p] || [];
    if (!list.length) {
      const empty = el('div', 'hero-card');
      empty.appendChild(el('div', 'hero-info', 'Нет доступных героев'));
      col.appendChild(empty);
    }

    list.forEach((h, i) => {
      const card = el('div', 'hero-card');
      card.appendChild(heroImg(h.key, 'portrait'));
      card.appendChild(el('span', 'rank', String(i + 1)));

      const info = el('div', 'hero-info');
      const nameLine = el('div', 'hero-name');
      nameLine.appendChild(document.createTextNode(h.name));
      nameLine.appendChild(el('span', 'ru', h.ru));
      info.appendChild(nameLine);

      const meta = el('div', 'hero-meta');
      meta.appendChild(el('span', `attr-${h.attr}`, `${ATTR_ICON[h.attr]} ${h.attr.toUpperCase()}`));
      info.appendChild(meta);

      const reasons = el('div', 'reasons');
      h.countersVs.forEach((ck) => reasons.appendChild(el('span', 'reason counter', '✓ ' + (HERO_MAP[ck] ? HERO_MAP[ck].name : ck))));
      h.counteredBy.forEach((ck) => reasons.appendChild(el('span', 'reason warn', '⚠ ' + (HERO_MAP[ck] ? HERO_MAP[ck].name : ck))));
      h.synWith.forEach((ak) => reasons.appendChild(el('span', 'reason syn', '↔ ' + (HERO_MAP[ak] ? HERO_MAP[ak].name : ak))));
      if (reasons.childNodes.length) info.appendChild(reasons);

      card.appendChild(info);
      card.appendChild(el('span', 'score-badge', h.score.toFixed(1)));
      col.appendChild(card);
    });

    grid.appendChild(col);
  }
}

// ---------------------------------------------------------------------------
function renderBans(bans) {
  const c = document.getElementById('bansList');
  c.innerHTML = '';
  if (!bans || !bans.length) {
    c.appendChild(el('div', 'empty-note', 'Добавь врагов и союзников — появятся советы по банам.'));
    return;
  }
  bans.forEach((b) => {
    const item = el('div', 'analysis-item');
    item.appendChild(heroImg(b.key, 'a-img'));
    const info = el('div', 'a-info');
    info.appendChild(el('div', 'a-name', b.name + ' ' + b.ru));
    info.appendChild(el('div', 'a-score', 'приоритет ' + b.score.toFixed(1)));
    const reasons = el('div', 'a-reasons');
    b.reasons.forEach((r) => reasons.appendChild(el('span', 'reason counter', r)));
    info.appendChild(reasons);
    item.appendChild(info);
    c.appendChild(item);
  });
}

function renderThreats(threats) {
  const c = document.getElementById('threatsList');
  c.innerHTML = '';
  if (!threats || !threats.length) {
    c.appendChild(el('div', 'empty-note', 'Угроз не найдено — враги пока не контрят твою команду.'));
    return;
  }
  threats.forEach((t) => {
    const item = el('div', 'analysis-item');
    item.appendChild(heroImg(t.key, 'a-img'));
    const info = el('div', 'a-info');
    info.appendChild(el('div', 'a-name', t.name + ' ' + t.ru));
    const vs = t.vs.map((a) => HERO_MAP[a] ? HERO_MAP[a].name : a).join(', ');
    info.appendChild(el('div', 'a-vs', 'контрит: ' + vs));
    item.appendChild(info);
    c.appendChild(item);
  });
}

function renderComposition(comp) {
  const attrs = document.getElementById('compAttrs');
  attrs.innerHTML = '';
  const ac = comp.attrCount || {};
  for (const [a, n] of Object.entries(ac)) {
    const b = el('span', 'attr-chip ' + a, `${ATTR_ICON[a]} ${ATTR_NAME[a]}: ${n}`);
    attrs.appendChild(b);
  }
  const rc = comp.roleCoverage || {};
  const rolesRow = el('div', 'roles-row');
  for (let p = 1; p <= 5; p++) {
    const s = el('span', 'role-dot ' + (rc[p] ? 'filled' : 'empty-role'), String(p));
    rolesRow.appendChild(s);
  }
  attrs.appendChild(el('div', 'roles-caption', 'Позиции: '));
  attrs.appendChild(rolesRow);

  const notes = document.getElementById('compNotes');
  notes.innerHTML = '';
  (comp.notes || []).forEach((n) => notes.appendChild(el('div', 'comp-note', n)));
}

// ---------------------------------------------------------------------------
function renderStatus(state) {
  const badge = document.getElementById('statusBadge');
  const text = document.getElementById('statusText');
  const phase = document.getElementById('phaseText');

  if (state.connected) {
    badge.classList.add('live');
    text.textContent = 'Игра подключена';
  } else {
    badge.classList.remove('live');
    text.textContent = 'Ручной режим';
  }

  const parts = [];
  if (state.gameState && GAME_STATES[state.gameState]) parts.push(GAME_STATES[state.gameState]);
  if (state.ownHero && HERO_MAP[state.ownHero]) parts.push('твой герой: ' + HERO_MAP[state.ownHero].name);
  if (state.pickPhase === true) parts.push('пик');
  else if (state.pickPhase === false) parts.push('бан');
  if (state.activeTeam === 2) parts.push('ход Radiant');
  else if (state.activeTeam === 3) parts.push('ход Dire');
  phase.textContent = parts.join(' · ') || '—';
}

function renderSide(state) {
  const side = state.side || 'radiant';
  document.getElementById('btnRadiant').classList.toggle('active', side === 'radiant');
  document.getElementById('btnDire').classList.toggle('active', side === 'dire');
  syncEnemyTarget(side);
}

// В All Pick чаще всего нужно отмечать врагов: по умолчанию выбираем
// категорию противоположной стороны.
function syncEnemyTarget(side) {
  if (targetTouched) return;
  activeTarget = side === 'dire' ? 'radiantPicks' : 'direPicks';
  document.querySelectorAll('.target-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.target === activeTarget);
  });
}

// ---------------------------------------------------------------------------
async function refresh() {
  try {
    const r = await fetch('/api/state');
    lastState = await r.json();
    renderStatus(lastState);
    renderSide(lastState);
    renderDraft(lastState);
    renderBans(lastState.recs.bans);
    renderThreats(lastState.recs.threats);
    renderComposition(lastState.recs.composition);
    renderRecs(lastState.recs);
  } catch (e) { /* server may be starting */ }
}

// ---------------------------------------------------------------------------
document.getElementById('btnRadiant').addEventListener('click', () => setSide('radiant'));
document.getElementById('btnDire').addEventListener('click', () => setSide('dire'));

async function setSide(side) {
  await fetch('/api/side', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ side }) });
  refresh();
}

// ---------------------------------------------------------------------------
// Ручной выбор героев (паблики)
// ---------------------------------------------------------------------------
const pickerBody = document.getElementById('pickerBody');
document.getElementById('pickerToggle').addEventListener('click', () => {
  pickerBody.hidden = !pickerBody.hidden;
});

// выбор цели
document.querySelectorAll('.target-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.target-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    activeTarget = btn.dataset.target;
    targetTouched = true;
  });
});

// фильтр атрибута
document.querySelectorAll('.attr-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.attr-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    attrFilter = btn.dataset.attr;
    buildPicker();
  });
});

const pickerSearch = document.getElementById('pickerSearch');
pickerSearch.addEventListener('input', buildPicker);

// Enter добавляет первого героя из найденных — быстрее, чем клик.
pickerSearch.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (visibleHeroes.length) {
    addManual(visibleHeroes[0]);
    pickerSearch.select();
  }
});

function buildPicker() {
  const grid = document.getElementById('heroGrid');
  grid.innerHTML = '';
  const q = pickerSearch.value.trim().toLowerCase();

  const keys = Object.keys(HERO_MAP)
    .filter((k) => {
      const h = HERO_MAP[k];
      if (attrFilter && h.attr !== attrFilter) return false;
      if (q && !(h.name.toLowerCase().includes(q) || h.ru.toLowerCase().includes(q) || k.includes(q))) return false;
      return true;
    })
    .sort((a, b) => HERO_MAP[a].name.localeCompare(HERO_MAP[b].name));

  visibleHeroes = keys;

  for (const key of keys) {
    const h = HERO_MAP[key];
    const tile = el('div', 'hero-tile');
    tile.appendChild(heroImg(key, 'tile-img'));
    tile.appendChild(el('div', 'tile-name', h.name));
    tile.title = h.ru;
    tile.addEventListener('click', () => addManual(key));
    grid.appendChild(tile);
  }
}

function addManual(key) {
  if (manual[activeTarget].includes(key)) return;
  // В пиках не может быть больше пяти героев.
  if (activeTarget.endsWith('Picks') && manual[activeTarget].length >= 5) return;
  manual[activeTarget].push(key);
  renderPickerCurrent();
  applyManual();
}

function removeManual(target, key) {
  manual[target] = manual[target].filter((k) => k !== key);
  renderPickerCurrent();
  applyManual();
}

function renderPickerCurrent() {
  const c = document.getElementById('pickerCurrent');
  c.innerHTML = '';
  const groups = [
    ['direPicks', 'Враг · пик'],
    ['radiantPicks', 'Союзник · пик'],
    ['direBans', 'Враг · бан'],
    ['radiantBans', 'Союзник · бан'],
  ];
  for (const [g, label] of groups) {
    if (!manual[g].length) continue;
    const box = el('div', 'pc-group');
    box.appendChild(el('b', '', label + ': '));
    manual[g].forEach((key) => {
      const chip = el('span', 'chip');
      chip.appendChild(heroImg(key));
      chip.appendChild(document.createTextNode(HERO_MAP[key] ? HERO_MAP[key].name : key));
      const x = el('span', 'x', '✕');
      x.addEventListener('click', () => removeManual(g, key));
      chip.appendChild(x);
      box.appendChild(chip);
    });
    c.appendChild(box);
  }
}

async function applyManual() {
  await fetch('/api/manual', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      side: lastState && lastState.side,
      ownHero: lastState && lastState.ownHero,
      ...manual,
    }),
  });
  refresh();
}

document.getElementById('pickerClear').addEventListener('click', async () => {
  manual = { radiantPicks: [], radiantBans: [], direPicks: [], direBans: [] };
  renderPickerCurrent();
  await fetch('/api/reset', { method: 'POST' });
  refresh();
});

// ---------------------------------------------------------------------------
(async function init() {
  await loadHeroes();
  renderPickerCurrent();
  refresh();
  setInterval(refresh, 1500);
})();
