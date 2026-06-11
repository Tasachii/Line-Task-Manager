// Integration tests for TasksRepository — exercise the real PostgreSQL path, focusing on the
// transaction + advisory-lock changes that protect card `position` ordering under concurrency.
//
// Requires a reachable database. Run after building:
//   docker compose up -d && npm run build && npm run migrate && npm run test:integration
// DATABASE_URL defaults to the docker-compose dev database.
import 'reflect-metadata';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://line:line@localhost:5432/line_task_manager';

const { DatabaseService } = await import('../dist/database/database.service.js');
const { TasksRepository } = await import('../dist/tasks/tasks.repository.js');

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
