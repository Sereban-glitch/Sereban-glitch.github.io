'use strict';

const crypto = require('node:crypto');

const MAX_INIT_DATA_BYTES = 8192;
const DEFAULT_MAX_AGE_SECONDS = 3600;
const MAX_FUTURE_SECONDS = 30;

function authError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validateInitData(initData, botToken, options = {}) {
  if (typeof initData !== 'string' || Buffer.byteLength(initData) > MAX_INIT_DATA_BYTES) {
    throw authError('UNAUTHORIZED');
  }

  const params = new URLSearchParams(initData);
  const hashes = params.getAll('hash');
  if (hashes.length !== 1 || !/^[0-9a-fA-F]{64}$/.test(hashes[0])) {
    throw authError('UNAUTHORIZED');
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = crypto.createHmac('sha256', secret).update(dataCheckString).digest();
  const suppliedHash = Buffer.from(hashes[0], 'hex');

  if (suppliedHash.length !== expectedHash.length || !crypto.timingSafeEqual(suppliedHash, expectedHash)) {
    throw authError('UNAUTHORIZED');
  }

  const authDateText = params.get('auth_date');
  if (!/^\d+$/.test(authDateText || '')) {
    throw authError('UNAUTHORIZED');
  }

  const authDate = Number(authDateText);
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  if (!Number.isSafeInteger(authDate) || authDate > nowSeconds + MAX_FUTURE_SECONDS) {
    throw authError('UNAUTHORIZED');
  }
  if (nowSeconds - authDate > maxAgeSeconds) {
    throw authError('STALE_AUTH');
  }

  let parsedUser;
  try {
    parsedUser = JSON.parse(params.get('user'));
  } catch {
    throw authError('UNAUTHORIZED');
  }
  if (parsedUser === null || typeof parsedUser !== 'object' || Array.isArray(parsedUser)) {
    throw authError('UNAUTHORIZED');
  }

  const user = {};
  for (const key of ['id', 'first_name', 'last_name', 'username']) {
    if (Object.hasOwn(parsedUser, key)) {
      user[key] = parsedUser[key];
    }
  }

  return { ok: true, user, authDate };
}

module.exports = { validateInitData };
