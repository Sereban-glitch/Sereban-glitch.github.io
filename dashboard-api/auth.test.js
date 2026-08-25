'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { validateInitData } = require('./auth');

const BOT_TOKEN = '123456789:test-token-for-fixtures';

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

test('accepts correctly signed recent Telegram initData', () => {
  const initData = signedInitData({
    auth_date: '1787572800',
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
    user: JSON.stringify({
      id: 745130167,
      first_name: 'Archi',
      last_name: 'Operator',
      username: 'archi_admin',
      language_code: 'en',
      allows_write_to_pm: true,
    }),
  }, BOT_TOKEN);

  assert.deepEqual(validateInitData(initData, BOT_TOKEN, { nowSeconds: 1787572860 }), {
    ok: true,
    user: {
      id: 745130167,
      first_name: 'Archi',
      last_name: 'Operator',
      username: 'archi_admin',
    },
    authDate: 1787572800,
  });
});

test('rejects changed initData', () => {
  const signed = signedInitData({ auth_date: '1787572800', user: '{"id":745130167}' }, BOT_TOKEN);

  assert.throws(
    () => validateInitData(signed.replace('745130167', '745130168'), BOT_TOKEN, { nowSeconds: 1787572860 }),
    (error) => error.code === 'UNAUTHORIZED',
  );
});

test('rejects stale initData', () => {
  const signed = signedInitData({ auth_date: '1787560000', user: '{"id":745130167}' }, BOT_TOKEN);

  assert.throws(
    () => validateInitData(signed, BOT_TOKEN, { nowSeconds: 1787572860 }),
    (error) => error.code === 'STALE_AUTH',
  );
});

test('rejects missing and duplicate hashes', () => {
  assert.throws(
    () => validateInitData('auth_date=1787572800', BOT_TOKEN, { nowSeconds: 1787572860 }),
    (error) => error.code === 'UNAUTHORIZED',
  );

  const signed = signedInitData({ auth_date: '1787572800', user: '{"id":745130167}' }, BOT_TOKEN);
  assert.throws(
    () => validateInitData(`${signed}&hash=${'0'.repeat(64)}`, BOT_TOKEN, { nowSeconds: 1787572860 }),
    (error) => error.code === 'UNAUTHORIZED',
  );
});

test('rejects malformed users and oversized payloads', () => {
  const malformed = signedInitData({ auth_date: '1787572800', user: '{bad-json' }, BOT_TOKEN);
  assert.throws(
    () => validateInitData(malformed, BOT_TOKEN, { nowSeconds: 1787572860 }),
    (error) => error.code === 'UNAUTHORIZED',
  );

  assert.throws(
    () => validateInitData(`user=${'x'.repeat(8200)}`, BOT_TOKEN, { nowSeconds: 1787572860 }),
    (error) => error.code === 'UNAUTHORIZED',
  );
});

test('rejects invalid, future, and expired auth dates', () => {
  for (const authDate of ['not-an-integer', '1787572800.5']) {
    const signed = signedInitData({ auth_date: authDate, user: '{"id":745130167}' }, BOT_TOKEN);
    assert.throws(
      () => validateInitData(signed, BOT_TOKEN, { nowSeconds: 1787572860 }),
      (error) => error.code === 'UNAUTHORIZED',
    );
  }

  const future = signedInitData({ auth_date: '1787572891', user: '{"id":745130167}' }, BOT_TOKEN);
  assert.throws(
    () => validateInitData(future, BOT_TOKEN, { nowSeconds: 1787572860 }),
    (error) => error.code === 'UNAUTHORIZED',
  );

  const expired = signedInitData({ auth_date: '1787572799', user: '{"id":745130167}' }, BOT_TOKEN);
  assert.throws(
    () => validateInitData(expired, BOT_TOKEN, { nowSeconds: 1787572860, maxAgeSeconds: 60 }),
    (error) => error.code === 'STALE_AUTH',
  );
});

test('rejects signatures with the wrong byte length', () => {
  const signed = signedInitData({ auth_date: '1787572800', user: '{"id":745130167}' }, BOT_TOKEN);
  const params = new URLSearchParams(signed);
  params.set('hash', '00');

  assert.throws(
    () => validateInitData(params.toString(), BOT_TOKEN, { nowSeconds: 1787572860 }),
    (error) => error.code === 'UNAUTHORIZED',
  );
});
