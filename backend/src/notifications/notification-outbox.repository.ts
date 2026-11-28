import { Injectable } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { DatabaseService, Query } from '../database/database.service';

export interface OutboxNotification {
  id: string;
  group_id: string;
  message_text: string;
  retry_key: string;
  attempts: number;
  operator_id: string;
  remaining_ms: number | null;
  attempt_limit: number;
}

export type PushFailure = 'ambiguous' | 'rate_limited' | 'rejected' | 'window_closed';

export interface UndeliveredCounts {
  pending: number;
  failed: number;
  oldestOverduePendingAgeSeconds: number | null;
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
         SET status = 'failed',
             failure_kind = CASE WHEN first_attempt_at > updated_at THEN 'window_closed' ELSE 'interrupted' END,
             updated_at = now()
         WHERE status = 'pending' AND attempts >= COALESCE(redrive_attempt, $1) AND next_attempt_at <= now()`,
        [retryLimit],
      );
      const params: unknown[] = [retryLimit, retryDelayMs];
      const rows = await query<OutboxNotification>(
        `WITH candidate AS (
           SELECT id, CASE
             WHEN attempts = 0 AND first_attempt_at IS NULL THEN public.notification_retry_deadline(retry_key, now())
             WHEN attempts > 0 AND first_attempt_at <= updated_at
               THEN public.notification_retry_deadline(retry_key, first_attempt_at)
           END AS deadline
           FROM notification_outbox
           WHERE status = 'pending' AND attempts < COALESCE(redrive_attempt, $1)
             AND next_attempt_at <= now()
           ORDER BY created_at
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE notification_outbox AS notification
         SET status = CASE WHEN candidate.deadline > statement_timestamp() THEN 'pending' ELSE 'failed' END,
             failure_kind = CASE WHEN candidate.deadline > statement_timestamp() THEN NULL ELSE 'window_closed' END,
             attempts = CASE WHEN candidate.deadline > statement_timestamp()
                             THEN notification.attempts + 1 ELSE notification.attempts END,
             first_attempt_at = CASE WHEN candidate.deadline IS NOT NULL AND notification.attempts = 0
                                     THEN now() ELSE notification.first_attempt_at END,
             next_attempt_at = now() + ($2 * interval '1 millisecond'),
             updated_at = now()
         FROM candidate
         WHERE notification.id = candidate.id
         RETURNING notification.id, notification.group_id, notification.message_text,
                   notification.retry_key, notification.attempts, notification.operator_id,
                   COALESCE(notification.redrive_attempt, $1) AS attempt_limit,
                   (1000 * EXTRACT(epoch FROM candidate.deadline - clock_timestamp()))::float8 AS remaining_ms`,
        params,
      );
      return rows[0] ?? null;
    });
  }

  async markDelivered(id: string, retryKey: string): Promise<void> {
    await this.db.query(
      'DELETE FROM notification_outbox WHERE id = $1 AND retry_key = $2',
      [id, retryKey],
    );
  }

  async markFailedAttempt(id: string, attempt: number, kind: PushFailure, terminal: boolean): Promise<void> {
    await this.db.withTransaction(async (query) => {
      // A definitive rejection supersedes an inferred interruption, including an
      // operator grant still awaiting its extra claim. The attempt fences older failures.
      const [settled] = await query<{ operator_id: string; cancelled: boolean | null }>(
        `UPDATE notification_outbox
         SET status = CASE WHEN $3 OR $4 = 'rejected' THEN 'failed' ELSE 'pending' END,
             failure_kind = $4, last_error = NULL,
             updated_at = now()
         WHERE id = $1 AND attempts = $2
           AND (
             (status = 'pending' AND (redrive_attempt IS NULL OR redrive_attempt = attempts))
             OR ($4 = 'rejected' AND failure_kind = 'interrupted'
                 AND (status = 'failed' OR (status = 'pending' AND redrive_attempt > attempts)))
           )
         RETURNING operator_id, redrive_attempt > attempts AS cancelled`,
        [id, attempt, terminal, kind],
      );
      if (settled?.cancelled) {
        // A separate statement sees a concurrent grant committed while the row
        // update was waiting for its lock. Both changes still commit together.
        await query(
          `UPDATE public.notification_redrive_audit
           SET cancelled_at = clock_timestamp()
           WHERE operator_id = $1 AND cancelled_at IS NULL`,
          [settled.operator_id],
        );
      }
    });
  }

  async countUndelivered(): Promise<UndeliveredCounts> {
    // Counts and age share one MVCC snapshot and one database clock reference.
    const [counts] = await this.db.query<UndeliveredCounts>(
      `SELECT (count(*) FILTER (WHERE status = 'pending'))::float8 AS pending,
              (count(*) FILTER (WHERE status = 'failed'))::float8 AS failed,
              floor(extract(epoch FROM statement_timestamp() -
                (min(next_attempt_at) FILTER (
                  WHERE status = 'pending' AND next_attempt_at <= statement_timestamp()
                ))
              ))::float8 AS "oldestOverduePendingAgeSeconds"
       FROM notification_outbox
       WHERE status IN ('pending', 'failed')`,
    );
    return counts;
  }
}
