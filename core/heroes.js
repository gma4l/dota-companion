'use strict';

/*
 * База героев и нормализация имён.
 *
 * Один источник правды для локального сервера и публичной версии:
 * здесь нет HTTP, только данные и чистые функции.
 */

const fs = require('node:fs');
const path = require('node:path');

const HEROES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'heroes.json'), 'utf8')
).heroes;

// Имена героев в GSI/API не всегда совпадают с ключами базы.
const CLASS_ALIASES = {
  bristleback: 'bristleback',
  nature_prophet: 'furion',
  furion: 'furion',
  windranger: 'windrunner',
  windrunner: 'windrunner',
  wraith_king: 'skeleton_king',
  skeleton_king: 'skeleton_king',
  lifestealer: 'life_stealer',
  life_stealer: 'life_stealer',
  doom: 'doom_bringer',
  doom_bringer: 'doom_bringer',
  clockwerk: 'rattletrap',
  rattletrap: 'rattletrap',
  timbersaw: 'shredder',
  shredder: 'shredder',
  shadow_fiend: 'nevermore',
  nevermore: 'nevermore',
  zeus: 'zuus',
  zuus: 'zuus',
  necrophos: 'necrolyte',
  necrolyte: 'necrolyte',
  outworld_destroyer: 'obsidian_destroyer',
  obsidian_destroyer: 'obsidian_destroyer',
  queen_of_pain: 'queenofpain',
  queenofpain: 'queenofpain',
  io: 'wisp',
  wisp: 'wisp',
  magnus: 'magnataur',
  magnataur: 'magnataur',
  treant_protector: 'treant',
  treant: 'treant',
  underlord: 'abyssal_underlord',
  abyssal_underlord: 'abyssal_underlord',
};

/** Приводит класс героя из GSI к ключу в heroes.json. */
function resolveClass(cls) {
  if (!cls) return null;
  const c = String(cls).toLowerCase().replace(/^npc_dota_hero_/, '').trim();
  if (HEROES[c]) return c;
  if (CLASS_ALIASES[c]) return CLASS_ALIASES[c];
  return null;
}

/** Убирает синонимы и дубликаты из списка героев. */
function canonicalizeList(list) {
  const out = [];
  for (const key of list || []) {
    const c = resolveClass(key) || key;
    if (c && HEROES[c] && !out.includes(c)) out.push(c);
  }
  return out;
}

// Списки в базе написаны вручную — приводим их к каноническим ключам один раз.
for (const hero of Object.values(HEROES)) {
  hero.counters = canonicalizeList(hero.counters);
  hero.synergy = canonicalizeList(hero.synergy);
}

// Обратный индекс: герой -> кто его контрит.
const COUNTERED_BY = {};
for (const [key, hero] of Object.entries(HEROES)) {
  for (const target of hero.counters) {
    (COUNTERED_BY[target] ||= []).push(key);
  }
}

function heroInfo(key) {
  const h = HEROES[key];
  if (!h) return null;
  return { key, name: h.name, ru: h.ru, attr: h.attr, roles: h.roles };
}

/** Короткий список для выпадающих меню и сетки героев. */
function heroList() {
  return Object.entries(HEROES).map(([key, h]) => heroInfo(key) || { key, ...h });
}

module.exports = {
  HEROES,
  CLASS_ALIASES,
  COUNTERED_BY,
  resolveClass,
  canonicalizeList,
  heroInfo,
  heroList,
};
