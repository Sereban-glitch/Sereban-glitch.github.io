'use strict';

const fs = require('node:fs');
const os = require('node:os');

const PROCESS_TYPES = [
  ['opencode', 'OpenCode (IDE)', '#f472b6'],
  ['console-bot', 'Арчи (console-bot)', '#a78bfa'],
  ['agrobot', 'AgroBot', '#38bdf8'],
  ['agy-proxy', 'Antigravity Proxy', '#22d3ee'],
  ['postgres', 'PostgreSQL', '#818cf8'],
  ['systemd-journald', 'systemd-journald', '#fbbf24'],
];
const CGROUP_UNITS = new Map([
  ['agrobot.service', 'agrobot'],
  ['console-bot.service', 'console-bot'],
  ['agy-proxy.service', 'agy-proxy'],
  ['postgresql.service', 'postgres'],
  ['postgresql@15-main.service', 'postgres'],
  ['systemd-journald.service', 'systemd-journald'],
  ['opencode-serve.service', 'opencode'],
]);
const INTERNAL_ERROR = Symbol('internalCollectorError');

function collectorError(code, message) {
  const error = new Error(message);
  error.code = code;
  Object.defineProperty(error, INTERNAL_ERROR, { value: true });
  return error;
}

function parseMeminfo(text) {
  if (typeof text !== 'string') {
    throw collectorError('MALFORMED_MEMINFO', 'Malformed memory information');
  }
  const totalMatch = /^MemTotal:\s+(\d+)\s+kB$/m.exec(text);
  const availableMatch = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(text);
  const totalKB = Number(totalMatch?.[1]);
  const availableKB = Number(availableMatch?.[1]);

  if (!Number.isFinite(totalKB) || totalKB <= 0 || !Number.isFinite(availableKB)
      || availableKB < 0 || availableKB > totalKB) {
    throw collectorError('MALFORMED_MEMINFO', 'Malformed memory information');
  }

  const usedKB = totalKB - availableKB;
  return {
    totalMB: Math.round(totalKB / 1024),
    usedMB: Math.round(usedKB / 1024),
    percent: Math.round((usedKB / totalKB) * 100),
  };
}

function parseLoadavg(text, cpuCount) {
  if (typeof text !== 'string') {
    throw collectorError('MALFORMED_LOADAVG', 'Malformed load information');
  }
  const match = /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+)\/(\d+)\s+(\d+)\s*$/.exec(text);
  const values = match?.slice(1).map(Number);
  if (!values || values.some((value) => !Number.isFinite(value))
      || values[3] > values[4] || values[4] === 0
      || !Number.isInteger(cpuCount) || cpuCount <= 0) {
    throw collectorError('MALFORMED_LOADAVG', 'Malformed load information');
  }

  const [one, five, fifteen] = values;
  return {
    one,
    five,
    fifteen,
    percent: Math.round((one / cpuCount) * 100),
  };
}

function parseUptime(text) {
  if (typeof text !== 'string') {
    throw collectorError('MALFORMED_UPTIME', 'Malformed uptime information');
  }
  const match = /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*$/.exec(text);
  const uptime = Number(match?.[1]);
  const idle = Number(match?.[2]);
  if (!match || !Number.isFinite(uptime) || !Number.isFinite(idle)) {
    throw collectorError('MALFORMED_UPTIME', 'Malformed uptime information');
  }
  return Math.floor(uptime);
}

function processDetail(count) {
  return `${count} ${count === 1 ? 'process' : 'processes'}`;
}

function processType(record) {
  const cgroupTypes = new Set();
  for (const line of String(record.cgroup || '').split('\n')) {
    for (const component of line.split('/')) {
      const type = CGROUP_UNITS.get(component);
      if (type) cgroupTypes.add(type);
    }
  }

  const executable = String(record.cmdline || '').split('\0')[0];
  const executableName = executable.split('/').filter(Boolean).at(-1) || '';
  return PROCESS_TYPES.find(([key]) => cgroupTypes.has(key) || executableName === key);
}

function normalizeProcesses(records) {
  const groups = new Map(PROCESS_TYPES.map(([key, name, color]) => [key, {
    key,
    name,
    color,
    count: 0,
    memoryKB: 0,
  }]));
  let otherCount = 0;
  let otherMemoryKB = 0;

  for (const record of records) {
    const memoryKB = Number(record?.memoryKB);
    if (!Number.isFinite(memoryKB) || memoryKB < 0) {
      throw collectorError('MALFORMED_PROCESS_RECORD', 'Malformed process record');
    }

    const type = processType(record);
    if (type) {
      const group = groups.get(type[0]);
      group.count += 1;
      group.memoryKB += memoryKB;
    } else {
      otherCount += 1;
      otherMemoryKB += memoryKB;
    }
  }

  const named = [...groups.values()]
    .filter((group) => group.count > 0)
    .sort((left, right) => right.memoryKB - left.memoryKB)
    .slice(0, 15);
  const includedKeys = new Set(named.map((group) => group.key));
  for (const group of groups.values()) {
    if (group.count > 0 && !includedKeys.has(group.key)) {
      otherCount += group.count;
      otherMemoryKB += group.memoryKB;
    }
  }

  return [
    ...named.map(({ key, name, color, count, memoryKB }) => ({
      key,
      name,
      detail: processDetail(count),
      memoryMB: Math.round(memoryKB / 1024),
      color,
    })),
    {
      key: 'other',
      name: 'Прочее',
      detail: processDetail(otherCount),
      memoryMB: Math.round(otherMemoryKB / 1024),
      color: '#475569',
    },
  ];
}

function parseProcessStatus(text) {
  const nameMatch = /^Name:\s+(.+)$/m.exec(text);
  const memoryLine = /^VmRSS:.*$/m.exec(text);
  const memoryMatch = /^VmRSS:\s+(\d+)\s+kB$/m.exec(text);
  if (!nameMatch || (memoryLine && !memoryMatch)) {
    throw collectorError('MALFORMED_PROCESS_STATUS', 'Malformed process status');
  }
  return { name: nameMatch[1], memoryKB: memoryMatch ? Number(memoryMatch[1]) : null };
}

async function collectServer(deps = {}) {
  const readFile = deps.readFile || fs.promises.readFile;
  const statfs = deps.statfs || fs.promises.statfs;
  const cpuCount = deps.cpuCount ?? os.cpus().length;

  try {
    const [meminfo, loadavg, uptime, diskStats] = await Promise.all([
      readFile('/proc/meminfo', 'utf8'),
      readFile('/proc/loadavg', 'utf8'),
      readFile('/proc/uptime', 'utf8'),
      statfs('/'),
    ]);
    const blocks = Number(diskStats.blocks);
    const availableBlocks = Number(diskStats.bavail);
    const blockSize = Number(diskStats.bsize);
    if (![blocks, availableBlocks, blockSize].every(Number.isFinite)
        || blocks < 0 || availableBlocks < 0 || availableBlocks > blocks || blockSize < 0) {
      throw collectorError('MALFORMED_STATFS', 'Malformed disk information');
    }

    const totalBytes = blocks * blockSize;
    const usedBytes = (blocks - availableBlocks) * blockSize;
    return {
      memory: parseMeminfo(String(meminfo)),
      disk: {
        totalMB: Math.round(totalBytes / 1024 / 1024),
        usedMB: Math.round(usedBytes / 1024 / 1024),
        percent: totalBytes === 0 ? 0 : Math.round((usedBytes / totalBytes) * 100),
      },
      load: parseLoadavg(String(loadavg), cpuCount),
      uptimeSeconds: parseUptime(String(uptime)),
    };
  } catch (error) {
    if (error?.[INTERNAL_ERROR]) throw error;
    throw collectorError('SERVER_COLLECTION_FAILED', 'Server resource collection failed');
  }
}

async function collectProcesses(deps = {}) {
  const readdir = deps.readdir || fs.promises.readdir;
  const readFile = deps.readFile || fs.promises.readFile;

  try {
    const entries = await readdir('/proc');
    const pids = entries.filter((entry) => /^\d+$/.test(String(entry)));
    const records = [];
    let nextIndex = 0;

    async function worker() {
      while (nextIndex < pids.length) {
        const pid = pids[nextIndex];
        nextIndex += 1;
        try {
          const statusText = await readFile(`/proc/${pid}/status`, 'utf8');
          const status = parseProcessStatus(String(statusText));
          const cmdline = String(await readFile(`/proc/${pid}/cmdline`, 'utf8'));
          if (status.memoryKB === null && cmdline !== '') {
            throw collectorError('MALFORMED_PROCESS_STATUS', 'Malformed process status');
          }
          const cgroup = await readFile(`/proc/${pid}/cgroup`, 'utf8');
          records.push({ ...status, memoryKB: status.memoryKB ?? 0, cmdline, cgroup: String(cgroup) });
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(16, pids.length) }, worker));
    return normalizeProcesses(records);
  } catch (error) {
    throw collectorError('PROCESS_COLLECTION_FAILED', 'Process collection failed');
  }
}

module.exports = {
  collectProcesses,
  collectServer,
  normalizeProcesses,
  parseLoadavg,
  parseMeminfo,
  parseUptime,
};
