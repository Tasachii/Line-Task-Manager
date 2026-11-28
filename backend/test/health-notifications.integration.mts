import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import request from 'supertest';

const { DatabaseService } = await import('../src/database/database.service');
const { HealthController } = await import('../src/health/health.controller');
const { NotificationOutboxRepository } = await import('../src/notifications/notification-outbox.repository');
const { NotificationOutboxService } = await import('../src/notifications/notification-outbox.service');

test('/health serializes overdue pending age with consistent queue counts on PostgreSQL', async () => {
  assert.ok(process.env.DATABASE_URL, 'set DATABASE_URL to a migrated test database');
  const db = new DatabaseService();
  const schema = 'health_test_' + randomUUID().replaceAll('-', '');
  await db.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const scoped = new DatabaseService({ databaseUrl: url.toString() } as never);
  try {
    await scoped.query('CREATE TABLE notification_outbox (LIKE public.notification_outbox INCLUDING ALL)');
    const repo = new NotificationOutboxRepository(scoped);
    const service = new NotificationOutboxService(repo, null as never, null as never);
    // tsx does not emit Nest constructor type metadata. Supply it for this test only.
    Reflect.defineMetadata('design:paramtypes', [DatabaseService, NotificationOutboxService], HealthController);
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: DatabaseService, useValue: { query: scoped.query.bind(scoped) } },
        {
          provide: NotificationOutboxService,
          // Exercise the real service method without starting its background worker.
          useValue: { countUndelivered: service.countUndelivered.bind(service) },
        },
      ],
    }).compile();
    const app = module.createNestApplication();
    try {
      await app.init();

      const insert = async (status: 'pending' | 'failed', offset: string) => {
        const id = randomUUID();
        await scoped.query(
          `INSERT INTO notification_outbox (id, retry_key, group_id, message_text, status, next_attempt_at, created_at)
           VALUES ($1, $1, 'fixture-private-group', 'fixture-private-text', $2,
                   statement_timestamp() + $3::interval, statement_timestamp() - interval '30 days')`,
          [id, status, offset],
        );
        return id;
      };

      const check = async (pending: number, failed: number, age: number | null) => {
        const response = await request(app.getHttpServer()).get('/health').expect(200);
        assert.deepEqual(response.body, {
          status: 'ok', db: 'up',
          notifications: { undelivered: pending + failed, pending, failed, oldestOverduePendingAgeSeconds: age },
        });
      };

      await check(0, 0, null);
      await insert('pending', '1 day');
      await check(1, 0, null);
      await scoped.query("DELETE FROM notification_outbox WHERE status='pending'");
      await insert('failed', '-10 days');
      await check(0, 1, null);
      await insert('pending', '1 day');
      await check(1, 1, null);

      // A retry just becoming due serializes as numeric zero, distinct from null.
      const justDue = await insert('pending', '0 seconds');
      await check(2, 1, 0);
      await scoped.query('DELETE FROM notification_outbox WHERE id=$1', [justDue]);

      const oldest = await insert('pending', '-123.25 seconds');
      await insert('pending', '-10 seconds');
      const [{ age: before }] = await scoped.query(
        'SELECT floor(extract(epoch FROM statement_timestamp() - next_attempt_at))::float8 AS age FROM notification_outbox WHERE id=$1',
        [oldest],
      );
      const response = await request(app.getHttpServer()).get('/health').expect(200);
      const [{ age: after }] = await scoped.query(
        'SELECT floor(extract(epoch FROM statement_timestamp() - next_attempt_at))::float8 AS age FROM notification_outbox WHERE id=$1',
        [oldest],
      );
      const age = response.body.notifications.oldestOverduePendingAgeSeconds;
      assert.equal(typeof age, 'number');
      assert.ok(Number.isInteger(age) && age >= before && age <= after);
      assert.deepEqual(response.body, {
        status: 'ok', db: 'up',
        notifications: { undelivered: 4, pending: 3, failed: 1, oldestOverduePendingAgeSeconds: age },
      });
    } finally {
      await app.close();
    }
  } finally {
    await scoped.onModuleDestroy();
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.onModuleDestroy();
  }
});
