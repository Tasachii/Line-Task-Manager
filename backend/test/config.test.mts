// Unit tests for AppConfigService (defaults + BOARD_GROUPS parsing), the env-schema validator,
// and BoardAuthService key→group resolution (A-8 / D-3 / A-10).
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConfigService } from '@nestjs/config';

const { AppConfigService } = await import('../src/config/app-config.service');
const { BoardAuthService } = await import('../src/auth/board-auth.service');
const { validateEnv } = await import('../src/config/env.validation');

// Build an AppConfigService whose ConfigService.get() reads purely from a fixed map.
function cfg(map: Record<string, string | undefined>) {
  const stub = { get: <T = string>(k: string) => map[k] as unknown as T | undefined } as unknown as ConfigService;
  return new AppConfigService(stub);
}

test('defaults applied when env is empty', () => {
  const c = cfg({});
  assert.equal(c.taskKeyword, '/task');
  assert.equal(c.aiExtractModel, 'claude-haiku-4-5');
  assert.equal(c.webhookConcurrency, 3);
  assert.equal(c.port, 3000);
  assert.equal(c.throttleLimit, 120);
  assert.equal(c.throttleTtlMs, 60_000);
  assert.equal(c.corsOrigin, '*');
  assert.equal(c.notifyAssign, true);
  assert.deepEqual([...new Set(c.notifyStatuses.split(','))].length, 4);
  assert.equal(c.boardPassword, undefined);
  assert.deepEqual(c.boardGroups, {});
  assert.equal(c.perGroupAuthEnabled, false);
});

test('explicit values override defaults', () => {
  const c = cfg({ TASK_KEYWORD: '/งาน', WEBHOOK_CONCURRENCY: '5', NOTIFY_ASSIGN: 'false', PORT: '8080' });
  assert.equal(c.taskKeyword, '/งาน');
  assert.equal(c.webhookConcurrency, 5);
  assert.equal(c.notifyAssign, false);
  assert.equal(c.port, 8080);
});

test('WEBHOOK_CONCURRENCY is clamped to >= 1', () => {
  assert.equal(cfg({ WEBHOOK_CONCURRENCY: '0' }).webhookConcurrency, 1);
  assert.equal(cfg({ WEBHOOK_CONCURRENCY: '-4' }).webhookConcurrency, 1);
});

test('BOARD_GROUPS: valid JSON map parsed; perGroupAuthEnabled true', () => {
  const c = cfg({ BOARD_GROUPS: JSON.stringify({ gA: 'kA', gB: 'kB' }) });
  assert.deepEqual(c.boardGroups, { gA: 'kA', gB: 'kB' });
  assert.equal(c.perGroupAuthEnabled, true);
});

test('BOARD_GROUPS: non-string / empty values are dropped', () => {
  const c = cfg({ BOARD_GROUPS: JSON.stringify({ gA: 'kA', gB: '', gC: 123 }) });
  assert.deepEqual(c.boardGroups, { gA: 'kA' });
});

test('BOARD_GROUPS: invalid JSON ignored (empty map, no throw)', () => {
  const c = cfg({ BOARD_GROUPS: 'not json' });
  assert.deepEqual(c.boardGroups, {});
  assert.equal(c.perGroupAuthEnabled, false);
});

test('BOARD_GROUPS: a JSON array is ignored (must be an object)', () => {
  const c = cfg({ BOARD_GROUPS: JSON.stringify(['a', 'b']) });
  assert.deepEqual(c.boardGroups, {});
});

test('anthropicApiKey: empty string treated as undefined (AI disabled)', () => {
  assert.equal(cfg({ ANTHROPIC_API_KEY: '' }).anthropicApiKey, undefined);
  assert.equal(cfg({ ANTHROPIC_API_KEY: 'sk-x' }).anthropicApiKey, 'sk-x');
});

// --- validateEnv ---
test('validateEnv: accepts a well-formed env', () => {
  assert.doesNotThrow(() =>
    validateEnv({ NODE_ENV: 'production', PORT: '3000', BOARD_GROUPS: '{"g":"k"}', WEBHOOK_CONCURRENCY: '2' }),
  );
});

test('validateEnv: rejects invalid NODE_ENV', () => {
  assert.throws(() => validateEnv({ NODE_ENV: 'staging' }), /Invalid environment configuration/);
});

test('validateEnv: rejects non-numeric PORT', () => {
  assert.throws(() => validateEnv({ PORT: 'abc' }), /Invalid environment configuration/);
});

test('validateEnv: rejects malformed BOARD_GROUPS JSON', () => {
  assert.throws(() => validateEnv({ BOARD_GROUPS: 'not-json' }), /Invalid environment configuration/);
});

// --- BoardAuthService ---
function auth(map: Record<string, string | undefined>) {
  return new BoardAuthService(cfg(map));
}

test('auth disabled when nothing configured → resolves with groupId undefined', () => {
  const a = auth({});
  assert.equal(a.authDisabled, true);
  assert.deepEqual(a.resolve(undefined), { ok: true, groupId: undefined });
});

test('single BOARD_PASSWORD authorizes whole board (groupId undefined)', () => {
  const a = auth({ BOARD_PASSWORD: 'pw' });
  assert.deepEqual(a.resolve('pw'), { ok: true, groupId: undefined });
  assert.deepEqual(a.resolve('nope'), { ok: false });
  assert.deepEqual(a.resolve(123), { ok: false });
});

test('per-group: each key resolves to exactly its group_id; unknown key rejected', () => {
  const a = auth({ BOARD_GROUPS: JSON.stringify({ gA: 'kA', gB: 'kB' }) });
  assert.deepEqual(a.resolve('kA'), { ok: true, groupId: 'gA' });
  assert.deepEqual(a.resolve('kB'), { ok: true, groupId: 'gB' });
  assert.deepEqual(a.resolve('kC'), { ok: false });
  assert.deepEqual(a.resolve(undefined), { ok: false });
});

test('per-group takes precedence over BOARD_PASSWORD when both set', () => {
  const a = auth({ BOARD_PASSWORD: 'pw', BOARD_GROUPS: JSON.stringify({ gA: 'kA' }) });
  assert.deepEqual(a.resolve('kA'), { ok: true, groupId: 'gA' });
  // The legacy single password is NOT accepted once per-group keys are configured.
  assert.deepEqual(a.resolve('pw'), { ok: false });
});
