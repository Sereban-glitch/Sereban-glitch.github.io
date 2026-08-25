'use strict';

const STATUS_URL = 'https://35-209-212-217.sslip.io/api/status';
const REFRESH_INTERVAL_MS = 30000;
const SERVICE_STATUSES = new Set(['online', 'offline', 'not_migrated', 'unknown']);
const EVENT_CATEGORIES = new Set([
  'service_status',
  'server_collection_failed',
  'processes_collection_failed',
  'services_collection_failed',
  'agrobot_collection_failed',
]);
const RANK_COLORS = [
  '#f87171', '#fb923c', '#fbbf24', '#34d399', '#38bdf8', '#a78bfa', '#22d3ee',
  '#f472b6', '#c084fc', '#60a5fa', '#94a3b8', '#94a3b8', '#94a3b8', '#94a3b8',
  '#94a3b8', '#94a3b8',
];

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, keys) {
  return isObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function isText(value, maxLength = 200) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isIsoDate(value) {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validateServer(server) {
  if (server === null) return true;
  if (!hasOnlyKeys(server, ['memory', 'disk', 'load', 'uptimeSeconds'])) return false;
  if (!isInteger(server.uptimeSeconds)) return false;
  for (const resource of [server.memory, server.disk]) {
    if (!hasOnlyKeys(resource, ['totalMB', 'usedMB', 'percent'])
        || !isInteger(resource.totalMB) || resource.totalMB === 0
        || !isInteger(resource.usedMB) || resource.usedMB > resource.totalMB
        || !isInteger(resource.percent) || resource.percent > 100) return false;
  }
  return hasOnlyKeys(server.load, ['one', 'five', 'fifteen', 'percent'])
    && isNumber(server.load.one)
    && isNumber(server.load.five)
    && isNumber(server.load.fifteen)
    && isInteger(server.load.percent);
}

function validateStatus(value) {
  if (!hasOnlyKeys(value, ['generatedAt', 'server', 'processes', 'services', 'agrobot', 'events'])
      || !isIsoDate(value.generatedAt)
      || !validateServer(value.server)
      || !Array.isArray(value.processes) || value.processes.length > 16
      || !Array.isArray(value.services) || value.services.length > 11
      || !Array.isArray(value.events) || value.events.length > 3
      || !hasOnlyKeys(value.agrobot, ['totalReviews', 'brands'])
      || !isInteger(value.agrobot.totalReviews)
      || !Array.isArray(value.agrobot.brands) || value.agrobot.brands.length > 100) return false;

  if (!value.processes.every((process) => (
    hasOnlyKeys(process, ['key', 'name', 'detail', 'memoryMB', 'color'])
    && isText(process.key, 100)
    && isText(process.name)
    && typeof process.detail === 'string' && process.detail.length <= 200
    && isInteger(process.memoryMB)
    && typeof process.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(process.color)
  ))) return false;

  if (!value.services.every((service) => (
    hasOnlyKeys(service, ['key', 'name', 'icon', 'status'])
    && isText(service.key, 100)
    && isText(service.name)
    && isText(service.icon, 20)
    && SERVICE_STATUSES.has(service.status)
  ))) return false;

  if (!value.agrobot.brands.every((brand) => (
    hasOnlyKeys(brand, ['name', 'count', 'critical'])
    && isText(brand.name)
    && isInteger(brand.count)
    && isInteger(brand.critical)
    && brand.critical <= brand.count
  ))) return false;
  const reviewTotal = value.agrobot.brands.reduce((sum, brand) => sum + brand.count, 0);
  if (!Number.isSafeInteger(reviewTotal) || reviewTotal !== value.agrobot.totalReviews) return false;

  return value.events.every((event) => {
    if (!isObject(event) || !isIsoDate(event.at) || !EVENT_CATEGORIES.has(event.category)) return false;
    if (event.category === 'service_status') {
      return hasOnlyKeys(event, ['at', 'category', 'service', 'status'])
        && isText(event.service, 100)
        && SERVICE_STATUSES.has(event.status);
    }
    return hasOnlyKeys(event, ['at', 'category']);
  });
}

function serviceStatusView(status) {
  return {
    online: { className: 'svc-active', label: '✅ Online' },
    offline: { className: 'svc-down', label: '❌ Offline' },
    not_migrated: { className: 'svc-missing', label: 'Не перенесён' },
    unknown: { className: 'svc-unknown', label: 'Нет данных' },
  }[status];
}

async function loadStatus(fetchImpl, initData) {
  if (typeof initData !== 'string' || initData.length === 0) {
    throw new Error('Telegram authentication unavailable');
  }
  const response = await fetchImpl(STATUS_URL, {
    method: 'GET',
    headers: { Authorization: `tma ${initData}` },
    cache: 'no-store',
  });
  if (!response || !response.ok) throw new Error('dashboard request failed');
  const value = await response.json();
  if (!validateStatus(value)) throw new Error('invalid dashboard response');
  return value;
}

function piePath(startAngle, percent) {
  const cx = 50;
  const cy = 50;
  const radius = 40;
  const endAngle = startAngle + percent * 2 * Math.PI;
  const x1 = cx + radius * Math.cos(startAngle);
  const y1 = cy + radius * Math.sin(startAngle);
  const x2 = cx + radius * Math.cos(endAngle);
  const y2 = cy + radius * Math.sin(endAngle);
  return {
    endAngle,
    path: `M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${radius},${radius} 0 ${percent > 0.5 ? 1 : 0} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z`,
  };
}

function renderPie(data) {
  if (data.server === null) return { pie: '', legend: '<div class="loading">Нет данных</div>' };
  const total = data.server.memory.totalMB;
  const used = data.server.memory.usedMB;
  const reported = data.processes.reduce((sum, process) => sum + process.memoryMB, 0);
  const segments = data.processes.map((process) => ({
    name: process.name,
    memoryMB: process.memoryMB,
    color: process.color,
  }));
  if (reported < used) {
    segments.push({ name: 'Не распределено', memoryMB: used - reported, color: '#64748b' });
  }
  segments.push({ name: 'Свободно', memoryMB: Math.max(total - used, 0), color: '#1e293b' });

  let startAngle = -Math.PI / 2;
  let remaining = total;
  let pie = '';
  let legend = '';
  for (const segment of segments) {
    const chartMemory = Math.min(segment.memoryMB, remaining);
    const percent = chartMemory / total;
    if (percent >= 0.002) {
      const arc = piePath(startAngle, percent);
      startAngle = arc.endAngle;
      pie += `<path d="${arc.path}" fill="${segment.color}" stroke="#0f172a" stroke-width="1"/>`;
    }
    remaining -= chartMemory;
    const isFree = segment.name === 'Свободно';
    legend += `<div class="legend-item" style="${isFree ? 'opacity:0.5' : ''}"><div class="legend-dot" style="background:${segment.color}"></div><div class="legend-name">${escapeHtml(segment.name)}</div><div class="legend-val">${segment.memoryMB} МБ · ${((segment.memoryMB / total) * 100).toFixed(1)}%</div></div>`;
  }
  return { pie, legend };
}

function renderMarkup(data) {
  const pie = renderPie(data);
  const sortedProcesses = [...data.processes].sort((left, right) => right.memoryMB - left.memoryMB);
  const maxMemory = sortedProcesses[0]?.memoryMB || 0;
  const processes = sortedProcesses.length === 0
    ? '<div class="loading">Нет данных</div>'
    : sortedProcesses.map((process, index) => {
      const rankColor = RANK_COLORS[index] || '#475569';
      const width = maxMemory === 0 ? 0 : Math.round((process.memoryMB / maxMemory) * 100);
      const memoryColor = process.memoryMB > 100
        ? 'var(--red)'
        : process.memoryMB > 50 ? 'var(--yellow)' : 'var(--muted)';
      return `<div class="proc-row"><div class="proc-rank" style="background:${rankColor}20;color:${rankColor}">${index + 1}</div><div class="proc-name">${escapeHtml(process.name)}<span class="proc-detail">${escapeHtml(process.detail)}</span></div><div class="proc-bar"><div class="proc-bar-fill" style="width:${width}%;background:${process.color}"></div></div><div class="proc-mb" style="color:${memoryColor}">${process.memoryMB} МБ ${process.memoryMB > 50 ? '⚠️' : ''}</div></div>`;
    }).join('');

  const services = data.services.length === 0
    ? '<div class="loading">Нет данных</div>'
    : data.services.map((service) => {
      const view = serviceStatusView(service.status);
      return `<div class="svc-row"><div class="svc-name">${escapeHtml(service.icon)} ${escapeHtml(service.name)}</div><div class="svc-status ${view.className}">${view.label}</div></div>`;
    }).join('');

  const maxBrandCount = Math.max(0, ...data.agrobot.brands.map((brand) => brand.count));
  const brands = data.agrobot.brands.length === 0
    ? '<div class="loading">Нет данных</div>'
    : data.agrobot.brands.map((brand) => {
      const width = maxBrandCount === 0 ? 0 : Math.round((brand.count / maxBrandCount) * 100);
      const className = brand.critical >= 4 ? 'crit' : brand.critical >= 2 ? 'warn' : '';
      return `<div class="brand-row"><div class="brand-name">${escapeHtml(brand.name)}</div><div class="brand-bar"><div class="brand-fill ${className}" style="width:${width}%">${brand.count} (${brand.critical}⚠️)</div></div></div>`;
    }).join('');

  const eventLabels = {
    server_collection_failed: 'Не удалось получить данные сервера',
    processes_collection_failed: 'Не удалось получить список процессов',
    services_collection_failed: 'Не удалось получить статусы сервисов',
    agrobot_collection_failed: 'Не удалось получить отзывы AgroBot',
  };
  const events = data.events.length === 0
    ? '<div class="loading">Нет событий</div>'
    : data.events.map((event) => {
      const time = new Date(event.at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
      const text = event.category === 'service_status'
        ? `Статус ${escapeHtml(event.service)}: ${serviceStatusView(event.status).label}`
        : eventLabels[event.category];
      return `<div class="timeline-item"><div class="tl-time">${time}</div><div class="tl-text">${text}</div></div>`;
    }).join('');

  return { ...pie, processes, services, brands, events };
}

function formatMemory(memoryMB) {
  return memoryMB >= 1024 ? `${(memoryMB / 1024).toFixed(1)} ГБ` : `${memoryMB} МБ`;
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return `${days} дн. ${hours} ч.`;
}

function setResource(documentImpl, name, text, percent, className) {
  documentImpl.getElementById(`${name}-text`).textContent = text;
  const bar = documentImpl.getElementById(`${name}-bar`);
  bar.style.width = `${Math.min(percent, 100)}%`;
  bar.className = `bar-fill ${className}`;
}

function renderStatus(data, documentImpl) {
  const markup = renderMarkup(data);
  documentImpl.getElementById('stat-services').textContent = `${data.services.filter((service) => service.status === 'online').length}/${data.services.length}`;
  documentImpl.getElementById('stat-reviews').textContent = String(data.agrobot.totalReviews);
  documentImpl.getElementById('pie-svg').innerHTML = markup.pie;
  documentImpl.getElementById('pie-legend').innerHTML = markup.legend;
  documentImpl.getElementById('proc-card').innerHTML = markup.processes;
  documentImpl.getElementById('services-card').innerHTML = markup.services;
  documentImpl.getElementById('brands-card').innerHTML = markup.brands;
  documentImpl.getElementById('events-card').innerHTML = markup.events;

  if (data.server === null) {
    documentImpl.getElementById('ram-total-num').textContent = '—';
    documentImpl.querySelector('.pie-center-label').textContent = 'ГБ занято';
    for (const name of ['ram', 'disk', 'load']) setResource(documentImpl, name, 'Нет данных', 0, 'bar-green');
    documentImpl.getElementById('uptime-text').textContent = 'Нет данных';
  } else {
    const { memory, disk, load, uptimeSeconds } = data.server;
    documentImpl.getElementById('ram-total-num').textContent = (memory.usedMB / 1024).toFixed(1);
    documentImpl.querySelector('.pie-center-label').textContent = 'ГБ занято';
    setResource(documentImpl, 'ram', `${formatMemory(memory.usedMB)} / ${formatMemory(memory.totalMB)} (${memory.percent}%)`, memory.percent, memory.percent >= 85 ? 'bar-red' : memory.percent >= 70 ? 'bar-yellow' : 'bar-green');
    setResource(documentImpl, 'disk', `${formatMemory(disk.usedMB)} / ${formatMemory(disk.totalMB)} (${disk.percent}%)`, disk.percent, disk.percent >= 85 ? 'bar-red' : disk.percent >= 70 ? 'bar-yellow' : 'bar-green');
    setResource(documentImpl, 'load', `${load.one} / ${load.five} / ${load.fifteen}`, load.percent, load.percent >= 85 ? 'bar-red' : load.percent >= 70 ? 'bar-yellow' : 'bar-green');
    documentImpl.getElementById('uptime-text').textContent = formatUptime(uptimeSeconds);
  }
  documentImpl.getElementById('last-update').textContent = `Обновлено: ${new Date(data.generatedAt).toLocaleTimeString('uk-UA')}`;
}

function renderFailure(documentImpl) {
  for (const id of ['stat-services', 'stat-reviews', 'ram-total-num', 'ram-text', 'disk-text', 'load-text', 'uptime-text']) {
    documentImpl.getElementById(id).textContent = 'Нет связи';
  }
  documentImpl.getElementById('pie-svg').innerHTML = '';
  for (const id of ['pie-legend', 'proc-card', 'services-card', 'brands-card', 'events-card']) {
    documentImpl.getElementById(id).innerHTML = '<div class="loading">Нет связи</div>';
  }
  for (const name of ['ram', 'disk', 'load']) {
    documentImpl.getElementById(`${name}-bar`).style.width = '0%';
  }
}

function createRefreshData({ load, renderSuccess, renderFailure: showFailure }) {
  let pending = null;
  return function refreshData() {
    if (pending) return pending;
    pending = (async () => {
      try {
        renderSuccess(await load());
      } catch {
        showFailure();
      } finally {
        pending = null;
      }
    })();
    return pending;
  };
}

function startDashboard(windowImpl, documentImpl) {
  const telegram = windowImpl.Telegram?.WebApp;
  if (telegram) {
    telegram.ready();
    telegram.expand();
    telegram.setHeaderColor('#0f172a');
    telegram.setBackgroundColor('#0f172a');
  }
  const refreshData = createRefreshData({
    load: () => loadStatus(windowImpl.fetch.bind(windowImpl), telegram?.initData || ''),
    renderSuccess: (data) => renderStatus(data, documentImpl),
    renderFailure: () => renderFailure(documentImpl),
  });
  windowImpl.refreshData = refreshData;
  refreshData();
  windowImpl.setInterval(refreshData, REFRESH_INTERVAL_MS);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createRefreshData,
    escapeHtml,
    loadStatus,
    renderFailure,
    renderMarkup,
    renderStatus,
    serviceStatusView,
    validateStatus,
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  startDashboard(window, document);
}
