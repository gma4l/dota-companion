'use strict';

/*
 * Сетевой помощник для настольной версии.
 *
 * Зачем: в некоторых сетях (в т.ч. через DPI) TLS 1.3 от Node/OpenSSL
 * рвётся на этапе рукопожатия, а TLS 1.2 проходит. Поэтому наружу ходим
 * через https с явным TLS 1.2 и фолбэком на обычный fetch.
 *
 * Отключить:  FORCE_TLS12=0 node local/server.js
 */

const https = require('node:https');

const FORCE_TLS12 = process.env.FORCE_TLS12 !== '0';
const DEFAULT_TIMEOUT = 15000;

class MiniResponse {
  constructor(status, headers, body) {
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this.headers = headers || {};
    this._body = body;
  }

  async text() {
    return this._body;
  }

  async json() {
    return JSON.parse(this._body);
  }
}

/** GET через https с TLS 1.2 — только текст/JSON, без стриминга. */
function httpsGetJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'https:') {
      reject(new Error('httpsGetJson: нужен https URL'));
      return;
    }

    const req = https.get(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        headers: { Accept: 'application/json', ...(options.headers || {}) },
        minVersion: 'TLSv1.2',
        maxVersion: FORCE_TLS12 ? 'TLSv1.2' : undefined,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve(new MiniResponse(res.statusCode, res.headers, Buffer.concat(chunks).toString('utf8')));
        });
      }
    );

    const timeout = options.timeout || DEFAULT_TIMEOUT;
    req.setTimeout(timeout, () => req.destroy(new Error('Превышено время ожидания ответа.')));
    req.on('error', reject);

    if (options.signal) {
      if (options.signal.aborted) req.destroy(new Error('Запрос отменён.'));
      else options.signal.addEventListener('abort', () => req.destroy(new Error('Запрос отменён.')), { once: true });
    }
  });
}

/**
 * Замена fetch для внешних GET-запросов в настольной версии.
 * Сначала пробует TLS 1.2; если сервер его не поддерживает — обычный fetch.
 */
async function fetchTls12(url, options = {}) {
  const target = new URL(url);

  // Локальные адреса (Ollama) не трогаем: там обычный http.
  if (target.protocol !== 'https:') {
    return fetch(url, options);
  }

  try {
    return await httpsGetJson(url, options);
  } catch (err) {
    const code = (err && err.code) || '';
    if (code === 'EPROTO' || /protocol|version/i.test(String(err && err.message))) {
      return fetch(url, options);
    }
    throw err;
  }
}

/**
 * Подменяет глобальный fetch для локальной проверки публичной версии
 * (worker/dev.mjs). В продакшене не используется.
 */
function installFetchPolyfill() {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input && input.url;
    if (!url || !url.startsWith('https:')) return nativeFetch(input, init);
    return fetchTls12(url, {
      headers: init.headers,
      timeout: DEFAULT_TIMEOUT,
      signal: init.signal,
    });
  };
}

module.exports = { fetchTls12, httpsGetJson, installFetchPolyfill };
