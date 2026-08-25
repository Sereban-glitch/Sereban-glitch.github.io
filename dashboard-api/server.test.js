'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const http = require('node:http');
const { after, before, test } = require('node:test');

const { createServer, startServer } = require('./server');

const ALLOWED_ORIGIN = 'https://sereban-glitch.github.io';
const BOT_TOKEN = '123456789:test-token-for-fixtures';
const NOW_SECONDS = 1787572860;
const statusFixture = {
  generatedAt: '2026-08-24T12:01:00.000Z',
  server: { uptimeSeconds: 42 },
  services: [],
};

function signedInitData(fields, botToken) {
  const params = new URLSearchParams(fields);
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

const validInitData = signedInitData({
  auth_date: '1787572800',
  user: '{"id":745130167}',
}, BOT_TOKEN);

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function withServer(options, callback) {
  const server = createServer({ botToken: BOT_TOKEN, now: () => NOW_SECONDS, ...options });
  const baseUrl = await listen(server);
  try {
    return await callback(baseUrl);
  } finally {
    await close(server);
  }
}

let server;
let baseUrl;

before(async () => {
  server = createServer({
    botToken: BOT_TOKEN,
    collectStatus: async () => statusFixture,
    now: () => NOW_SECONDS,
  });
  baseUrl = await listen(server);
});

after(async () => {
  await close(server);
});

function request(path, options = {}) {
  return fetch(`${baseUrl}${path}`, options);
}

test('serves authenticated GET /api/status requests with fixed security headers', async () => {
  const response = await request('/api/status', {
    headers: { authorization: `tma ${validInitData}` },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.deepEqual(await response.json(), statusFixture);
});

test('accepts preflight OPTIONS only for /api/status', async () => {
  const response = await request('/api/status', {
    method: 'OPTIONS',
    headers: { origin: ALLOWED_ORIGIN },
  });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  assert.equal(response.headers.get('access-control-allow-headers'), 'Authorization');
  assert.equal((await request('/other', { method: 'OPTIONS', headers: { origin: ALLOWED_ORIGIN } })).status, 404);
});

test('rejects missing or invalid authentication without exposing details', async () => {
  const missing = await request('/api/status');
  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), { error: 'unauthorized' });

  const invalid = await request('/api/status', {
    headers: { authorization: `tma ${validInitData.replace('745130167', '745130168')}` },
  });
  assert.equal(invalid.status, 401);
  assert.deepEqual(await invalid.json(), { error: 'unauthorized' });
});

test('rejects duplicate Authorization headers', async () => {
  const response = await new Promise((resolve, reject) => {
    const target = new URL('/api/status', baseUrl);
    const req = http.request(target, {
      headers: [
        'Host', target.host,
        'Authorization', `tma ${validInitData}`,
        'Authorization', `tma ${validInitData}`,
      ],
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });

  assert.equal(response.status, 401);
  assert.deepEqual(JSON.parse(response.body), { error: 'unauthorized' });
});

test('rejects wrong origins, unsupported methods, and unknown paths', async () => {
  assert.equal((await request('/api/status', {
    headers: { origin: 'https://attacker.example', authorization: `tma ${validInitData}` },
  })).status, 403);
  assert.equal((await request('/api/status', {
    method: 'POST',
    headers: { origin: ALLOWED_ORIGIN },
  })).status, 405);
  assert.equal((await request('/other', { headers: { origin: ALLOWED_ORIGIN } })).status, 404);
});

test('returns temporarily unavailable when collection fails or times out', async () => {
  for (const collectStatus of [
    async () => { throw new Error('collector failed'); },
    () => new Promise(() => {}),
  ]) {
    const response = await withServer({ collectStatus, collectTimeoutMs: 10 }, (url) => (
      fetch(`${url}/api/status`, {
        headers: { origin: ALLOWED_ORIGIN, authorization: `tma ${validInitData}` },
      })
    ));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'temporarily_unavailable' });
  }
});

test('starts the executable server with BOT_TOKEN, loopback, configured port, and injected collector', () => {
  const collector = async () => statusFixture;
  let createOptions;
  let listenArgs;
  const fakeServer = {
    listen(...args) {
      listenArgs = args;
      return this;
    },
  };

  const result = startServer({
    env: { BOT_TOKEN: BOT_TOKEN, PORT: '19000' },
    collectStatus: collector,
    create: (options) => {
      createOptions = options;
      return fakeServer;
    },
  });

  assert.equal(result, fakeServer);
  assert.deepEqual(createOptions, { botToken: BOT_TOKEN, collectStatus: collector });
  assert.deepEqual(listenArgs, ['19000', '127.0.0.1']);
});

test('direct startup without BOT_TOKEN fails before listening', () => {
  const env = { ...process.env };
  delete env.BOT_TOKEN;
  delete env.TELEGRAM_BOT_TOKEN;
  const result = spawnSync(process.execPath, [require.resolve('./server')], {
    env,
    encoding: 'utf8',
    timeout: 1000,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'BOT_TOKEN is required\n');
});
