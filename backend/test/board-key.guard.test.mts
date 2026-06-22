// Unit tests for BoardKeyGuard.canActivate — REST board auth + per-group resolution (A-4, A-8).
import test from 'node:test';
import assert from 'node:assert/strict';
import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { fakeConfig } from './helpers/config.mts';

const { BoardKeyGuard } = await import('../src/auth/board-key.guard');
const { BoardAuthService } = await import('../src/auth/board-auth.service');

// Minimal ExecutionContext exposing a mutable request with the given headers.
function ctxWith(headers: Record<string, unknown>): { ctx: ExecutionContext; req: { headers: unknown; boardGroupId?: string } } {
  const req = { headers } as { headers: unknown; boardGroupId?: string };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

function guardWith(overrides: Record<string, string | undefined>) {
  return new BoardKeyGuard(new BoardAuthService(fakeConfig(overrides)));
}

test('no auth configured → returns true (dev-disabled), groupId undefined', () => {
  const guard = guardWith({ BOARD_PASSWORD: undefined, BOARD_GROUPS: undefined });
  const { ctx, req } = ctxWith({});
  assert.equal(guard.canActivate(ctx), true);
  assert.equal(req.boardGroupId, undefined);
});

test('single BOARD_PASSWORD: correct x-board-key → true, groupId undefined (all groups)', () => {
  const guard = guardWith({ BOARD_PASSWORD: 'super-secret' });
  const { ctx, req } = ctxWith({ 'x-board-key': 'super-secret' });
  assert.equal(guard.canActivate(ctx), true);
  assert.equal(req.boardGroupId, undefined);
});

test('single BOARD_PASSWORD: wrong key → throws UnauthorizedException', () => {
  const guard = guardWith({ BOARD_PASSWORD: 'super-secret' });
  assert.throws(() => guard.canActivate(ctxWith({ 'x-board-key': 'nope' }).ctx), UnauthorizedException);
});

test('missing header (undefined) → throws', () => {
  const guard = guardWith({ BOARD_PASSWORD: 'super-secret' });
  assert.throws(() => guard.canActivate(ctxWith({}).ctx), UnauthorizedException);
});

test('wrong-length key → throws without timingSafeEqual error (length short-circuit)', () => {
  const guard = guardWith({ BOARD_PASSWORD: 'super-secret' });
  // 'x' has a different byte length than the password — safeEqual returns false before timingSafeEqual.
  assert.throws(() => guard.canActivate(ctxWith({ 'x-board-key': 'x' }).ctx), UnauthorizedException);
});

test('array-valued header → throws (typeof string guard)', () => {
  const guard = guardWith({ BOARD_PASSWORD: 'super-secret' });
  assert.throws(
    () => guard.canActivate(ctxWith({ 'x-board-key': ['super-secret', 'super-secret'] }).ctx),
    UnauthorizedException,
  );
});

// A-8 / D-3 — per-group key map resolves a key to its group_id, scoping the read.
const GROUPS = JSON.stringify({ groupA: 'keyA', groupB: 'keyB' });

test('per-group: key for group A → true, boardGroupId = groupA', () => {
  const guard = guardWith({ BOARD_GROUPS: GROUPS });
  const { ctx, req } = ctxWith({ 'x-board-key': 'keyA' });
  assert.equal(guard.canActivate(ctx), true);
  assert.equal(req.boardGroupId, 'groupA');
});

test("per-group: a key for group A cannot read group B (resolves only to its own group)", () => {
  const guard = guardWith({ BOARD_GROUPS: GROUPS });
  const { ctx, req } = ctxWith({ 'x-board-key': 'keyB' });
  assert.equal(guard.canActivate(ctx), true);
  assert.equal(req.boardGroupId, 'groupB');
  assert.notEqual(req.boardGroupId, 'groupA');
});

test('per-group: an unknown key is rejected (cross-group access denied)', () => {
  const guard = guardWith({ BOARD_GROUPS: GROUPS });
  assert.throws(() => guard.canActivate(ctxWith({ 'x-board-key': 'keyC' }).ctx), UnauthorizedException);
});
