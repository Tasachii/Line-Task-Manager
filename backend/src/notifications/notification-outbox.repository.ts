import { Injectable } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { DatabaseService, Query } from '../database/database.service';

export interface OutboxNotification {
  id: string;
  group_id: string;
  message_text: string;
  retry_key: string;
  attempts: number;
  created_at: Date;
  first_attempt_at: Date;
}

export interface UndeliveredCounts {
  pending: number;
  failed: number;
}

@Injectable()
export class NotificationOutboxRepository {
  constructor(private readonly db: DatabaseService) {}

  async enqueueWith(query: Query, groupId: string, text: string): Promise<string> {
    const id = uuid();
    await query(
      `INSERT INTO notification_outbox (id, group_id, message_text, retry_key)
       VALUES ($1, $2, $3, $4)`,
      [id, groupId, text, id],
    );
    return id;
  }

  async claimDue(retryDelayMs: number, retryLimit: number): Promise<OutboxNotification | null> {
    return this.db.withTransaction(async (query) => {
      await query(
        `UPDATE notification_outbox
         SET status = 'failed', last_error = 'retry limit exhausted after interrupted delivery', updated_at = now()
         WHERE status = 'pending' AND attempts >= $1 AND next_attempt_at <= now()`,
        [retryLimit],
      );
      const params: unknown[] = [retryLimit, retryDelayMs];
      const rows = await query<OutboxNotification>(
        `WITH candidate AS (
           SELECT id FROM notification_outbox
           WHERE status = 'pending' AND attempts < $1
             AND next_attempt_at <= now()
           ORDER BY created_at
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE notification_outbox AS notification
         SET attempts = notification.attempts + 1,
             first_attempt_at = COALESCE(notification.first_attempt_at, now()),
             next_attempt_at = now() + ($2 * interval '1 millisecond'),
             updated_at = now()
         FROM candidate
         WHERE notification.id = candidate.id
         RETURNING notification.id, notification.group_id, notification.message_text,
                   notification.retry_key, notification.attempts, notification.created_at,
                   notification.first_attempt_at`,
        params,
      );
      return rows[0] ?? null;
    });
  }

  async markDelivered(id: string): Promise<void> {
    await this.db.query(
      'DELETE FROM notification_outbox WHERE id = $1',
      [id],
    );
  }

  async markFailedAttempt(id: string, attempt: number, error: string, terminal: boolean): Promise<void> {
    await this.db.query(
      `UPDATE notification_outbox
       SET status = CASE WHEN $3 THEN 'failed' ELSE 'pending' END,
           last_error = $4,
           updated_at = now()
       WHERE id = $1 AND status = 'pending' AND attempts = $2`,
      [id, attempt, terminal, error],
    );
  }

  async countUndelivered(): Promise<UndeliveredCounts> {
    const rows = await this.db.query<{ status: 'pending' | 'failed'; count: string }>(
      `SELECT status, count(*)::text AS count
       FROM notification_outbox
       WHERE status IN ('pending', 'failed')
       GROUP BY status`,
    );
    const counts: UndeliveredCounts = { pending: 0, failed: 0 };
    for (const row of rows) counts[row.status] = Number(row.count);
    return counts;
  }
}
