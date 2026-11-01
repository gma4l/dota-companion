'use strict';

/*
 * Автоматический разбор после матча.
 *
 * Dota 2 в конце игры присылает через GSI состояние POST_GAME и номер матча
 * (map.matchid). OpenDota публикует матч не сразу, поэтому модуль:
 *
 *   1. ловит переход в POST_GAME и запоминает matchid;
 *   2. периодически спрашивает OpenDota, появился ли матч;
 *   3. отдаёт интерфейсу статус: ждём / готово / не дождались.
 *
 * Логика отделена от сети: observe() и check() можно тестировать
 * с подставным fetchMatch.
 */

const { fetchTls12 } = require('./net');

const POST_GAME = 'DOTA_GAMERULES_STATE_POST_GAME';
const MAX_ATTEMPTS = 30;
const CHECK_INTERVAL_MS = 20000;
const OPENDOTA = 'https://api.opendota.com/api';

/** Новое состояние наблюдателя. */
function createWatch() {
  return {
    matchId: null,
    gameState: null,
    finishedAt: null,
    status: 'idle', // idle | waiting | ready | error
    attempts: 0,
    lastCheckAt: null,
    error: null,
    checking: false,
  };
}

/**
 * Разбирает GSI-пейлоад и, если матч закончился, начинает слежение.
 *
 * @returns {boolean} true, если начали следить за новым матчем
 */
function observe(watch, payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object') return false;

  const map = payload.map || {};
  if (map.game_state) watch.gameState = map.game_state;

  if (map.game_state !== POST_GAME) return false;

  const matchId = Number(map.matchid || 0);
  if (!Number.isFinite(matchId) || matchId <= 0) return false;

  // Уже следим или уже разобрали этот матч — не начинаем заново.
  if (watch.matchId === matchId && watch.status !== 'idle') return false;

  watch.matchId = matchId;
  watch.finishedAt = now;
  watch.status = 'waiting';
  watch.attempts = 0;
  watch.lastCheckAt = null;
  watch.error = null;
  return true;
}

/** Запрос матча у OpenDota. null — матч ещё не опубликован. */
async function fetchMatchFromOpenDota(matchId) {
  const res = await fetchTls12(`${OPENDOTA}/matches/${matchId}`, {
    signal: AbortSignal.timeout(15000),
  });

  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`OpenDota ответила ${res.status}.`);

  const data = await res.json();
  if (!data || data.error || !Array.isArray(data.players)) return null;
  return data;
}

/**
 * Одна попытка проверки. Меняет watch по месту.
 *
 * @param {object} watch
 * @param {object} [options]
 * @param {Function} [options.fetchMatch] — подмена запроса в тестах
 * @param {Function} [options.now]
 * @param {number} [options.maxAttempts]
 */
async function check(watch, options = {}) {
  if (watch.status !== 'waiting' || watch.checking) return watch;

  const fetchMatch = options.fetchMatch || fetchMatchFromOpenDota;
  const now = options.now || Date.now;
  const maxAttempts = options.maxAttempts || MAX_ATTEMPTS;

  if (watch.attempts >= maxAttempts) {
    watch.status = 'error';
    watch.error = watch.error || 'OpenDota так и не отдала этот матч.';
    return watch;
  }

  watch.checking = true;
  watch.attempts += 1;
  watch.lastCheckAt = now();

  try {
    const match = await fetchMatch(watch.matchId);
    if (match) {
      watch.status = 'ready';
      watch.error = null;
    } else if (watch.attempts >= maxAttempts) {
      watch.status = 'error';
      watch.error = 'OpenDota так и не отдала этот матч.';
    }
  } catch (err) {
    watch.error = String((err && err.message) || err);
    if (watch.attempts >= maxAttempts) watch.status = 'error';
  } finally {
    watch.checking = false;
  }

  return watch;
}

/** Сериализуемое состояние для интерфейса. */
function snapshot(watch) {
  return {
    status: watch.status,
    matchId: watch.matchId,
    finishedAt: watch.finishedAt,
    attempts: watch.attempts,
    maxAttempts: MAX_ATTEMPTS,
    lastCheckAt: watch.lastCheckAt,
    error: watch.error,
  };
}

/** Скрыть уведомление и забыть матч. */
function dismiss(watch) {
  watch.matchId = null;
  watch.status = 'idle';
  watch.attempts = 0;
  watch.lastCheckAt = null;
  watch.error = null;
  watch.finishedAt = null;
  return watch;
}

module.exports = {
  POST_GAME,
  MAX_ATTEMPTS,
  CHECK_INTERVAL_MS,
  createWatch,
  observe,
  check,
  snapshot,
  dismiss,
  fetchMatchFromOpenDota,
};
