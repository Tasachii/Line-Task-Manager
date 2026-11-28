import test from 'node:test';
import assert from 'node:assert/strict';

const { NotificationOutboxService } = await import('../src/notifications/notification-outbox.service');
const { TasksService } = await import('../src/tasks/tasks.service');
const { HealthController } = await import('../src/health/health.controller');
const { LineClientService } = await import('../src/line/line-client.service');

type StoredNotification = {
  id: string;
  group_id: string;
  message_text: string;
  retry_key: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  nextAttempt: number;
  created_at: Date;
  first_attempt_at?: Date;
  lastError?: string;
};

class MemoryOutboxRepository {
  records: StoredNotification[] = [];
  delivered = new Set<string>();

  async seed(groupId: string, text: string) {
    const number = this.records.length + 1;
    const record: StoredNotification = {
      id: `notification-${number}`,
      group_id: groupId,
      message_text: text,
      retry_key: `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
      status: 'pending',
      attempts: 0,
      nextAttempt: Date.now(),
      created_at: new Date(),
    };
    this.records.push(record);
    return record.id;
  }

  async claimDue(retryDelayMs: number, retryLimit: number) {
    for (const record of this.records) {
      if (record.status === 'pending' && record.attempts >= retryLimit && record.nextAttempt <= Date.now()) {
        record.status = 'failed';
      }
    }
    const record = this.records.find(
      (candidate) =>
        candidate.status === 'pending' &&
        candidate.attempts < retryLimit &&
        candidate.nextAttempt <= Date.now(),
    );
    if (!record) return null;
    record.attempts += 1;
    record.first_attempt_at ??= new Date();
    record.nextAttempt = Date.now() + retryDelayMs;
    return { ...record, operator_id: record.id, attempt_limit: retryLimit,
      remaining_ms: record.first_attempt_at.getTime() + 23 * 3600000 - Date.now() };
  }

  async markDelivered(id: string) {
    const index = this.records.findIndex((record) => record.id === id);
    if (index >= 0) {
      this.delivered.add(id);
      this.records.splice(index, 1);
    }
  }

  async markFailedAttempt(id: string, attempt: number, error: string, terminal: boolean) {
    const record = this.find(id);
    if (record.status !== 'pending' || record.attempts !== attempt) return;
    record.status = terminal ? 'failed' : 'pending';
    record.lastError = error;
  }

  async countUndelivered() {
    return {
      pending: this.records.filter((record) => record.status === 'pending').length,
      failed: this.records.filter((record) => record.status === 'failed').length,
    };
  }

  private find(id: string) {
    const record = this.records.find((candidate) => candidate.id === id);
    if (!record) throw new Error(`missing notification ${id}`);
    return record;
  }
}

function delay(ms = 3) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setupOutbox(retryLimit = 3) {
  const repo = new MemoryOutboxRepository();
  let shouldFail = true;
  const calls: { retryKey: string; accepted: boolean }[] = [];
  const line = {
    pushToGroup: async (_groupId: string, _text: string, retryKey: string) => {
      const call = { retryKey, accepted: !shouldFail };
      calls.push(call);
      if (shouldFail) throw new Error('LINE unavailable');
    },
  };
  const config = { notificationRetryIntervalMs: 1000, notificationRetryLimit: retryLimit };
  const service = new NotificationOutboxService(repo as never, line as never, config as never);
  return { repo, service, calls, recover: () => { shouldFail = false; } };
}

test('failed LINE push leaves the moved card committed and one pending notification', async () => {
  const outbox = setupOutbox();
  let moved = false;
  const before = { id: 'task-1', group_id: 'group-1', title: 'Ship release', status: 'todo' };
  const after = { ...before, status: 'in_process' };
  const taskRepo = {
    findById: async () => before,
    move: async (
      _id: string,
      _status: string,
      _index: number,
      _groupId: string | undefined,
      notificationText?: (task: typeof after) => string,
    ) => {
      moved = true;
      if (notificationText) await outbox.repo.seed(after.group_id, notificationText(after));
      return after;
    },
  };
  const events = { tasksReordered: () => {} };
  const config = { notifyStatuses: 'in_process', notifyAssign: false };
  const tasks = new TasksService(taskRepo as never, events as never, config as never, outbox.service);

  const result = await tasks.move('task-1', 'in_process', 0);
  await delay();

  assert.equal(moved, true);
  assert.equal(result.status, 'in_process');
  assert.equal(outbox.repo.records.length, 1);
  assert.equal(outbox.repo.records[0].status, 'pending');
  assert.equal(outbox.repo.records[0].attempts, 1);

  outbox.recover();
  outbox.repo.records[0].nextAttempt = Date.now();
  await outbox.service.processPending();
  await delay();
  await outbox.service.processPending();

  assert.equal(outbox.repo.records.length, 0);
  assert.equal(outbox.repo.delivered.size, 1);
  assert.equal(outbox.calls.filter((call) => call.accepted).length, 1, 'retry is delivered exactly once');
  assert.equal(new Set(outbox.calls.map((call) => call.retryKey)).size, 1, 'every attempt reuses one LINE retry key');
});

test('permanent LINE failure stops at the retry limit and remains reported', async () => {
  const outbox = setupOutbox(3);
  await outbox.repo.seed('group-1', 'notification');
  outbox.service.kick();
  await delay();

  for (let attempt = 1; attempt < 3; attempt += 1) {
    outbox.repo.records[0].nextAttempt = Date.now();
    await outbox.service.processPending();
  }
  await delay();
  await outbox.service.processPending();

  assert.equal(outbox.calls.length, 3);
  assert.equal(outbox.repo.records[0].attempts, 3);
  assert.equal(outbox.repo.records[0].status, 'failed');
  assert.deepEqual(await outbox.service.countUndelivered(), { pending: 0, failed: 1 });
});

test('an old never-attempted notification is still sent once', async () => {
  const outbox = setupOutbox();
  outbox.recover();
  await outbox.repo.seed('group-1', 'old notification');
  outbox.repo.records[0].created_at = new Date(Date.now() - 48 * 60 * 60 * 1000);

  await outbox.service.processPending();

  assert.equal(outbox.calls.length, 1);
  assert.equal(outbox.repo.records.length, 0);
  assert.equal(outbox.repo.delivered.size, 1);
});

test('LINE duplicate-retry response is treated as already delivered', async () => {
  const config = { lineChannelAccessToken: 'token' };
  const line = new LineClientService(config as never);
  (line as unknown as { client: { pushMessage: () => Promise<never> } }).client = {
    pushMessage: async () => {
      throw {
        status: 409,
        headers: new Headers({ 'x-line-accepted-request-id': 'request-1' }),
      };
    },
  };

  await assert.doesNotReject(() => line.pushToGroup('group-1', 'notification', 'retry-key'));
});

test('health reports pending and terminally failed notification counts', async () => {
  const db = { query: async () => [{ '?column?': 1 }] };
  const notifications = { countUndelivered: async () => ({ pending: 2, failed: 1 }) };
  const controller = new HealthController(db as never, notifications as never);

  assert.deepEqual(await controller.check(), {
    status: 'ok',
    db: 'up',
    notifications: { undelivered: 3, pending: 2, failed: 1 },
  });
});

test('409 without an accepted request ID stops with a safe rejection diagnostic', async () => {
  const repo = new MemoryOutboxRepository();
  await repo.seed('fixture-group', 'fixture-payload');
  const line = new LineClientService({ lineChannelAccessToken: 'fixture' } as never);
  const response = { status: 409, headers: new Headers(), message: 'fixture-private-provider-detail' };
  (line as any).client = { pushMessage: async () => { throw response; } };
  const service = new NotificationOutboxService(repo as never, line, {
    notificationRetryIntervalMs: 1000, notificationRetryLimit: 5,
  } as never);
  await service.processPending();
  assert.equal(repo.records[0].status, 'failed');
  assert.equal(repo.records[0].lastError, 'rejected');
  assert.equal(repo.records[0].attempts, 1);
});
