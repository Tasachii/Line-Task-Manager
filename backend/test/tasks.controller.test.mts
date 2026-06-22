// Unit tests for the per-group read path: BoardKeyGuard resolves a key to its group_id and the
// controller threads that group_id into TasksService.findAll, so a key for group A returns only
// group A's tasks and can never read group B (A-8 / D-3).
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { fakeConfig } from './helpers/config.mts';

const { BoardKeyGuard } = await import('../src/auth/board-key.guard');
const { BoardAuthService } = await import('../src/auth/board-auth.service');
const { TasksController } = await import('../src/tasks/tasks.controller');

const GROUPS = JSON.stringify({ groupA: 'keyA', groupB: 'keyB' });

// Fake DB rows per group; the service stub returns only the requested group's rows.
const ROWS: Record<string, { id: string; group_id: string }[]> = {
  groupA: [{ id: 'a1', group_id: 'groupA' }],
  groupB: [{ id: 'b1', group_id: 'groupB' }],
};
function tasksStub() {
  return {
    findAll: (groupId?: string) =>
      Promise.resolve(groupId === undefined ? [...ROWS.groupA, ...ROWS.groupB] : (ROWS[groupId] ?? [])),
  };
}

// Run the guard + controller end-to-end for a given board key, returning the listed tasks.
async function listWithKey(boardKey: string) {
  const auth = new BoardAuthService(fakeConfig({ BOARD_GROUPS: GROUPS }));
  const guard = new BoardKeyGuard(auth);
  const req = { headers: { 'x-board-key': boardKey } } as { headers: Record<string, unknown>; boardGroupId?: string };
  const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  guard.canActivate(ctx); // sets req.boardGroupId
  const controller = new TasksController(tasksStub() as never);
  return controller.list(req as never);
}

test("group A's key lists only group A tasks", async () => {
  const tasks = await listWithKey('keyA');
  assert.deepEqual(tasks, ROWS.groupA);
});

test("group B's key lists only group B tasks (cannot read group A)", async () => {
  const tasks = await listWithKey('keyB');
  assert.deepEqual(tasks, ROWS.groupB);
  assert.equal((tasks as { group_id: string }[]).some((t) => t.group_id === 'groupA'), false);
});

test('an unknown key is rejected before any read', async () => {
  await assert.rejects(() => listWithKey('keyC'), UnauthorizedException);
});
