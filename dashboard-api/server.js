'use strict';

const http = require('node:http');

const { validateInitData } = require('./auth');

const ALLOWED_ORIGIN = 'https://sereban-glitch.github.io';
const COLLECT_TIMEOUT_MS = 5000;

const RESPONSE_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, RESPONSE_HEADERS);
  response.end(JSON.stringify(body));
}

function countHeader(request, name) {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) {
      count += 1;
    }
  }
  return count;
}

function createServer({
  botToken,
  collectStatus,
  now = () => Math.floor(Date.now() / 1000),
  collectTimeoutMs = COLLECT_TIMEOUT_MS,
}) {
  return http.createServer({ joinDuplicateHeaders: true }, async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path !== '/api/status') {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }

    if (request.headers.origin && request.headers.origin !== ALLOWED_ORIGIN) {
      sendJson(response, 403, { error: 'forbidden' });
      return;
    }

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        ...RESPONSE_HEADERS,
        'Access-Control-Allow-Headers': 'Authorization',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      });
      response.end();
      return;
    }

    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'method_not_allowed' });
      return;
    }

    if (countHeader(request, 'authorization') !== 1) {
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }

    const authorization = request.headers.authorization;
    const match = typeof authorization === 'string' && /^tma (.+)$/.exec(authorization);
    if (!match) {
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }

    try {
      validateInitData(match[1], botToken, { nowSeconds: now() });
    } catch {
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }

    let timeout;
    try {
      const status = await Promise.race([
        Promise.resolve().then(collectStatus),
        new Promise((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('collection timeout')), collectTimeoutMs);
        }),
      ]);
      sendJson(response, 200, status);
    } catch {
      sendJson(response, 503, { error: 'temporarily_unavailable' });
    } finally {
      clearTimeout(timeout);
    }
  });
}

module.exports = { createServer };

if (require.main === module) {
  createServer({
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    collectStatus: async () => { throw new Error('collector unavailable'); },
  }).listen(18181, '127.0.0.1');
}
