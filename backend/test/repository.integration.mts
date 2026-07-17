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

test('concurrent message intake atomically creates one task set', async () => {
  const concurrentMessageId = `intake_${RUN}`;
  const input = {
    title: 'exactly once',
    description: 'concurrent webhook retry',
    groupId,
    sourceMessageId: concurrentMessageId,
    createdBy: userId,
  };
  const attempts = await Promise.all(
    Array.from({ length: 20 }, () =>
      repo.claimMessageAndCreateTasks(
        {
          messageId: concurrentMessageId,
          groupId,
          userId,
          content: '/task exactly once',
          displayName: 'Integration Tester',
        },
        [input],
        groupId,
      ),
    ),
  );

  assert.equal(attempts.filter((result) => result !== null).length, 1, 'one caller claims the message');
  const tasks = await db.query(
    'SELECT id FROM tasks WHERE source_message_id = $1',
    [concurrentMessageId],
  );
  assert.equal(tasks.length, 1, 'one task is committed for 20 concurrent deliveries');

  await db.query('DELETE FROM tasks WHERE source_message_id = $1', [concurrentMessageId]);
  await db.query('DELETE FROM line_messages WHERE message_id = $1', [concurrentMessageId]);
});

test('failed intake rolls back its claim so a retry can succeed', async () => {
  const retryMessageId = `retry_${RUN}`;
  const message = {
    messageId: retryMessageId,
    groupId,
    userId,
    content: '/task retry after rollback',
    displayName: 'Integration Tester',
  };
  const input = {
    title: 'retry after rollback',
    description: 'database failure must not consume the claim',
    groupId,
    sourceMessageId: retryMessageId,
    createdBy: userId,
  };

  await assert.rejects(
    repo.claimMessageAndCreateTasks(message, [{ ...input, dueDate: 'not-a-date' }], groupId),
  );
  assert.equal(await repo.messageExists(retryMessageId), false, 'failed transaction releases claim');

  const retried = await repo.claimMessageAndCreateTasks(message, [input], groupId);
  assert.equal(retried?.length, 1, 'same LINE message can be retried after rollback');

  await db.query('DELETE FROM tasks WHERE source_message_id = $1', [retryMessageId]);
  await db.query('DELETE FROM line_messages WHERE message_id = $1', [retryMessageId]);
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

// Per-group WRITE isolation — the cross-tenant IDOR fix. A board key scoped to group A must not be
// able to change status, reorder, or assign a task that belongs to group B (id resolves to null → 404).
test('per-group write scope: group A key cannot mutate group B task (IDOR fix)', async () => {
  const groupA = `wA_${RUN}`;
  const groupB = `wB_${RUN}`;
  const msgA = `wmA_${RUN}`;
  const msgB = `wmB_${RUN}`;
  await repo.saveMessage(msgA, groupA, userId, 'seed A');
  await repo.saveMessage(msgB, groupB, userId, 'seed B');
  const taskB = await repo.createTask(
    { title: 'B secret', description: 'B', groupId: groupB, sourceMessageId: msgB, createdBy: userId },
    groupB,
  );

  // Group A's scope targeting group B's task id must be denied on every write path.
  assert.equal(await repo.updateStatus(taskB.id, 'done', groupA), null, 'updateStatus cross-group denied');
  assert.equal(await repo.move(taskB.id, 'done', 0, groupA), null, 'move cross-group denied');
  assert.equal(await repo.assign(taskB.id, userId, groupA), null, 'assign cross-group denied');

  // Group B's task is untouched.
  const afterB = await repo.findById(taskB.id, groupB);
  assert.equal(afterB?.status, 'todo', 'status unchanged by cross-group attempts');
  assert.equal(afterB?.assignee_id, null, 'assignee unchanged by cross-group attempts');

  // The rightful group B scope still mutates its own task.
  assert.ok(await repo.updateStatus(taskB.id, 'in_process', groupB), 'same-group updateStatus works');

  await db.query('DELETE FROM tasks WHERE group_id = ANY($1)', [[groupA, groupB]]);
  await db.query('DELETE FROM line_messages WHERE message_id = ANY($1)', [[msgA, msgB]]);
});

// Per-group ordering — the drop index the client sends is relative to the group's own column, so a
// scoped move must renumber only that group and leave a co-located group's cards untouched.
test('multi-group ordering: group-relative move index is scoped to the group', async () => {
  const groupA = `oA_${RUN}`;
  const groupB = `oB_${RUN}`;
  const msgA = `omA_${RUN}`;
  const msgB = `omB_${RUN}`;
  await repo.saveMessage(msgA, groupA, userId, 'seed A');
  await repo.saveMessage(msgB, groupB, userId, 'seed B');

  // Interleave creation so the two groups share the 'todo' column.
  const mk = (g: string, m: string, title: string) =>
    repo.createTask({ title, description: title, groupId: g, sourceMessageId: m, createdBy: userId }, g);
  await mk(groupA, msgA, 'A1');
  await mk(groupB, msgB, 'B1');
  const a2 = await mk(groupA, msgA, 'A2');
  await mk(groupB, msgB, 'B2');

  // Group A sees [A1, A2]; move A2 to the front using the group-relative index 0.
  assert.ok(await repo.move(a2.id, 'todo', 0, groupA), 'move within group A succeeds');

  const colA = (await repo.findAll(groupA)).filter((t) => t.status === 'todo');
  assert.deepEqual(colA.map((t) => t.title), ['A2', 'A1'], 'A2 moved ahead of A1 within group A');
  assert.deepEqual(colA.map((t) => t.position), [0, 1], 'group A todo renumbered to a clean 0..1');

  // Group B is untouched — its cards keep their order and are not renumbered by group A's move.
  const colB = (await repo.findAll(groupB)).filter((t) => t.status === 'todo');
  assert.deepEqual(colB.map((t) => t.title), ['B1', 'B2'], 'group B order preserved across group A move');

  await db.query('DELETE FROM tasks WHERE group_id = ANY($1)', [[groupA, groupB]]);
  await db.query('DELETE FROM line_messages WHERE message_id = ANY($1)', [[msgA, msgB]]);
});

// L3 — card edit. update() changes only the supplied fields and leaves the rest untouched.
test('update() edits title/description/assignee and leaves omitted fields untouched', async () => {
  const task = await repo.createTask(newInput('bad parse'));
  await repo.upsertUser(`assignee_${RUN}`, 'Assignee One');

  const titleOnly = await repo.update(task.id, { title: 'fixed title' });
  assert.equal(titleOnly?.title, 'fixed title');
  assert.equal(titleOnly?.description, 'bad parse', 'description untouched by a title-only edit');

  const withAssignee = await repo.update(task.id, {
    description: 'fixed description',
    assigneeId: `assignee_${RUN}`,
  });
  assert.equal(withAssignee?.description, 'fixed description');
  assert.equal(withAssignee?.assignee_id, `assignee_${RUN}`);
  assert.equal(withAssignee?.title, 'fixed title', 'title untouched by this second edit');
});

// L3 — cross-group edit is denied, same IDOR rule as updateStatus/move/assign.
test('update() cross-group edit is denied (IDOR fix)', async () => {
  const groupA = `euA_${RUN}`;
  const groupB = `euB_${RUN}`;
  const msgA = `eumA_${RUN}`;
  const msgB = `eumB_${RUN}`;
  await repo.saveMessage(msgA, groupA, userId, 'seed A');
  await repo.saveMessage(msgB, groupB, userId, 'seed B');
  const taskB = await repo.createTask(
    { title: 'B secret', description: 'B', groupId: groupB, sourceMessageId: msgB, createdBy: userId },
    groupB,
  );

  assert.equal(await repo.update(taskB.id, { title: 'hijacked' }, groupA), null, 'update cross-group denied');
  const afterB = await repo.findById(taskB.id, groupB);
  assert.equal(afterB?.title, 'B secret', 'title unchanged by cross-group attempt');

  await db.query('DELETE FROM tasks WHERE group_id = ANY($1)', [[groupA, groupB]]);
  await db.query('DELETE FROM line_messages WHERE message_id = ANY($1)', [[msgA, msgB]]);
});

// L3 — card soft-delete. Deleted cards vanish from findAll/findById but the row survives.
test('softDelete() hides a card from findAll/findById but keeps the row (soft-delete, not hard)', async () => {
  const task = await repo.createTask(newInput('to be deleted'));
  const before = (await repo.findAll()).some((t) => t.id === task.id);
  assert.equal(before, true, 'card visible before delete');

  const deleted = await repo.softDelete(task.id);
  assert.equal(deleted?.id, task.id);

  const after = (await repo.findAll()).some((t) => t.id === task.id);
  assert.equal(after, false, 'card excluded from findAll after soft-delete');
  assert.equal(await repo.findById(task.id), null, 'findById also excludes a soft-deleted card');

  const raw = await db.query('SELECT deleted_at FROM tasks WHERE id = $1', [task.id]);
  assert.notEqual(raw[0]?.deleted_at, null, 'row still exists in the database (history preserved)');

  // Deleting again affects zero rows (already deleted) → null, not a second success.
  assert.equal(await repo.softDelete(task.id), null, 'double-delete is a no-op, not an error');

  // A deleted card can no longer be edited either — it 404s like any other missing task.
  assert.equal(await repo.update(task.id, { title: 'resurrect?' }), null, 'cannot edit a deleted card');
});

// L3 — cross-group delete is denied, same IDOR rule as the other mutators.
test('softDelete() cross-group delete is denied (IDOR fix)', async () => {
  const groupA = `dA_${RUN}`;
  const groupB = `dB_${RUN}`;
  const msgA = `dmA_${RUN}`;
  const msgB = `dmB_${RUN}`;
  await repo.saveMessage(msgA, groupA, userId, 'seed A');
  await repo.saveMessage(msgB, groupB, userId, 'seed B');
  const taskB = await repo.createTask(
    { title: 'B secret', description: 'B', groupId: groupB, sourceMessageId: msgB, createdBy: userId },
    groupB,
  );

  assert.equal(await repo.softDelete(taskB.id, groupA), null, 'soft-delete cross-group denied');
  const afterB = await repo.findById(taskB.id, groupB);
  assert.ok(afterB, 'group B task still exists and is visible to its own group');

  await db.query('DELETE FROM tasks WHERE group_id = ANY($1)', [[groupA, groupB]]);
  await db.query('DELETE FROM line_messages WHERE message_id = ANY($1)', [[msgA, msgB]]);
});
