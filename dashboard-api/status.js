'use strict';

const { spawn } = require('node:child_process');

const { collectProcesses, collectServer } = require('./collectors');

const COMMAND_TIMEOUT_MS = 3000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const SYSTEMCTL_PROPERTIES = '--property=LoadState,ActiveState,SubState,ActiveEnterTimestamp';
const SERVICE_MAP = [
  ['agrobot', 'AgroBot (@AgroLogic24Bot)', '🤖', 'agrobot.service'],
  ['archi', 'Арчи (@ConsoIe_bot)', '🧠', 'console-bot.service'],
  ['bot_skaner', 'bot_skaner (@radiokowtun)', '📡', 'bot_skaner.service'],
  ['reviews_bridge', 'agro_reviews_bridge', '🌾', 'agro_reviews_bridge.service'],
  ['postgresql', 'PostgreSQL 15', '🗄️', 'postgresql.service'],
  ['antigravity_proxy', 'Antigravity Proxy :18080', '🔄', 'agy-proxy.service'],
  ['freelance_hunter', 'freelance-hunter-bot', '💼', 'freelance-hunter-bot.service'],
  ['phoenix_radar', 'phoenix-radar', '🕊️', 'phoenix-radar.service'],
  ['phoenix_bot', 'phoenix-bot-go', '⛪', 'phoenix-bot-go.service'],
  ['opencode', 'opencode-serve', '💻', 'opencode-serve.service'],
  ['vector_db', 'Antigravity VectorDB', '📊', 'antigravity-vectordb.service'],
];
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

function collectionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function runCommand(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    let outputBytes = 0;
    let settled = false;

    function finish(error, stdout) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(collectionError('COMMAND_FAILED', 'Command failed'));
      else resolve(stdout);
    }

    function collect(chunk, keep) {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(true);
        return;
      }
      if (keep) chunks.push(chunk);
    }

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(true);
    }, COMMAND_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => collect(chunk, true));
    child.stderr.on('data', (chunk) => collect(chunk, false));
    child.once('error', () => finish(true));
    child.once('close', (code) => finish(code !== 0, Buffer.concat(chunks).toString('utf8')));
  });
}

function parseSystemctl(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_OUTPUT_BYTES) return null;
  const properties = new Map();
  for (const line of text.trimEnd().split('\n')) {
    const separator = line.indexOf('=');
    if (separator === -1) return null;
    const key = line.slice(0, separator);
    if (properties.has(key)) return null;
    properties.set(key, line.slice(separator + 1));
  }
  if (![...['LoadState', 'ActiveState', 'SubState', 'ActiveEnterTimestamp']]
    .every((property) => properties.has(property))) return null;

  const loadState = properties.get('LoadState');
  const activeState = properties.get('ActiveState');
  const subState = properties.get('SubState');
  if (!loadState || !activeState || !subState) return null;
  let status;
  if (loadState === 'not-found') status = 'not_migrated';
  else if (loadState !== 'loaded') return null;
  else if (activeState === 'active') status = 'online';
  else status = 'offline';

  let activeAt = null;
  const timestamp = properties.get('ActiveEnterTimestamp');
  if (status === 'online' && timestamp) {
    const milliseconds = Date.parse(timestamp.replace(/^\w{3}\s+/, ''));
    if (Number.isFinite(milliseconds)) activeAt = new Date(milliseconds).toISOString();
  }
  return { status, activeAt };
}

async function collectServices(runSystemctl = (args) => runCommand('/usr/bin/systemctl', args)) {
  const collected = await Promise.all(SERVICE_MAP.map(async ([key, name, icon, unit]) => {
    try {
      const parsed = parseSystemctl(await runSystemctl([
        'show', unit, SYSTEMCTL_PROPERTIES, '--no-pager',
      ]));
      if (!parsed) return { service: { key, name, icon, status: 'unknown' }, event: null };
      const event = parsed.activeAt ? {
        at: parsed.activeAt,
        category: 'service_status',
        service: key,
        status: parsed.status,
      } : null;
      return { service: { key, name, icon, status: parsed.status }, event };
    } catch {
      return { service: { key, name, icon, status: 'unknown' }, event: null };
    }
  }));

  return {
    services: collected.map(({ service }) => service),
    events: collected
      .map(({ event }) => event)
      .filter(Boolean)
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, 3),
  };
}

function parseAgrobot(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_OUTPUT_BYTES) {
    throw collectionError('AGROBOT_COLLECTION_FAILED', 'AgroBot collection failed');
  }
  const rows = text === '' ? [] : text.trimEnd().split('\n');
  if (rows.length > 100) {
    throw collectionError('AGROBOT_COLLECTION_FAILED', 'AgroBot collection failed');
  }

  const brands = rows.map((row) => {
    const columns = row.split('\t');
    if (columns.length !== 3 || !columns[0]
        || !/^(?:0|[1-9]\d*)$/.test(columns[1])
        || !/^(?:0|[1-9]\d*)$/.test(columns[2])) {
      throw collectionError('AGROBOT_COLLECTION_FAILED', 'AgroBot collection failed');
    }
    const count = Number(columns[1]);
    const critical = Number(columns[2]);
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(critical) || critical > count) {
      throw collectionError('AGROBOT_COLLECTION_FAILED', 'AgroBot collection failed');
    }
    return { name: columns[0], count, critical };
  });
  const totalReviews = brands.reduce((total, brand) => total + brand.count, 0);
  if (!Number.isSafeInteger(totalReviews)) {
    throw collectionError('AGROBOT_COLLECTION_FAILED', 'AgroBot collection failed');
  }
  return { totalReviews, brands };
}

async function collectAgrobot(runPsql = (args) => runCommand('/usr/bin/psql', args)) {
  try {
    return parseAgrobot(await runPsql(PSQL_ARGS));
  } catch {
    throw collectionError('AGROBOT_COLLECTION_FAILED', 'AgroBot collection failed');
  }
}

async function collectStatus(deps = {}) {
  const generatedAt = (deps.now ? deps.now() : new Date()).toISOString();
  const collectors = [
    deps.collectServer || collectServer,
    deps.collectProcesses || collectProcesses,
    deps.collectServices || collectServices,
    deps.collectAgrobot || collectAgrobot,
  ];
  const [serverResult, processesResult, servicesResult, agrobotResult] = await Promise.allSettled(
    collectors.map((collector) => collector()),
  );
  const events = [];
  if (serverResult.status === 'rejected') events.push({ at: generatedAt, category: 'server_collection_failed' });
  if (processesResult.status === 'rejected') events.push({ at: generatedAt, category: 'processes_collection_failed' });
  if (servicesResult.status === 'rejected') events.push({ at: generatedAt, category: 'services_collection_failed' });
  else events.push(...servicesResult.value.events);
  if (agrobotResult.status === 'rejected') events.push({ at: generatedAt, category: 'agrobot_collection_failed' });

  return {
    generatedAt,
    server: serverResult.status === 'fulfilled' ? serverResult.value : null,
    processes: processesResult.status === 'fulfilled' ? processesResult.value : [],
    services: servicesResult.status === 'fulfilled' ? servicesResult.value.services : [],
    agrobot: agrobotResult.status === 'fulfilled'
      ? agrobotResult.value
      : { totalReviews: 0, brands: [] },
    events: events
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, 3),
  };
}

module.exports = {
  collectAgrobot,
  collectServices,
  collectStatus,
};
