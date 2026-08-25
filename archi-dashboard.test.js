'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createRefreshData,
  escapeHtml,
  loadStatus,
  renderFailure,
  renderMarkup,
  renderStatus,
  serviceStatusView,
  validateStatus,
} = require('./archi-dashboard');

const VALID_STATUS = {
  generatedAt: '2026-08-24T12:00:00.000Z',
  server: {
    memory: { totalMB: 7950, usedMB: 1200, percent: 15 },
    disk: { totalMB: 30720, usedMB: 21504, percent: 70 },
    load: { one: 0.02, five: 0.04, fifteen: 0.01, percent: 2 },
    uptimeSeconds: 2116800,
  },
  processes: [{
    key: 'agrobot',
    name: 'AgroBot',
    detail: '1 process',
    memoryMB: 103,
    color: '#38bdf8',
  }],
  services: [{
    key: 'agrobot',
    name: 'AgroBot (@AgroLogic24Bot)',
    icon: '🤖',
    status: 'online',
  }],
  agrobot: {
    totalReviews: 11,
    brands: [{ name: 'HORSCH', count: 11, critical: 4 }],
  },
  events: [{
    at: '2026-08-24T11:59:00.000Z',
    category: 'service_status',
    service: 'agrobot',
    status: 'online',
  }],
};

test('escapes every API-provided label before markup generation', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');

  const hostile = structuredClone(VALID_STATUS);
  hostile.processes[0].name = '<img src=x onerror=process-name>';
  hostile.processes[0].detail = '"process-detail"';
  hostile.services[0].name = '<service-name>';
  hostile.services[0].icon = '<service-icon>';
  hostile.agrobot.brands[0].name = '<brand-name>';
  hostile.events[0].service = '<event-service>';
  const markup = JSON.stringify(renderMarkup(hostile));

  assert.equal(markup.includes('<img'), false);
  assert.equal(markup.includes('<service'), false);
  assert.equal(markup.includes('<brand'), false);
  assert.equal(markup.includes('<event'), false);
  assert.match(markup, /&lt;img src=x onerror=process-name&gt;/);
  assert.match(markup, /&quot;process-detail&quot;/);
});

test('maps all service states to honest Russian labels', () => {
  assert.deepEqual(serviceStatusView('online'), { className: 'svc-active', label: '✅ Online' });
  assert.deepEqual(serviceStatusView('offline'), { className: 'svc-down', label: '❌ Offline' });
  assert.deepEqual(serviceStatusView('not_migrated'), { className: 'svc-missing', label: 'Не перенесён' });
  assert.deepEqual(serviceStatusView('unknown'), { className: 'svc-unknown', label: 'Нет данных' });
});

test('validates the complete dashboard response contract', () => {
  assert.equal(validateStatus(VALID_STATUS), true);

  for (const malformed of [
    { ...VALID_STATUS, generatedAt: 'invalid' },
    { ...VALID_STATUS, server: { ...VALID_STATUS.server, uptimeSeconds: -1 } },
    { ...VALID_STATUS, processes: [{ ...VALID_STATUS.processes[0], color: 'url(javascript:alert(1))' }] },
    { ...VALID_STATUS, services: [{ ...VALID_STATUS.services[0], status: 'active' }] },
    { ...VALID_STATUS, agrobot: { totalReviews: 1, brands: [{ name: 'x', count: 1, critical: 2 }] } },
    { ...VALID_STATUS, events: [{ at: 'invalid', category: 'service_status' }] },
  ]) {
    assert.equal(validateStatus(malformed), false);
  }
});

test('sends Telegram initData and rejects malformed API responses', async () => {
  let seen;
  const fetchImpl = async (url, options) => {
    seen = { url, options };
    return { ok: true, json: async () => structuredClone(VALID_STATUS) };
  };
  await loadStatus(fetchImpl, 'query_id=q&auth_date=1787572800&hash=h');
  assert.equal(seen.url, 'https://35-209-212-217.sslip.io/api/status');
  assert.equal(seen.options.headers.Authorization, 'tma query_id=q&auth_date=1787572800&hash=h');
  assert.equal(seen.options.cache, 'no-store');

  await assert.rejects(
    loadStatus(async () => ({ ok: true, json: async () => ({ generatedAt: 'invalid' }) }), 'signed'),
    /invalid dashboard response/,
  );
  await assert.rejects(
    loadStatus(async () => ({ ok: false, status: 401 }), 'signed'),
    /dashboard request failed/,
  );
  await assert.rejects(loadStatus(fetchImpl, ''), /Telegram authentication unavailable/);
});

test('prevents overlapping refreshes and clears success state on failure', async () => {
  let resolveLoad;
  let loadCalls = 0;
  const rendered = [];
  const refreshData = createRefreshData({
    load: () => {
      loadCalls += 1;
      return new Promise((resolve) => { resolveLoad = resolve; });
    },
    renderSuccess: (value) => rendered.push(value.generatedAt),
    renderFailure: () => rendered.push('Нет связи'),
  });

  const first = refreshData();
  const overlapping = refreshData();
  assert.equal(loadCalls, 1);
  resolveLoad(VALID_STATUS);
  await Promise.all([first, overlapping]);
  assert.deepEqual(rendered, [VALID_STATUS.generatedAt]);

  const errorRefresh = createRefreshData({
    load: async () => { throw new Error('private failure'); },
    renderSuccess: () => rendered.push('stale success'),
    renderFailure: () => rendered.push('Нет связи'),
  });
  await errorRefresh();
  assert.equal(rendered.at(-1), 'Нет связи');
});

test('failure rendering clears displayed success without replacing the last successful timestamp', () => {
  const elements = new Map();
  const ids = [
    'stat-services', 'stat-reviews', 'ram-total-num', 'ram-text', 'disk-text', 'load-text',
    'uptime-text', 'pie-svg', 'pie-legend', 'proc-card', 'services-card', 'brands-card',
    'events-card', 'ram-bar', 'disk-bar', 'load-bar', 'last-update',
  ];
  for (const id of ids) elements.set(id, { textContent: '', innerHTML: '', style: {}, className: '' });
  const pieLabel = { textContent: '' };
  const documentImpl = {
    getElementById: (id) => elements.get(id),
    querySelector: () => pieLabel,
  };

  renderStatus(VALID_STATUS, documentImpl);
  const successfulTimestamp = elements.get('last-update').textContent;
  assert.match(successfulTimestamp, /^Обновлено:/);
  assert.match(elements.get('services-card').innerHTML, /AgroBot/);

  renderFailure(documentImpl);
  for (const id of ['stat-services', 'stat-reviews', 'ram-text', 'disk-text', 'load-text', 'uptime-text']) {
    assert.equal(elements.get(id).textContent, 'Нет связи');
  }
  for (const id of ['pie-legend', 'proc-card', 'services-card', 'brands-card', 'events-card']) {
    assert.equal(elements.get(id).innerHTML, '<div class="loading">Нет связи</div>');
  }
  assert.equal(elements.get('pie-svg').innerHTML, '');
  assert.equal(elements.get('last-update').textContent, successfulTimestamp);
});
