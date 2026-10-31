'use strict';

import { matchFindings, heroName, heroSlug, formatDuration } from './findings.js';

const IMG = (slug) => `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/${slug}.png`;
const $ = (id) => document.getElementById(id);

let HEROES = {};
let heroById = null;
let query = '';
let target = 'direPicks';
let timer = null;

const draft = {
  side: 'radiant',
  ownHero: null,
  radiantPicks: [],
  radiantBans: [],
  direPicks: [],
  direBans: [],
};

const TARGETS = [
  ['direPicks', 'Враги'],
  ['radiantPicks', 'Союзники'],
  ['direBans', 'Баны врагов'],
  ['radiantBans', 'Наши баны'],
];

// ─────────────────────────── Общее ───────────────────────────

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function img(slug, cls) {
  const node = document.createElement('img');
  node.src = IMG(slug);
  node.alt = slug;
  if (cls) node.className = cls;
  node.loading = 'lazy';
  node.onerror = () => { node.style.visibility = 'hidden'; };
  return node;
}

function heroTile(key, onClick, extra) {
  const hero = HEROES[key];
  if (!hero) return null;
  const tile = el('button', 'tile');
  tile.type = 'button';
  tile.appendChild(img(key, 'tile-img'));
  tile.appendChild(el('span', 'tile-name', hero.name));
  tile.title = hero.ru;
  if (onClick) tile.addEventListener('click', onClick);
  if (extra) tile.appendChild(el('span', 'tile-badge', extra));
  return tile;
}

// ─────────────────────────── Вкладки ───────────────────────────

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    $('view-' + tab.dataset.view).classList.add('active');
  });
});

// ─────────────────────────── Драфт ───────────────────────────

function enemyTarget(side) {
  return side === 'dire' ? 'radiantPicks' : 'direPicks';
}

function setSide(side) {
  draft.side = side;
  document.querySelectorAll('.side-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.side === side);
  });
  target = enemyTarget(side);
  document.querySelectorAll('.target').forEach((b) => {
    b.classList.toggle('active', b.dataset.target === target);
  });
  renderGrid();
  schedule();
}

document.querySelectorAll('.side-btn').forEach((b) => {
  b.addEventListener('click', () => setSide(b.dataset.side));
});

document.querySelectorAll('.target').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.target').forEach((t) => t.classList.remove('active'));
    b.classList.add('active');
    target = b.dataset.target;
  });
});

$('search').addEventListener('input', (e) => {
  query = e.target.value.trim().toLowerCase();
  renderGrid();
});

$('search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const first = filteredKeys()[0];
  if (first) {
    addHero(first);
    e.target.select();
  }
});

$('resetBtn').addEventListener('click', () => {
  draft.ownHero = null;
  draft.radiantPicks = [];
  draft.radiantBans = [];
  draft.direPicks = [];
  draft.direBans = [];
  renderPicked();
  schedule();
});

function filteredKeys() {
  return Object.keys(HEROES)
    .filter((key) => {
      const h = HEROES[key];
      if (!query) return true;
      return h.name.toLowerCase().includes(query) || h.ru.toLowerCase().includes(query) || key.includes(query);
    })
    .sort((a, b) => HEROES[a].name.localeCompare(HEROES[b].name));
}

function renderGrid() {
  const grid = $('grid');
  grid.innerHTML = '';
  for (const key of filteredKeys()) {
    const node = heroTile(key, () => addHero(key));
    if (node) grid.appendChild(node);
  }
  if (!grid.children.length) grid.appendChild(el('p', 'muted', 'Ничего не найдено.'));
}

function addHero(key) {
  if (!HEROES[key]) return;
  const list = draft[target];
  if (list.includes(key)) return;
  const limit = target.endsWith('Picks') ? 5 : 7;
  if (list.length >= limit) return;
  list.push(key);
  renderPicked();
  schedule();
}

function removeHero(field, key) {
  draft[field] = draft[field].filter((k) => k !== key);
  renderPicked();
  schedule();
}

function renderPicked() {
  const box = $('picked');
  box.innerHTML = '';

  const groups = [
    ['radiantPicks', 'Radiant · пики'],
    ['direPicks', 'Dire · пики'],
    ['radiantBans', 'Radiant · баны'],
    ['direBans', 'Dire · баны'],
  ];

  const any = groups.some(([g]) => draft[g].length);
  if (!any) {
    box.appendChild(el('p', 'muted', 'Пока пусто. Отметь героев в сетке слева — начнём с врагов.'));
    return;
  }

  for (const [field, label] of groups) {
    if (!draft[field].length) continue;
    const row = el('div', 'chip-row');
    row.appendChild(el('span', 'chip-label', label));
    for (const key of draft[field]) {
      const chip = el('span', 'chip');
      if (HEROES[key]) chip.appendChild(img(key, 'chip-img'));
      chip.appendChild(el('span', '', HEROES[key] ? HEROES[key].name : key));
      const x = el('button', 'chip-x', '✕');
      x.type = 'button';
      x.title = 'Убрать';
      x.addEventListener('click', () => removeHero(field, key));
      chip.appendChild(x);
      row.appendChild(chip);
    }
    box.appendChild(row);
  }
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(recompute, 150);
}

async function recompute() {
  try {
    const res = await fetch('/api/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const snap = await res.json();
    renderRecs(snap.recs);
    renderAnalysis(snap.recs);
  } catch (err) {
    $('recs').innerHTML = '';
    $('recs').appendChild(el('p', 'error', 'Не удалось посчитать драфт: ' + err.message));
  }
}

function renderRecs(recs) {
  const box = $('recs');
  box.innerHTML = '';

  const title = el('h2', 'section-title', 'Лучшие герои по позициям');
  box.appendChild(title);
  box.appendChild(el('p', 'muted', 'Позиция 1 — керри, 5 — фулл-саппорт. Очки учитывают контрпики, синергии и роли.'));

  const grid = el('div', 'pos-grid');
  for (let p = 1; p <= 5; p++) {
    const card = el('div', 'pos-card');
    card.appendChild(el('div', 'pos-title', `Позиция ${p}`));
    const list = el('div', 'pos-list');
    for (const hero of recs.positions[p] || []) {
      const row = el('div', 'pos-row');
      row.appendChild(img(hero.key, 'pos-img'));
      const text = el('div', 'pos-text');
      text.appendChild(el('div', 'pos-name', hero.name));
      const hints = [];
      if (hero.countersVs.length) hints.push('контрит: ' + hero.countersVs.map((k) => (HEROES[k] || {}).name || k).join(', '));
      if (hero.synWith.length) hints.push('синергия: ' + hero.synWith.map((k) => (HEROES[k] || {}).name || k).join(', '));
      if (hints.length) text.appendChild(el('div', 'pos-hint', hints.join(' · ')));
      row.appendChild(text);
      row.appendChild(el('div', 'pos-score', String(hero.score)));
      list.appendChild(row);
    }
    if (!list.children.length) list.appendChild(el('p', 'muted', 'Все герои на этой позиции уже заняты.'));
    card.appendChild(list);
    grid.appendChild(card);
  }
  box.appendChild(grid);
}

function renderAnalysis(recs) {
  const box = $('analysis');
  box.innerHTML = '';
  const grid = el('div', 'analysis-grid');

  grid.appendChild(listBlock('🔒 Кого банить', (recs.bans || []).map((b) => ({
    title: b.name,
    hint: b.reasons.join(', '),
  }))));

  grid.appendChild(listBlock('⚠ Угрозы', (recs.threats || []).map((t) => ({
    title: t.name,
    hint: 'бьёт: ' + t.vs.map((k) => (HEROES[k] || {}).name || k).join(', '),
  }))));

  const comp = el('div', 'analysis-col');
  comp.appendChild(el('h3', 'col-title', '🧩 Состав'));
  const notes = el('div', 'col-body');
  for (const note of recs.composition.notes || []) notes.appendChild(el('div', 'comp-note', note));
  comp.appendChild(notes);
  grid.appendChild(comp);

  box.appendChild(grid);
}

function listBlock(title, rows) {
  const col = el('div', 'analysis-col');
  col.appendChild(el('h3', 'col-title', title));
  const body = el('div', 'col-body');
  if (!rows.length) body.appendChild(el('p', 'muted', 'Пока нечего показать.'));
  for (const row of rows) {
    const item = el('div', 'col-row');
    item.appendChild(el('span', 'col-name', row.title));
    if (row.hint) item.appendChild(el('span', 'col-hint', row.hint));
    body.appendChild(item);
  }
  col.appendChild(body);
  return col;
}

// ─────────────────────────── Матч ───────────────────────────

$('loadMatch').addEventListener('click', loadMatch);
$('matchId').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadMatch();
});

function parseMatchId(raw) {
  const text = String(raw || '').trim();
  const direct = text.match(/^\d{6,}$/);
  if (direct) return direct[0];
  const fromUrl = text.match(/(\d{6,})/);
  return fromUrl ? fromUrl[1] : null;
}

async function loadHeroConstants() {
  if (heroById) return heroById;
  const res = await fetch('/api/constants/heroes');
  if (!res.ok) throw new Error('Не удалось загрузить список героев.');
  heroById = await res.json();
  return heroById;
}

async function loadMatch() {
  const out = $('matchResult');
  out.innerHTML = '';
  const id = parseMatchId($('matchId').value);
  if (!id) {
    out.appendChild(el('p', 'error', 'Нужен числовой ID матча или ссылка с ним.'));
    return;
  }

  out.appendChild(el('p', 'muted', 'Загружаю матч…'));

  try {
    const [, constants, res] = await Promise.all([null, loadHeroConstants(), fetch('/api/match/' + id)]);
    if (!res.ok) {
      out.innerHTML = '';
      out.appendChild(el('p', 'error', res.status === 404
        ? 'Матч не найден или ещё не попал в OpenDota. Попробуй через пару минут.'
        : 'OpenDota ответила ' + res.status + '.'));
      return;
    }
    const match = await res.json();
    if (match.error) {
      out.innerHTML = '';
      out.appendChild(el('p', 'error', String(match.error)));
      return;
    }
    renderMatch(out, match, constants);
  } catch (err) {
    out.innerHTML = '';
    out.appendChild(el('p', 'error', 'Ошибка: ' + err.message));
  }
}

function renderMatch(out, match, constants) {
  out.innerHTML = '';

  const report = matchFindings(match);
  const radiantWin = Boolean(match.radiant_win);

  const head = el('div', 'match-head');
  const title = el('div', 'match-title');
  title.appendChild(el('span', 'match-result ' + (radiantWin ? 'win' : 'lose'), radiantWin ? 'Победа Radiant' : 'Победа Dire'));
  title.appendChild(el('span', 'muted', `${formatDuration(match.duration)} · матч ${match.match_id}`));
  head.appendChild(title);
  head.appendChild(el('div', 'match-score', `${match.radiant_score ?? '—'} : ${match.dire_score ?? '—'}`));
  out.appendChild(head);

  if (report.notes.length) {
    const notes = el('div', 'match-notes');
    for (const note of report.notes) notes.appendChild(el('div', 'comp-note', note));
    out.appendChild(notes);
  }

  for (const team of [true, false]) {
    const players = report.players.filter((p) => p.isRadiant === team);
    if (!players.length) continue;

    const section = el('div', 'team-block');
    section.appendChild(el('h3', 'col-title', team ? 'Radiant' : 'Dire'));

    const table = el('div', 'player-table');
    for (const p of players.sort((a, b) => b.gpm - a.gpm)) {
      const row = el('div', 'player-row' + (p.win ? ' won' : ''));

      const slug = heroSlug(constants, p.heroId);
      if (slug) row.appendChild(img(slug, 'player-img'));
      else row.appendChild(el('div', 'player-img'));

      const main = el('div', 'player-main');
      main.appendChild(el('div', 'player-name', heroName(constants, p.heroId)));
      main.appendChild(el('div', 'player-findings', p.findings.length ? p.findings.join(' · ') : 'без явных провалов'));
      row.appendChild(main);

      row.appendChild(statBlock('KDA', `${p.kills}/${p.deaths}/${p.assists}`));
      row.appendChild(statBlock('GPM', String(p.gpm)));
      row.appendChild(statBlock('XPM', String(p.xpm)));
      row.appendChild(statBlock('LH/D', `${p.lastHits}/${p.denies}`));
      row.appendChild(statBlock('Урон', `${Math.round(p.heroDamage / 1000)}k`));

      table.appendChild(row);
    }
    section.appendChild(table);
    out.appendChild(section);
  }
}

function statBlock(label, value) {
  const box = el('div', 'stat');
  box.appendChild(el('span', 'stat-label', label));
  box.appendChild(el('span', 'stat-value', value));
  return box;
}

// ─────────────────────────── Старт ───────────────────────────

(async function init() {
  try {
    const res = await fetch('/api/heroes');
    const data = await res.json();
    for (const h of data.heroes) HEROES[h.key] = h;
    renderGrid();
    renderPicked();
    recompute();
  } catch (err) {
    $('recs').appendChild(el('p', 'error', 'Не удалось загрузить героев: ' + err.message));
  }
})();
