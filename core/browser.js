'use strict';

/*
 * Точка сборки для браузера.
 *
 * esbuild собирает этот файл в web/vendor/dota-core.js (IIFE, глобал DotaCore).
 * В браузере доступны те же функции, что и на сервере: расчёт драфта
 * происходит локально, без запросов к API.
 */

const draft = require('./draft');
const { heroList, HEROES } = require('./heroes');

module.exports = { ...draft, heroList, HEROES };
