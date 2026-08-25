'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  collectProcesses,
  collectServer,
  normalizeProcesses,
  parseLoadavg,
  parseMeminfo,
  parseUptime,
} = require('./collectors');

test('normalizes Linux resources to the dashboard schema', () => {
  assert.deepEqual(parseMeminfo('MemTotal: 8192000 kB\nMemAvailable: 6144000 kB\n'), {
    totalMB: 8000,
    usedMB: 2000,
    percent: 25,
  });
  assert.deepEqual(parseLoadavg('0.50 0.25 0.10 1/100 42\n', 4), {
    one: 0.5,
    five: 0.25,
    fifteen: 0.1,
    percent: 13,
  });
  assert.equal(parseUptime('9876.54 123.00\n'), 9876);
});

test('rejects malformed resource files without reflecting their contents', () => {
  for (const [parse, input, code] of [
    [parseMeminfo, 'MemTotal: secret kB\n', 'MALFORMED_MEMINFO'],
    [(text) => parseLoadavg(text, 0), 'secret 0.25 0.10', 'MALFORMED_LOADAVG'],
    [parseUptime, 'secret uptime', 'MALFORMED_UPTIME'],
  ]) {
    assert.throws(() => parse(input), (error) => {
      assert.equal(error.code, code);
      assert.equal(String(error).includes('secret'), false);
      return true;
    });
  }
});

test('rejects incomplete and nonnumeric Linux load and uptime fields', () => {
  for (const loadavg of [
    '0.50 0.25 0.10',
    '0.50 0.25 0.10 running/100 42',
    '0.50 0.25 0.10 1/total 42',
    '0.50 0.25 0.10 1/100 pid',
  ]) {
    assert.throws(() => parseLoadavg(loadavg, 4), (error) => error.code === 'MALFORMED_LOADAVG');
  }
  assert.throws(() => parseUptime('9876.54 idle'), (error) => error.code === 'MALFORMED_UPTIME');
});

test('rejects non-text resource inputs with collector-specific errors', () => {
  for (const [parse, code] of [
    [() => parseMeminfo(null), 'MALFORMED_MEMINFO'],
    [() => parseLoadavg(null, 1), 'MALFORMED_LOADAVG'],
    [() => parseUptime(null), 'MALFORMED_UPTIME'],
  ]) {
    assert.throws(parse, (error) => error.code === code);
  }
});

test('collects server resources from injected Linux inputs', async () => {
  const files = new Map([
    ['/proc/meminfo', 'MemTotal: 8192000 kB\nMemAvailable: 6144000 kB\n'],
    ['/proc/loadavg', '0.50 0.25 0.10 1/100 42\n'],
    ['/proc/uptime', '9876.54 123.00\n'],
  ]);
  const result = await collectServer({
    readFile: async (path) => files.get(path),
    statfs: async () => ({ blocks: 1000, bavail: 250, bsize: 1024 * 1024 }),
    cpuCount: 4,
  });

  assert.deepEqual(result, {
    memory: { totalMB: 8000, usedMB: 2000, percent: 25 },
    disk: { totalMB: 1000, usedMB: 750, percent: 75 },
    load: { one: 0.5, five: 0.25, fifteen: 0.1, percent: 13 },
    uptimeSeconds: 9876,
  });
});

test('handles a zero-sized disk and sanitizes resource dependency failures', async () => {
  const files = new Map([
    ['/proc/meminfo', 'MemTotal: 1024 kB\nMemAvailable: 1024 kB\n'],
    ['/proc/loadavg', '0 0 0 1/1 1\n'],
    ['/proc/uptime', '0 0\n'],
  ]);
  const zero = await collectServer({
    readFile: async (path) => files.get(path),
    statfs: async () => ({ blocks: 0, bavail: 0, bsize: 4096 }),
    cpuCount: 1,
  });
  assert.deepEqual(zero.disk, { totalMB: 0, usedMB: 0, percent: 0 });

  await assert.rejects(
    collectServer({
      readFile: async () => { throw new Error('source-secret'); },
      statfs: async () => ({ blocks: 0, bavail: 0, bsize: 1 }),
      cpuCount: 1,
    }),
    (error) => error.code === 'SERVER_COLLECTION_FAILED' && !String(error).includes('source-secret'),
  );
});

test('does not trust server dependency error codes when redacting failures', async () => {
  const error = new Error('reserved-code-secret');
  error.code = 'MALFORMED_MEMINFO';

  await assert.rejects(
    collectServer({
      readFile: async () => { throw error; },
      statfs: async () => ({ blocks: 0, bavail: 0, bsize: 1 }),
      cpuCount: 1,
    }),
    (caught) => caught.code === 'SERVER_COLLECTION_FAILED'
      && !String(caught).includes('reserved-code-secret'),
  );
});

test('maps known commands to fixed labels and never returns command arguments', () => {
  const result = normalizeProcesses([
    { name: 'node', cmdline: 'node\0/srv/console-bot/index.js\0--token\0super-secret', memoryKB: 1024 },
    { name: 'postgres', cmdline: 'postgres\0-D\0/private/database', memoryKB: 2048 },
    { name: 'mystery-secret-name', cmdline: '/private/unknown\0--password\0hidden', memoryKB: 512 },
  ]);

  assert.equal(JSON.stringify(result).includes('--token'), false);
  assert.equal(JSON.stringify(result).includes('super-secret'), false);
  assert.equal(JSON.stringify(result).includes('mystery-secret-name'), false);
  assert.deepEqual(result, [
    { key: 'postgres', name: 'PostgreSQL', detail: '1 process', memoryMB: 2, color: '#818cf8' },
    { key: 'console-bot', name: 'Арчи (console-bot)', detail: '1 process', memoryMB: 1, color: '#a78bfa' },
    { key: 'other', name: 'Прочее', detail: '1 process', memoryMB: 1, color: '#475569' },
  ]);
});

test('does not classify service names found only in command arguments', () => {
  const result = normalizeProcesses([
    { name: 'backup', cmdline: 'backup\0--target=postgres', memoryKB: 1024 },
    { name: 'worker', cmdline: 'worker\0/tmp/opencode/config.json', memoryKB: 2048 },
    { name: 'node', cmdline: 'node\0/srv/wrapper.js\0/srv/agrobot/input.json', memoryKB: 4096 },
  ]);

  assert.deepEqual(result, [
    { key: 'other', name: 'Прочее', detail: '3 processes', memoryMB: 7, color: '#475569' },
  ]);
});

test('groups all records, sorts named groups by memory, and keeps one other aggregate', () => {
  const records = [];
  for (let index = 0; index < 40; index += 1) {
    records.push({ name: `unknown-${index}`, cmdline: `unknown-${index}\0secret-${index}`, memoryKB: 1024 });
  }
  records.push(
    { name: 'opencode', cmdline: 'opencode\0serve', memoryKB: 3072 },
    { name: 'opencode', cmdline: 'opencode\0worker', memoryKB: 2048 },
    { name: 'agrobot', cmdline: '/srv/agrobot', memoryKB: 4096 },
  );

  assert.deepEqual(normalizeProcesses(records), [
    { key: 'opencode', name: 'OpenCode (IDE)', detail: '2 processes', memoryMB: 5, color: '#f472b6' },
    { key: 'agrobot', name: 'AgroBot', detail: '1 process', memoryMB: 4, color: '#38bdf8' },
    { key: 'other', name: 'Прочее', detail: '40 processes', memoryMB: 40, color: '#475569' },
  ]);
});

test('reads processes with concurrency bounded at 16 and tolerates vanished PIDs', async () => {
  let active = 0;
  let maximumActive = 0;
  const readFile = async (path) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;

    if (path === '/proc/7/status') {
      const error = new Error('vanished');
      error.code = 'ENOENT';
      throw error;
    }
    if (path.endsWith('/status')) return 'Name:\topencode\nVmRSS:\t1024 kB\n';
    return 'opencode\0serve\0--token\0must-not-leak';
  };

  const result = await collectProcesses({
    readdir: async () => [...Array.from({ length: 40 }, (_, index) => String(index + 1)), 'self', 'net'],
    readFile,
  });

  assert.equal(maximumActive <= 16, true);
  assert.deepEqual(result, [
    { key: 'opencode', name: 'OpenCode (IDE)', detail: '39 processes', memoryMB: 39, color: '#f472b6' },
    { key: 'other', name: 'Прочее', detail: '0 processes', memoryMB: 0, color: '#475569' },
  ]);
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
});

test('rejects malformed process status and unexpected read errors without leaking data', async () => {
  for (const readFile of [
    async (path) => path.endsWith('/status') ? 'Name:\tsecret-name\nVmRSS:\tsecret kB\n' : 'secret-command',
    async () => {
      const error = new Error('secret-read-error');
      error.code = 'EACCES';
      throw error;
    },
  ]) {
    await assert.rejects(
      collectProcesses({ readdir: async () => ['42'], readFile }),
      (error) => error.code === 'PROCESS_COLLECTION_FAILED' && !String(error).includes('secret'),
    );
  }
});

test('does not trust process dependency error codes when redacting failures', async () => {
  const error = new Error('reserved-code-secret');
  error.code = 'PROCESS_COLLECTION_FAILED';

  await assert.rejects(
    collectProcesses({ readdir: async () => { throw error; } }),
    (caught) => caught.code === 'PROCESS_COLLECTION_FAILED'
      && !String(caught).includes('reserved-code-secret'),
  );
});
