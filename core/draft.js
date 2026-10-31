'use strict';

/*
 * Движок драфта Dota 2: состояние, разбор GSI, рекомендации.
 *
 * Чистая логика без HTTP и файлов — одинаково работает в локальном
 * сервере (Node) и в публичной версии (Cloudflare Worker).
 */

const { HEROES, COUNTERED_BY, resolveClass } = require('./heroes');

const round1 = (x) => Math.round(x * 10) / 10;

/** Новое пустое состояние драфта. */
function createState(overrides = {}) {
  return {
    connected: false,
    gameState: null,
    side: null, // 'radiant' | 'dire' | null
    radiant: { picks: [], bans: [] },
    dire: { picks: [], bans: [] },
    pickPhase: null, // true = пик, false = бан
    activeTeam: null, // 2 | 3
    lastUpdate: null,
    ...overrides,
  };
}

/** Очищает пики и баны, не трогая подключение и сторону. */
function resetDraft(state) {
  state.radiant = { picks: [], bans: [] };
  state.dire = { picks: [], bans: [] };
  state.pickPhase = null;
  state.activeTeam = null;
  return state;
}

/** Приводит список героев к ключам базы, убирая неизвестных. */
function normHeroList(list) {
  const out = [];
  for (const item of list || []) {
    const key = resolveClass(item);
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * Разбирает GSI-пейлоад.
 * В Captains Mode приходит объект draft; в All Pick его нет —
 * тогда обновляются только сторона и состояние игры.
 */
function applyGsi(state, payload) {
  if (!payload) return state;

  const draft = payload.draft;
  if (draft) {
    const t2 = draft.team2 || {};
    const t3 = draft.team3 || {};

    const radiantPicks = [];
    const radiantBans = [];
    const direPicks = [];
    const direBans = [];

    for (let i = 0; i < 5; i++) {
      const p2 = t2[`pick${i}_class`];
      const p3 = t3[`pick${i}_class`];
      if (p2) radiantPicks.push(p2);
      if (p3) direPicks.push(p3);
    }
    for (let i = 0; i < 7; i++) {
      const b2 = t2[`ban${i}_class`];
      const b3 = t3[`ban${i}_class`];
      if (b2) radiantBans.push(b2);
      if (b3) direBans.push(b3);
    }

    state.radiant = { picks: normHeroList(radiantPicks), bans: normHeroList(radiantBans) };
    state.dire = { picks: normHeroList(direPicks), bans: normHeroList(direBans) };
    state.pickPhase = typeof draft.pick === 'boolean' ? draft.pick : null;
    state.activeTeam = draft.activeteam || null;
    state.connected = true;
    state.lastUpdate = Date.now();
  }

  const gameState = payload.map && payload.map.game_state;
  if (gameState) {
    state.gameState = gameState;
    state.lastUpdate = Date.now();
  }

  const pname = payload.player && payload.player.team_name;
  if (pname === 'radiant' || pname === 'dire') {
    state.side = pname;
  }

  // В All Pick игра не присылает draft, но сообщает твоего героя.
  // Это позволяет отметить свой пик автоматически.
  const heroName = payload.hero && payload.hero.name;
  const own = resolveClass(heroName);
  if (own) {
    state.ownHero = own;
    if (state.side) {
      const team = state.side === 'radiant' ? state.radiant : state.dire;
      if (!team.picks.includes(own)) team.picks.push(own);
    }
  }

  return state;
}

/** Ручной ввод (демо-режим и All Pick). */
function applyManual(state, body = {}) {
  resetDraft(state);
  state.side = body.side === 'dire' ? 'dire' : 'radiant';
  state.radiant = {
    picks: normHeroList(body.radiantPicks),
    bans: normHeroList(body.radiantBans),
  };
  state.dire = {
    picks: normHeroList(body.direPicks),
    bans: normHeroList(body.direBans),
  };
  state.ownHero = resolveClass(body.ownHero) || state.ownHero || null;
  state.connected = false;
  state.lastUpdate = Date.now();
  return state;
}

function alliesAndEnemies(state) {
  const side = state.side || 'radiant';
  return {
    side,
    allies: side === 'radiant' ? state.radiant.picks : state.dire.picks,
    enemies: side === 'radiant' ? state.dire.picks : state.radiant.picks,
  };
}

/**
 * Топ-5 героев на каждую позицию с учётом контрпиков, синергий и ролей.
 */
function computeRecommendations(state) {
  const { side, allies, enemies } = alliesAndEnemies(state);
  const allTaken = new Set([
    ...state.radiant.picks, ...state.dire.picks,
    ...state.radiant.bans, ...state.dire.bans,
  ]);

  const positions = {};
  for (let p = 1; p <= 5; p++) {
    const scored = [];

    for (const [key, h] of Object.entries(HEROES)) {
      if (allTaken.has(key)) continue;
      if (!h.roles.includes(p)) continue;

      let counter = 0;
      const countersVs = []; // кого из врагов этот герой контрит
      const counteredBy = []; // кто из врагов контрит этого героя
      for (const e of enemies) {
        if (h.counters.includes(e)) { counter += 2; countersVs.push(e); }
        if ((COUNTERED_BY[key] || []).includes(e)) { counter -= 2; counteredBy.push(e); }
      }

      let synergy = 0;
      const synWith = [];
      for (const a of allies) {
        if (h.synergy.includes(a)) { synergy += 1.5; synWith.push(a); }
      }

      // универсальность: закрывает сразу несколько проблем драфта
      let versatility = 0;
      if (countersVs.length >= 2) versatility += 1;
      if (synWith.length >= 2) versatility += 0.5;

      const roleBonus = h.roles[0] === p ? 2 : 1;

      scored.push({
        key, name: h.name, ru: h.ru, attr: h.attr, roles: h.roles,
        score: round1(counter + synergy + roleBonus + versatility),
        countersVs, counteredBy, synWith,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    positions[p] = scored.slice(0, 5);
  }

  return {
    side, allies, enemies, positions,
    bans: computeBans(allies, enemies, allTaken),
    threats: computeThreats(allies, enemies),
    composition: computeComposition(allies),
  };
}

/** Кого забанить: герои, которые контрят твою команду или усиляют врага. */
function computeBans(allies, enemies, allTaken) {
  const scored = [];
  for (const [key, h] of Object.entries(HEROES)) {
    if (allTaken.has(key)) continue;
    let score = 0;
    const reasons = [];
    for (const a of allies) {
      if (h.counters.includes(a)) { score += 2; reasons.push('бьёт ' + HEROES[a].name); }
    }
    for (const e of enemies) {
      if (h.synergy.includes(e) || (HEROES[e] && HEROES[e].synergy.includes(key))) {
        score += 1.5; reasons.push('усилит ' + HEROES[e].name);
      }
    }
    if (score > 0) {
      scored.push({
        key, name: h.name, ru: h.ru, attr: h.attr,
        score: round1(score), reasons: [...new Set(reasons)].slice(0, 3),
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 7);
}

/** Угрозы: враги, которые контрят твоих героев. */
function computeThreats(allies, enemies) {
  const threats = [];
  for (const e of enemies) {
    const eh = HEROES[e];
    if (!eh) continue;
    const vs = [];
    for (const a of allies) {
      if (eh.counters.includes(a)) vs.push(a);
    }
    if (vs.length) threats.push({ key: e, name: eh.name, ru: eh.ru, attr: eh.attr, vs });
  }
  return threats;
}

/** Анализ состава: закрытые позиции, атрибуты, дыры. */
function computeComposition(allies) {
  const roleCoverage = { 1: false, 2: false, 3: false, 4: false, 5: false };
  const attrCount = { str: 0, agi: 0, int: 0 };
  for (const a of allies) {
    const h = HEROES[a];
    if (!h) continue;
    for (const r of h.roles) roleCoverage[r] = true;
    attrCount[h.attr] = (attrCount[h.attr] || 0) + 1;
  }

  const notes = [];
  if (allies.length === 0) {
    notes.push('Добавь своих героев — анализ состава появится.');
  } else {
    if (attrCount.str === 0) notes.push('Нет героя-силача — команда без фронтлайна.');
    if (attrCount.int === 0) notes.push('Нет героя-интеллекта — мало магии и контроля.');
    const missing = [1, 2, 3, 4, 5].filter((p) => !roleCoverage[p]);
    if (missing.length) notes.push('Свободные позиции: ' + missing.join(', ') + '.');
    if (!missing.length) notes.push('Все позиции закрыты.');
  }

  return { roleCoverage, attrCount, notes };
}

/** Пейлоад для GET /api/state. */
function snapshot(state) {
  return {
    connected: state.connected,
    gameState: state.gameState,
    side: state.side,
    ownHero: state.ownHero || null,
    pickPhase: state.pickPhase,
    activeTeam: state.activeTeam,
    lastUpdate: state.lastUpdate,
    radiant: state.radiant,
    dire: state.dire,
    recs: computeRecommendations(state),
  };
}

module.exports = {
  createState,
  resetDraft,
  normHeroList,
  applyGsi,
  applyManual,
  alliesAndEnemies,
  computeRecommendations,
  computeBans,
  computeThreats,
  computeComposition,
  snapshot,
};
