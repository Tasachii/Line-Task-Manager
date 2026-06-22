// Integration tests for TasksRepository — exercise the real PostgreSQL path, focusing on the
// transaction + advisory-lock changes that protect card `position` ordering under concurrency.
//
// Requires a reachable database. Run from source via tsx:
//   docker compose up -d && npm run migrate && npm run test:integration
// DATABASE_URL defaults to the docker-compose dev database.
import 'reflect-metadata';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://line:line@localhost:5432/line_task_manager';

const { DatabaseService } = await import('../src/database/database.service');
const { TasksRepository } = await import('../src/tasks/tasks.repository');

const db = new DatabaseService();
const repo = new TasksRepository(db);

// Unique namespace per run so parallel/previous runs don't interfere.
const RUN = `it_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const groupId = `g_${RUN}`;
const userId = `u_${RUN}`;
const messageId = `msg_${RUN}`;

function newInput(title) {
  return {
    title,
    description: title,
    groupId,
    sourceMessageId: messageId,
    createdBy: userId,
  };
}

before(async () => {
  await repo.upsertUser(userId, 'Integration Tester');
  await repo.saveMessage(messageId, groupId, userId, 'seed message');
});

after(async () => {
  // Remove everything this run created, then close the pool.
  await db.query('DELETE FROM tasks WHERE group_id = $1', [groupId]);
  await db.query('DELETE FROM line_messages WHERE message_id = $1', [messageId]);
  await db.query('DELETE FROM users WHERE id = $1', [userId]);
  await db.onModuleDestroy();
});

test('sequential createTask appends with strictly increasing positions', async () => {
  const a = await repo.createTask(newInput('seq A'));
  const b = await repo.createTask(newInput('seq B'));
  const c = await repo.createTask(newInput('seq C'));
  assert.ok(b.position > a.position, 'B after A');
  assert.ok(c.position > b.position, 'C after B');
  assert.equal(a.status, 'todo');
});

test('concurrent createTask never assign the same position (advisory lock holds)', async () => {
  const N = 12;
  const created = await Promise.all(
    Array.from({ length: N }, (_, i) => repo.createTask(newInput(`conc ${i}`))),
  );
  const positions = created.map((t) => t.position);
  const unique = new Set(positions);
  assert.equal(unique.size, positions.length, `expected ${N} distinct positions, got ${[...unique].sort((x, y) => x - y).join(',')}`);
});

test('move renumbers the target column to a clean 0..n-1 sequence', async () => {
  // Move every todo card for this group into the "test" column at index 0 (reverse insertion order).
  const todo = (await repo.findAll()).filter((t) => t.group_id === groupId && t.status === 'todo');
  for (const t of todo) {
    await repo.move(t.id, 'test', 0);
  }
  const inTest = (await repo.findAll())
    .filter((t) => t.group_id === groupId && t.status === 'test')
    .sort((a, b) => a.position - b.position);
  assert.equal(inTest.length, todo.length);
  inTest.forEach((t, i) => assert.equal(t.position, i, `position[${i}] should be ${i}`));
});

test('concurrent moves into one column keep positions distinct and contiguous', async () => {
  const inTest = (await repo.findAll()).filter((t) => t.group_id === groupId && t.status === 'test');
  // Fire concurrent moves into the "done" column, each targeting index 0.
  await Promise.all(inTest.map((t) => repo.move(t.id, 'done', 0)));
  const done = (await repo.findAll())
    .filter((t) => t.group_id === groupId && t.status === 'done')
    .sort((a, b) => a.position - b.position);
  assert.equal(done.length, inTest.length);
  const positions = done.map((t) => t.position);
  assert.equal(new Set(positions).size, positions.length, 'positions must be distinct');
  done.forEach((t, i) => assert.equal(t.position, i, 'positions must be contiguous 0..n-1'));
});

// Dedupe at the DB layer (A-2 complement / C3): saving the same messageId twice must not error
// (ON CONFLICT DO NOTHING) and messageExists must report it present.
test('saveMessage is idempotent on duplicate messageId (ON CONFLICT DO NOTHING)', async () => {
  const dupId = `dup_${RUN}`;
  await repo.saveMessage(dupId, groupId, userId, 'first');
  await repo.saveMessage(dupId, groupId, userId, 'second'); // must not throw
  assert.equal(await repo.messageExists(dupId), true);
  await db.query('DELETE FROM line_messages WHERE message_id = $1', [dupId]);
});

// A-8 / D-3 — per-group isolation. findAll(groupId) must return only that group's rows so a
// client holding group A's board key can never read group B's tasks (the data-leak fix).
test('findAll(groupId) is scoped to that group only (A-8 / D-3)', async () => {
  const groupA = `gA_${RUN}`;
  const groupB = `gB_${RUN}`;
  const msgA = `mA_${RUN}`;
  const msgB = `mB_${RUN}`;
  await repo.saveMessage(msgA, groupA, userId, 'seed A');
  await repo.saveMessage(msgB, groupB, userId, 'seed B');
  await repo.createTask({ title: 'A task', description: 'A', groupId: groupA, sourceMessageId: msgA, createdBy: userId });
  await repo.createTask({ title: 'B task', description: 'B', groupId: groupB, sourceMessageId: msgB, createdBy: userId });

  const onlyA = await repo.findAll(groupA);
  assert.ok(onlyA.length >= 1, 'findAll(groupA) returns group A rows');
  assert.ok(onlyA.every((t) => t.group_id === groupA), 'findAll(groupA) must return only group A tasks');

  const onlyB = await repo.findAll(groupB);
  assert.ok(onlyB.every((t) => t.group_id === groupB), 'findAll(groupB) must return only group B tasks');
  assert.equal(onlyB.some((t) => t.group_id === groupA), false, 'group B key cannot read group A');

  // findAll() with no argument still returns all groups (single-tenant / dev mode).
  const all = await repo.findAll();
  assert.ok(all.some((t) => t.group_id === groupA) && all.some((t) => t.group_id === groupB),
    'findAll() returns every group');

  await db.query('DELETE FROM tasks WHERE group_id = ANY($1)', [[groupA, groupB]]);
  await db.query('DELETE FROM line_messages WHERE message_id = ANY($1)', [[msgA, msgB]]);
});
