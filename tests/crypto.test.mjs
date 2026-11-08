import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hotp, verifyTOTP, passHash } from '../common/crypto.js';
import { protectCode, codeMatches } from '../.id/worker/src/lib.js';
const key = new TextEncoder().encode('12345678901234567890');
test('RFC 4226 HOTP vectors and TOTP drift return the matched step', async () => {
  const vectors = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  for (let i = 0; i < vectors.length; i++) assert.equal(await hotp(key, i), vectors[i]);
  assert.equal(await verifyTOTP(vectors[5], key, 5 * 30000), 5);
  assert.equal(await verifyTOTP(vectors[4], key, 5 * 30000), 4);
  assert.equal(await verifyTOTP(vectors[3], key, 5 * 30000), false);
});
test('the historical ID chain is authoritative for non-multiple iteration counts', async () => {
  const salt = btoa('1234567890123456');
  assert.equal(await passHash('password', salt, 310000), await passHash('password', salt, 300000));
});
test('protected codes reject tampering and keep legacy codes readable', async () => {
  const env = { ID_ENC_KEY: 'test-only-key-0123456789abcdefgh' };
  const stored = await protectCode(env, '123456');
  assert.equal(await codeMatches(env, '123456', stored), true);
  assert.equal(await codeMatches(env, '654321', stored), false);
  assert.equal(await codeMatches(env, '123456', stored.slice(0, -10) + 'garbage'), false);
});
