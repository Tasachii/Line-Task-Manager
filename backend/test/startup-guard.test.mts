// Unit tests for assertProdConfig — the production boot guard (B / P0-2 / D-1).
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { assertProdConfig } = await import('../src/common/assert-prod-config');

const KEYS = ['NODE_ENV', 'BOARD_PASSWORD', 'BOARD_GROUPS', 'CORS_ORIGIN', 'LINE_CHANNEL_SECRET'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function setProd() {
  process.env.NODE_ENV = 'production';
  process.env.BOARD_PASSWORD = 'pw';
  delete process.env.BOARD_GROUPS;
  process.env.CORS_ORIGIN = 'https://board.example.com';
  process.env.LINE_CHANNEL_SECRET = 'secret';
}

test('non-production → never throws regardless of env', () => {
  process.env.NODE_ENV = 'development';
  delete process.env.BOARD_PASSWORD;
  delete process.env.CORS_ORIGIN;
  delete process.env.LINE_CHANNEL_SECRET;
  assert.doesNotThrow(() => assertProdConfig());
});

test('production + all set → passes', () => {
  setProd();
  assert.doesNotThrow(() => assertProdConfig());
});

test('production + neither BOARD_PASSWORD nor BOARD_GROUPS → throws (message lists it)', () => {
  setProd();
  delete process.env.BOARD_PASSWORD;
  delete process.env.BOARD_GROUPS;
  assert.throws(() => assertProdConfig(), /BOARD_PASSWORD or BOARD_GROUPS must be set/);
});

test('production + BOARD_GROUPS set (no BOARD_PASSWORD) → passes (per-group auth authorizes the board)', () => {
  setProd();
  delete process.env.BOARD_PASSWORD;
  process.env.BOARD_GROUPS = JSON.stringify({ groupA: 'keyA' });
  assert.doesNotThrow(() => assertProdConfig());
});

test('production + CORS_ORIGIN unset → throws', () => {
  setProd();
  delete process.env.CORS_ORIGIN;
  assert.throws(() => assertProdConfig(), /CORS_ORIGIN/);
});

test("production + CORS_ORIGIN '*' → throws", () => {
  setProd();
  process.env.CORS_ORIGIN = '*';
  assert.throws(() => assertProdConfig(), /CORS_ORIGIN/);
});

test('production + empty LINE_CHANNEL_SECRET → throws', () => {
  setProd();
  process.env.LINE_CHANNEL_SECRET = '';
  assert.throws(() => assertProdConfig(), /LINE_CHANNEL_SECRET must be set/);
});

test('production + multiple missing → message lists all of them', () => {
  process.env.NODE_ENV = 'production';
  delete process.env.BOARD_PASSWORD;
  delete process.env.BOARD_GROUPS;
  delete process.env.CORS_ORIGIN;
  delete process.env.LINE_CHANNEL_SECRET;
  try {
    assertProdConfig();
    assert.fail('expected throw');
  } catch (e) {
    const msg = (e as Error).message;
    assert.match(msg, /BOARD_PASSWORD/);
    assert.match(msg, /CORS_ORIGIN/);
    assert.match(msg, /LINE_CHANNEL_SECRET/);
  }
});
