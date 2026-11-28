import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from 'pg';

const { DatabaseService } = await import('../src/database/database.service');
const { LineClientService } = await import('../src/line/line-client.service');
const { NotificationOutboxRepository } = await import('../src/notifications/notification-outbox.repository');
const { NotificationOutboxService } = await import('../src/notifications/notification-outbox.service');
const exec = promisify(execFile);

test('operator command and worker on PostgreSQL', async (t) => {
  assert.ok(process.env.DATABASE_URL, 'set DATABASE_URL to a migrated test database');
  const url = new URL(process.env.DATABASE_URL);
  const db = new DatabaseService();
  const scope = 'outbox_' + randomUUID().replaceAll('-', '');
  // The worker drains every due row. Give it an updatable view of only this run's fixtures.
  await db.query(`CREATE SCHEMA ${scope}`);
  url.searchParams.set('options', `-c search_path=${scope}`);
  url.searchParams.set('application_name', scope);
  const scoped = new DatabaseService({ databaseUrl: url.toString() } as never);
  const repo = new NotificationOutboxRepository(scoped);
  const handles: string[] = [];
  try {
    await db.query(`CREATE VIEW ${scope}.notification_outbox AS
      SELECT * FROM public.notification_outbox WHERE group_id = '${scope}' WITH CHECK OPTION`);
    const cli = async (...args: string[]) => {
      try {
        const result = await exec(process.execPath, ['--import', 'tsx', 'src/notifications/outbox-operator.ts', ...args], {
          env: { ...process.env, OUTBOX_OPERATOR_DATABASE_URL: process.env.DATABASE_URL },
        });
        return { code: 0, stdout: result.stdout };
      } catch (error) {
        return { code: error.code, stdout: error.stdout };
      }
    };
    const enqueue = async () => {
      const id = await scoped.withTransaction(q => repo.enqueueWith(q, scope, 'fixture-private-payload'));
      const [{ operator_id: handle }] = await scoped.query('SELECT operator_id FROM notification_outbox WHERE id=$1', [id]);
      handles.push(handle);
      return { id, handle };
    };
    const redrive = async (handle: string) =>
      (await db.query('SELECT public.redrive_notification($1) AS ok', [handle]))[0].ok;
    const worker = (line, limit = 1) => new NotificationOutboxService(repo, line, {
      notificationRetryLimit: limit, notificationRetryIntervalMs: 60_000,
    } as never);

    await t.test('lost response, redacted list, concurrent redrive, late failure, accepted 409 and durable audit', async t => {
      const { id, handle } = await enqueue();
      const requests: { key: string | null; body: unknown }[] = [];
      // Exercise the installed LINE SDK and real response headers without opening a socket.
      t.mock.method(globalThis, 'fetch', async (_url, init) => {
        requests.push({ key: new Headers(init.headers).get('x-line-retry-key'), body: init.body });
        if (requests.length === 1) throw new Error('fixture-private-provider-error'); // accepted, response lost
        return new Response('{}', { status: 409, headers: { 'x-line-accepted-request-id': 'fixture-accepted' } });
      });
      const service = worker(new LineClientService({ lineChannelAccessToken: 'fixture' } as never));
      await service.processPending();
      const first = (await scoped.query('SELECT first_attempt_at FROM notification_outbox WHERE id=$1', [id]))[0].first_attempt_at;
      await scoped.query("UPDATE notification_outbox SET last_error='fixture-private-legacy-error' WHERE id=$1", [id]);
      const list = await cli('list');
      assert.equal(list.code, 0);
      assert.deepEqual(JSON.parse(list.stdout).find(row => row.operator_id === handle), {
        operator_id: handle, attempts: 1, first_attempt_at: first.toISOString(), diagnostic: 'ambiguous', redrive: 'eligible',
      });
      for (const privateValue of [scope, id, 'fixture-private']) assert.ok(!list.stdout.includes(privateValue));
      assert.equal(requests.length, 1);
      const racers = await Promise.all([cli('redrive', handle), cli('redrive', handle)]);
      assert.deepEqual(racers.map(r => r.code).sort(), [0, 1]);
      assert.deepEqual(racers.map(r => JSON.parse(r.stdout).queued).sort(), [false, true]);
      await repo.markFailedAttempt(id, 1, 'rejected', true);
      assert.deepEqual((await scoped.query('SELECT status, attempts, first_attempt_at, redrive_attempt FROM notification_outbox WHERE id=$1', [id]))[0],
        { status: 'pending', attempts: 1, first_attempt_at: first, redrive_attempt: 2 });
      await Promise.all([service.processPending(), worker(new LineClientService({ lineChannelAccessToken: 'fixture' } as never)).processPending()]);
      assert.equal(requests.length, 2);
      assert.equal(requests[0].key, id);
      assert.deepEqual(requests[1], requests[0]);
      assert.equal(await redrive(handle), false);
      assert.equal((await scoped.query('SELECT id FROM notification_outbox WHERE id=$1', [id])).length, 0);
      const audit = await db.query(`SELECT requested_by = session_user AS actor_ok,
        requested_at BETWEEN $2 AND clock_timestamp() AS time_ok, attempts_before
        FROM public.notification_redrive_audit WHERE operator_id=$1`, [handle, first]);
      assert.deepEqual(audit, [{ actor_ok: true, time_ok: true, attempts_before: 1 }]);
    });

    await t.test('one extra claim even if worker limit grows, late acceptance wins', async () => {
      const { id, handle } = await enqueue();
      const claim = await repo.claimDue(60_000, 1);
      await scoped.query('UPDATE notification_outbox SET next_attempt_at=now() WHERE id=$1', [id]);
      assert.equal(await repo.claimDue(60_000, 1), null); // first worker interrupted
      assert.equal(await redrive(handle), true);
      const extra = await repo.claimDue(60_000, 50);
      assert.equal(extra.attempt_limit, 2);
      assert.equal(extra.attempts, 2);
      await scoped.query('UPDATE notification_outbox SET next_attempt_at=now() WHERE id=$1', [id]);
      assert.equal(await repo.claimDue(60_000, 50), null); // extra worker interrupted too
      assert.equal(await redrive(handle), false);
      await repo.markDelivered(id, claim.retry_key);
      await repo.markFailedAttempt(id, 2, 'ambiguous', true);
      assert.equal((await scoped.query('SELECT id FROM notification_outbox WHERE id=$1', [id])).length, 0);
    });

    for (const ordering of ['before approval', 'after approval', 'after next claim'] as const) {
      await t.test(`late HTTP 400 after interruption, ${ordering}`, async t => {
        const { id, handle } = await enqueue();
        let started!: () => void;
        const sending = new Promise<void>(resolve => { started = resolve; });
        let respond!: (response: Response) => void;
        const response = new Promise<Response>(resolve => { respond = resolve; });
        let calls = 0;
        t.mock.method(globalThis, 'fetch', async () => {
          calls++;
          started();
          return response;
        });
        const line = new LineClientService({ lineChannelAccessToken: 'fixture' } as never);
        const processing = worker(line).processPending();
        let auditBefore;
        try {
          await sending;
          await scoped.query('UPDATE notification_outbox SET next_attempt_at=now() WHERE id=$1', [id]);
          assert.equal(await repo.claimDue(60_000, 1), null);
          assert.deepEqual(await db.query(
            'SELECT diagnostic, redrive FROM public.failed_notifications WHERE operator_id=$1', [handle],
          ), [{ diagnostic: 'interrupted', redrive: 'eligible' }]);
          if (ordering !== 'before approval') {
            assert.equal(await redrive(handle), true);
            [auditBefore] = await db.query(
              'SELECT requested_by, requested_at, attempts_before FROM public.notification_redrive_audit WHERE operator_id=$1', [handle],
            );
          }
          if (ordering === 'after next claim') {
            const extra = await repo.claimDue(60_000, 1);
            assert.equal(extra?.attempts, 2);
          }
        } finally {
          respond(new Response('{}', { status: 400 }));
          await processing;
        }

        if (ordering === 'after next claim') {
          assert.deepEqual(await scoped.query(
            'SELECT status, attempts, failure_kind FROM notification_outbox WHERE id=$1', [id],
          ), [{ status: 'pending', attempts: 2, failure_kind: null }]);
          await repo.markDelivered(id, id);
          assert.deepEqual(await scoped.query('SELECT id FROM notification_outbox WHERE id=$1', [id]), []);
        } else {
          const [row] = await db.query(
            'SELECT diagnostic, redrive FROM public.failed_notifications WHERE operator_id=$1', [handle],
          );
          assert.deepEqual(row, { diagnostic: 'rejected', redrive: ordering === 'after approval' ? 'redrive_used' : 'rejected' });
          const refusal = await cli('redrive', handle);
          assert.equal(refusal.code, 1);
          assert.deepEqual(JSON.parse(refusal.stdout), { queued: false });
          await worker(line).processPending();
        }
        assert.equal(calls, 1, 'the prior worker must not dispatch an unclaimed cancelled grant');
        const audit = await db.query(
          'SELECT requested_by, requested_at, attempts_before, cancelled_at FROM public.notification_redrive_audit WHERE operator_id=$1', [handle],
        );
        if (ordering === 'before approval') {
          assert.deepEqual(audit, []);
        } else {
          const [{ cancelled_at, ...approval }] = audit;
          assert.deepEqual(approval, auditBefore);
          if (ordering === 'after approval') {
            assert.ok(cancelled_at instanceof Date && cancelled_at >= approval.requested_at);
            const [row] = await scoped.query('SELECT status, attempts, redrive_attempt FROM notification_outbox WHERE id=$1', [id]);
            assert.deepEqual(row, { status: 'failed', attempts: 1, redrive_attempt: 2 });
          } else {
            assert.equal(cancelled_at, null);
          }
        }
      });
    }

    await t.test('concurrent approval and late rejection preserve cancellation audit', async () => {
      const { id, handle } = await enqueue();
      assert.equal((await repo.claimDue(60_000, 1))?.id, id);
      await scoped.query('UPDATE notification_outbox SET next_attempt_at=now() WHERE id=$1', [id]);
      assert.equal(await repo.claimDue(60_000, 1), null);
      const grant = new Client({ connectionString: process.env.DATABASE_URL });
      await grant.connect();
      let rejecting: Promise<void> | undefined;
      try {
        await grant.query('BEGIN');
        assert.equal((await grant.query('SELECT public.redrive_notification($1) AS ok', [handle])).rows[0].ok, true);
        rejecting = repo.markFailedAttempt(id, 1, 'rejected', true);
        // Ensure the rejecting statement is waiting for the still-uncommitted grant.
        const deadline = Date.now() + 5000;
        let waiting = false;
        while (!waiting && Date.now() < deadline) {
          [{ waiting }] = await db.query(`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'
          ) AS waiting`, [scope]);
          if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(waiting, true);
        await grant.query('COMMIT');
        await rejecting;
      } finally {
        await grant.query('ROLLBACK');
        await grant.end();
        await rejecting;
      }
      assert.deepEqual(await db.query(
        'SELECT diagnostic, redrive FROM public.failed_notifications WHERE operator_id=$1', [handle],
      ), [{ diagnostic: 'rejected', redrive: 'redrive_used' }]);
      assert.deepEqual(await db.query(`SELECT attempts_before,
        cancelled_at >= requested_at AS cancelled FROM public.notification_redrive_audit WHERE operator_id=$1`, [handle]),
        [{ attempts_before: 1, cancelled: true }]);
      assert.equal(await repo.claimDue(60_000, 1), null);
    });

    await t.test('an interrupted claim can settle an approved redrive before the extra claim', async () => {
      const { id, handle } = await enqueue();
      const first = await repo.claimDue(60_000, 1);
      assert.equal(first?.id, id);
      await scoped.query('UPDATE notification_outbox SET next_attempt_at=now() WHERE id=$1', [id]);
      assert.equal(await repo.claimDue(60_000, 1), null);
      assert.equal(await redrive(handle), true);
      await repo.markFailedAttempt(id, 1, 'ambiguous', true);
      assert.deepEqual(await scoped.query(
        'SELECT status, attempts, redrive_attempt FROM notification_outbox WHERE id=$1', [id],
      ), [{ status: 'pending', attempts: 1, redrive_attempt: 2 }]);
      await repo.markDelivered(id, first!.retry_key);
      assert.equal(await repo.claimDue(60_000, 1), null);
      assert.equal(await redrive(handle), false);
      assert.deepEqual(await db.query(
        'SELECT attempts_before, cancelled_at FROM public.notification_redrive_audit WHERE operator_id=$1', [handle],
      ), [{ attempts_before: 1, cancelled_at: null }]);
    });

    await t.test('late rejection of an interrupted extra claim retains the completed grant', async () => {
      const { id, handle } = await enqueue();
      assert.equal((await repo.claimDue(60_000, 1))?.id, id);
      await scoped.query('UPDATE notification_outbox SET next_attempt_at=now() WHERE id=$1', [id]);
      assert.equal(await repo.claimDue(60_000, 1), null);
      assert.equal(await redrive(handle), true);
      assert.equal((await repo.claimDue(60_000, 1))?.attempts, 2);
      await scoped.query('UPDATE notification_outbox SET next_attempt_at=now() WHERE id=$1', [id]);
      assert.equal(await repo.claimDue(60_000, 1), null);
      await repo.markFailedAttempt(id, 2, 'rejected', true);
      assert.deepEqual(await db.query(
        'SELECT diagnostic, redrive FROM public.failed_notifications WHERE operator_id=$1', [handle],
      ), [{ diagnostic: 'rejected', redrive: 'redrive_used' }]);
      assert.deepEqual(await db.query(
        'SELECT attempts_before, cancelled_at FROM public.notification_redrive_audit WHERE operator_id=$1', [handle],
      ), [{ attempts_before: 1, cancelled_at: null }]);
      assert.equal(await redrive(handle), false);
    });

    await t.test('legacy, rejected, invalid key, missing, future and expired first attempt all refuse redrive', async () => {
      for (const [kind, key, age, expected] of [
        [null, randomUUID(), '1 hour', 'unknown_history'],
        ['rejected', randomUUID(), '1 hour', 'rejected'],
        ['ambiguous', 'not-a-uuid', '1 hour', 'unknown_history'],
        ['ambiguous', randomUUID(), null, 'unknown_history'],
        ['interrupted', randomUUID(), '-1 hour', 'unknown_history'],
        ['rate_limited', randomUUID(), '23 hours', 'window_closed'],
        ['ambiguous', randomUUID(), '25 hours', 'window_closed'],
      ]) {
        const { id, handle } = await enqueue();
        await scoped.query(`UPDATE notification_outbox SET status='failed', failure_kind=$2, attempts=1,
          retry_key=$3, first_attempt_at=now()-$4::interval WHERE id=$1`, [id, kind, key, age]);
        const [row] = await db.query('SELECT redrive FROM public.failed_notifications WHERE operator_id=$1', [handle]);
        assert.equal(row.redrive, expected);
        assert.equal(await redrive(handle), false);
      }
    });

    await t.test('an inconsistent first claim stays ineligible even after its timestamp passes', async () => {
      const { id, handle } = await enqueue();
      await scoped.query(`UPDATE notification_outbox SET status='failed', failure_kind='interrupted',
        attempts=1, first_attempt_at=now()-interval '1 hour', updated_at=now()-interval '2 hours' WHERE id=$1`, [id]);
      assert.equal(await redrive(handle), false);
      await scoped.query("UPDATE notification_outbox SET status='pending' WHERE id=$1", [id]);
      assert.equal(await repo.claimDue(1000, 1), null);
      assert.equal(await redrive(handle), false);
    });

    await t.test('an individually authenticated operator can redrive without direct queue or audit write access', async t => {
      const [{ rolsuper }] = await db.query('SELECT rolsuper FROM pg_roles WHERE rolname=session_user');
      if (!rolsuper) return t.skip('switching authenticated identities requires a superuser test connection');
      const { id, handle } = await enqueue();
      await scoped.query(`UPDATE notification_outbox SET attempts=1, first_attempt_at=now(), updated_at=now(),
        failure_kind='ambiguous', status='failed' WHERE id=$1`, [id]);
      const session = new Client({ connectionString: process.env.DATABASE_URL });
      await session.connect();
      try {
        await session.query('BEGIN');
        // Use a built-in role with no outbox privileges. All fixture grants roll back.
        await session.query('SET LOCAL SESSION AUTHORIZATION pg_signal_backend');
        const access = async () => (await session.query(`SELECT
          has_table_privilege(current_user,'public.failed_notifications','select') AS list,
          has_function_privilege(current_user,'public.redrive_notification(uuid)','execute') AS redrive,
          has_table_privilege(current_user,'public.notification_outbox','select') AS raw,
          has_table_privilege(current_user,'public.notification_redrive_audit','update') AS edit_audit`)).rows[0];
        assert.deepEqual(await access(), { list: false, redrive: false, raw: false, edit_audit: false });
        await session.query('RESET SESSION AUTHORIZATION');
        await session.query('GRANT SELECT ON public.failed_notifications TO pg_signal_backend');
        await session.query('GRANT EXECUTE ON FUNCTION public.redrive_notification(uuid) TO pg_signal_backend');
        await session.query('SET LOCAL SESSION AUTHORIZATION pg_signal_backend');
        assert.deepEqual(await access(), { list: true, redrive: true, raw: false, edit_audit: false });
        assert.equal((await session.query('SELECT redrive FROM public.failed_notifications WHERE operator_id=$1', [handle])).rows[0].redrive, 'eligible');
        assert.equal((await session.query('SELECT public.redrive_notification($1) AS ok', [handle])).rows[0].ok, true);
        await session.query('RESET SESSION AUTHORIZATION');
        assert.equal((await session.query('SELECT requested_by FROM public.notification_redrive_audit WHERE operator_id=$1', [handle])).rows[0].requested_by, 'pg_signal_backend');
      } finally {
        await session.query('ROLLBACK');
        await session.end();
      }
    });

    await t.test('worker checks history again after approval and quarantines malformed pending rows', async () => {
      const { id, handle } = await enqueue();
      let calls = 0;
      const service = worker({ pushToGroup: async () => { calls++; throw { status: 429 }; } }, 10);
      await service.processPending();
      assert.equal(await redrive(handle), true);
      await scoped.query("UPDATE notification_outbox SET first_attempt_at=now()-interval '24 hours' WHERE id=$1", [id]);
      const legacy = await enqueue();
      await scoped.query('UPDATE notification_outbox SET attempts=1, first_attempt_at=NULL WHERE id=$1', [legacy.id]);
      await service.processPending();
      assert.equal(calls, 1);
      assert.equal(await redrive(handle), false);
      const [row] = await scoped.query('SELECT status, attempts, first_attempt_at FROM notification_outbox WHERE id=$1', [legacy.id]);
      assert.deepEqual(row, { status: 'failed', attempts: 1, first_attempt_at: null });
    });
  } finally {
    await scoped.onModuleDestroy();
    await db.query('DELETE FROM public.notification_redrive_audit WHERE operator_id=ANY($1::uuid[])', [handles]);
    await db.query('DELETE FROM public.notification_outbox WHERE group_id=$1', [scope]);
    await db.query(`DROP SCHEMA ${scope} CASCADE`);
    await db.onModuleDestroy();
  }
});
