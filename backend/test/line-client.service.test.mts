// Unit tests for LineClientService.verifySignature — the bot's only auth gate (A-1, P0-1, D-1).
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { fakeConfig } from './helpers/config.mts';

const { LineClientService } = await import('../src/line/line-client.service');

const SECRET = 'test_secret';
const sign = (body: string, secret = SECRET) =>
  crypto.createHmac('sha256', secret).update(body).digest('base64');

let savedSecret: string | undefined;
let svc: InstanceType<typeof LineClientService>;

beforeEach(() => {
  savedSecret = process.env.LINE_CHANNEL_SECRET;
  process.env.LINE_CHANNEL_SECRET = SECRET;
  svc = new LineClientService(fakeConfig());
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.LINE_CHANNEL_SECRET;
  else process.env.LINE_CHANNEL_SECRET = savedSecret;
});

test('valid signature → true', () => {
  const body = JSON.stringify({ events: [] });
  assert.equal(svc.verifySignature(body, sign(body)), true);
});

test('wrong signature (different secret) → false', () => {
  const body = JSON.stringify({ events: [] });
  assert.equal(svc.verifySignature(body, sign(body, 'other_secret')), false);
});

test('missing signature (undefined) → false', () => {
  const body = JSON.stringify({ events: [] });
  assert.equal(svc.verifySignature(body, undefined), false);
});

test('empty LINE_CHANNEL_SECRET → false even with a computed signature', () => {
  const body = JSON.stringify({ events: [] });
  // Attacker forges a signature against the empty key — must still be rejected (D-1 hardening).
  process.env.LINE_CHANNEL_SECRET = '';
  const forged = sign(body, '');
  assert.equal(svc.verifySignature(body, forged), false);
});

test('unset LINE_CHANNEL_SECRET → false', () => {
  const body = JSON.stringify({ events: [] });
  delete process.env.LINE_CHANNEL_SECRET;
  assert.equal(svc.verifySignature(body, sign(body, '')), false);
});

test('body tampered after signing → false', () => {
  const original = JSON.stringify({ events: [{ id: 1 }] });
  const sig = sign(original);
  const tampered = JSON.stringify({ events: [{ id: 999 }] });
  assert.equal(svc.verifySignature(tampered, sig), false);
});

test('Buffer body and string body produce identical result', () => {
  const body = JSON.stringify({ events: [{ type: 'message' }] });
  const sig = sign(body);
  assert.equal(svc.verifySignature(Buffer.from(body, 'utf8'), sig), true);
  assert.equal(svc.verifySignature(body, sig), true);
});
