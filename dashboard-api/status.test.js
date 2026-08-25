'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  collectAgrobot,
  collectServices,
  collectStatus,
} = require('./status');

const GENERATED_AT = '2026-08-24T12:00:00.000Z';
const SYSTEMCTL_PROPERTIES = '--property=LoadState,ActiveState,SubState,ActiveEnterTimestamp';
const PSQL_ARGS = [
  '-X',
  '-A',
  '-t',
  '-F',
  '\t',
  '-d',
  'agrobot',
  '-c',
  'SELECT brand, count(*)::int, count(*) FILTER (WHERE is_critical)::int FROM public.equipment_reviews GROUP BY brand ORDER BY count(*) DESC, brand ASC',
];

const SERVICE_FIXTURES = new Map([
  ['agrobot.service', 'LoadState=loaded\nActiveState=active\nSubState=running\nActiveEnterTimestamp=Sun 2026-08-24 11:59:00 UTC\n'],
  ['console-bot.service', 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nActiveEnterTimestamp=\n'],
  ['bot_skaner.service', 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nActiveEnterTimestamp=\n'],
  ['agro_reviews_bridge.service', 'LoadState=loaded\nActiveState=active\nSubState=running\nActiveEnterTimestamp=Sun 2026-08-24 11:58:00 UTC\n'],
  ['postgresql.service', 'LoadState=loaded\nActiveState=active\nSubState=exited\nActiveEnterTimestamp=Sun 2026-08-24 11:57:00 UTC\n'],
  ['agy-proxy.service', 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nActiveEnterTimestamp=\n'],
  ['freelance-hunter-bot.service', 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nActiveEnterTimestamp=\n'],
  ['phoenix-radar.service', 'LoadState=loaded\nActiveState=active\nSubState=running\nActiveEnterTimestamp=Sun 2026-08-24 11:56:00 UTC\n'],
  ['phoenix-bot-go.service', 'LoadState=loaded\nActiveState=inactive\nSubState=failed\nActiveEnterTimestamp=\n'],
  ['opencode-serve.service', 'LoadState=loaded\nActiveState=active\nSubState=running\nActiveEnterTimestamp=Sun 2026-08-24 11:55:00 UTC\n'],
  ['antigravity-vectordb.service', 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nActiveEnterTimestamp=\n'],
]);

test('maps every fixed systemd unit and invokes only the fixed show arguments', async () => {
  const calls = [];
  const result = await collectServices(async (args) => {
    calls.push(args);
    return SERVICE_FIXTURES.get(args[1]);
  });

  assert.deepEqual(calls, [...SERVICE_FIXTURES.keys()].map((unit) => [
    'show', unit, SYSTEMCTL_PROPERTIES, '--no-pager',
  ]));
  assert.deepEqual(result.services, [
    { key: 'agrobot', name: 'AgroBot (@AgroLogic24Bot)', icon: '🤖', status: 'online' },
    { key: 'archi', name: 'Арчи (@ConsoIe_bot)', icon: '🧠', status: 'offline' },
    { key: 'bot_skaner', name: 'bot_skaner (@radiokowtun)', icon: '📡', status: 'not_migrated' },
    { key: 'reviews_bridge', name: 'agro_reviews_bridge', icon: '🌾', status: 'online' },
    { key: 'postgresql', name: 'PostgreSQL 15', icon: '🗄️', status: 'online' },
    { key: 'antigravity_proxy', name: 'Antigravity Proxy :18080', icon: '🔄', status: 'offline' },
    { key: 'freelance_hunter', name: 'freelance-hunter-bot', icon: '💼', status: 'not_migrated' },
    { key: 'phoenix_radar', name: 'phoenix-radar', icon: '🕊️', status: 'online' },
    { key: 'phoenix_bot', name: 'phoenix-bot-go', icon: '⛪', status: 'offline' },
    { key: 'opencode', name: 'opencode-serve', icon: '💻', status: 'online' },
    { key: 'vector_db', name: 'Antigravity VectorDB', icon: '📊', status: 'not_migrated' },
  ]);
});

test('maps every non-empty loaded non-active state offline and malformed output unknown', async () => {
  const result = await collectServices(async (args) => {
    if (args[1] === 'agrobot.service') throw new Error('systemctl-secret');
    if (args[1] === 'console-bot.service') {
      return 'LoadState=loaded\nActiveState=secret-state\nSubState=secret-substate\nActiveEnterTimestamp=\n';
    }
    if (args[1] === 'bot_skaner.service') {
      return 'LoadState=loaded\nActiveState=\nSubState=dead\nActiveEnterTimestamp=\n';
    }
    if (args[1] === 'agro_reviews_bridge.service') {
      return 'LoadState=loaded\nSubState=running\nActiveEnterTimestamp=\n';
    }
    return SERVICE_FIXTURES.get(args[1]);
  });

  assert.equal(result.services[0].status, 'unknown');
  assert.equal(result.services[1].status, 'offline');
  assert.equal(result.services[2].status, 'unknown');
  assert.equal(result.services[3].status, 'unknown');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('returns at most the three most recent sanitized active transitions', async () => {
  const result = await collectServices(async (args) => SERVICE_FIXTURES.get(args[1]));

  assert.deepEqual(result.events, [
    { at: '2026-08-24T11:59:00.000Z', category: 'service_status', service: 'agrobot', status: 'online' },
    { at: '2026-08-24T11:58:00.000Z', category: 'service_status', service: 'reviews_bridge', status: 'online' },
    { at: '2026-08-24T11:57:00.000Z', category: 'service_status', service: 'postgresql', status: 'online' },
  ]);
});

test('parses fixed AgroBot aggregate rows and emits the fixed read-only query arguments', async () => {
  let seenArgs;
  const result = await collectAgrobot(async (args) => {
    seenArgs = args;
    return 'HORSCH\t11\t4\nJohn Deere\t10\t4\n';
  });

  assert.deepEqual(seenArgs, PSQL_ARGS);
  assert.deepEqual(result, {
    totalReviews: 21,
    brands: [
      { name: 'HORSCH', count: 11, critical: 4 },
      { name: 'John Deere', count: 10, critical: 4 },
    ],
  });
});

test('rejects malformed AgroBot rows without reflecting database output', async () => {
  const malformedRows = [
    'private-brand\t1.5\t0\n',
    'private-brand\t1\tnan\n',
    'private-brand\t1\t0\textra\n',
    'private-brand\t-1\t0\n',
    'private-brand\t1\t2\n',
    `${Array.from({ length: 101 }, (_, index) => `private-${index}\t1\t0`).join('\n')}\n`,
    `${'private-brand'.repeat(6000)}\t1\t0\n`,
  ];

  for (const row of malformedRows) {
    await assert.rejects(collectAgrobot(async () => row), (error) => (
      error.code === 'AGROBOT_COLLECTION_FAILED' && !String(error).includes('private')
    ));
  }
});

test('composes all healthy collectors into one generated response', async () => {
  const server = { uptimeSeconds: 42 };
  const processes = [{ key: 'other', memoryMB: 1 }];
  const services = [{ key: 'agrobot', status: 'online' }];
  const agrobot = { totalReviews: 21, brands: [] };
  const events = [{ at: '2026-08-24T11:59:00.000Z', category: 'service_status', service: 'agrobot', status: 'online' }];

  const result = await collectStatus({
    now: () => new Date(GENERATED_AT),
    collectServer: async () => server,
    collectProcesses: async () => processes,
    collectServices: async () => ({ services, events }),
    collectAgrobot: async () => agrobot,
  });

  assert.deepEqual(result, { generatedAt: GENERATED_AT, server, processes, services, agrobot, events });
});

test('keeps healthy sections when collectors fail and emits only fixed error categories', async () => {
  const result = await collectStatus({
    now: () => new Date(GENERATED_AT),
    collectServer: async () => { throw new Error('server-secret'); },
    collectProcesses: async () => [{ key: 'healthy' }],
    collectServices: async () => { throw new Error('service-secret'); },
    collectAgrobot: async () => { throw new Error('database-secret'); },
  });

  assert.deepEqual(result, {
    generatedAt: GENERATED_AT,
    server: null,
    processes: [{ key: 'healthy' }],
    services: [],
    agrobot: { totalReviews: 0, brands: [] },
    events: [
      { at: GENERATED_AT, category: 'server_collection_failed' },
      { at: GENERATED_AT, category: 'services_collection_failed' },
      { at: GENERATED_AT, category: 'agrobot_collection_failed' },
    ],
  });
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('uses empty processes for a process-only failure', async () => {
  const result = await collectStatus({
    now: () => new Date(GENERATED_AT),
    collectServer: async () => ({ uptimeSeconds: 1 }),
    collectProcesses: async () => { throw new Error('process-secret'); },
    collectServices: async () => ({ services: [], events: [] }),
    collectAgrobot: async () => ({ totalReviews: 0, brands: [] }),
  });

  assert.deepEqual(result.processes, []);
  assert.deepEqual(result.events, [{ at: GENERATED_AT, category: 'processes_collection_failed' }]);
  assert.equal(JSON.stringify(result).includes('process-secret'), false);
});

test('orders and caps combined transitions and collector failures at three events', async () => {
  const transitions = [
    { at: '2026-08-24T11:57:00.000Z', category: 'service_status', service: 'postgresql', status: 'online' },
    { at: '2026-08-24T11:59:00.000Z', category: 'service_status', service: 'agrobot', status: 'online' },
    { at: '2026-08-24T11:58:00.000Z', category: 'service_status', service: 'reviews_bridge', status: 'online' },
  ];
  const combined = await collectStatus({
    now: () => new Date(GENERATED_AT),
    collectServer: async () => { throw new Error('server-secret'); },
    collectProcesses: async () => { throw new Error('process-secret'); },
    collectServices: async () => ({ services: [], events: transitions }),
    collectAgrobot: async () => ({ totalReviews: 0, brands: [] }),
  });

  assert.deepEqual(combined.events, [
    { at: GENERATED_AT, category: 'server_collection_failed' },
    { at: GENERATED_AT, category: 'processes_collection_failed' },
    { at: '2026-08-24T11:59:00.000Z', category: 'service_status', service: 'agrobot', status: 'online' },
  ]);

  const allFailed = await collectStatus({
    now: () => new Date(GENERATED_AT),
    collectServer: async () => { throw new Error('server-secret'); },
    collectProcesses: async () => { throw new Error('process-secret'); },
    collectServices: async () => { throw new Error('service-secret'); },
    collectAgrobot: async () => { throw new Error('agrobot-secret'); },
  });

  assert.deepEqual(allFailed.events, [
    { at: GENERATED_AT, category: 'server_collection_failed' },
    { at: GENERATED_AT, category: 'processes_collection_failed' },
    { at: GENERATED_AT, category: 'services_collection_failed' },
  ]);
  assert.equal(JSON.stringify([combined, allFailed]).includes('secret'), false);
});
