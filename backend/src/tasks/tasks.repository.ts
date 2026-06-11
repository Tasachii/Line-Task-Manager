import { Injectable } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { DatabaseService, Query } from '../database/database.service';
import { NewTaskInput, Task, TaskStatus } from './dto/task.types';

@Injectable()
export class TasksRepository {
  constructor(private readonly db: DatabaseService) {}

  // Deduplication check: returns true if this messageId has already been processed.
  async messageExists(messageId: string): Promise<boolean> {
    const rows = await this.db.query('SELECT 1 FROM line_messages WHERE message_id = $1', [messageId]);
    return rows.length > 0;
  }

  async saveMessage(messageId: string, groupId: string, userId: string, content: string) {
    await this.db.query(
      `INSERT INTO line_messages (message_id, group_id, user_id, content)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (message_id) DO NOTHING`,
      [messageId, groupId, userId, content],
    );
  }

  async userExists(userId: string): Promise<boolean> {
    const rows = await this.db.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    return rows.length > 0;
  }

  // Upsert a user record sourced from LINE.
  async upsertUser(lineUserId: string, displayName: string) {
    await this.db.query(
      `INSERT INTO users (id, line_user_id, display_name)
       VALUES ($1, $1, $2)
       ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`,
      [lineUserId, displayName],
    );
  }

  async createTask(input: NewTaskInput): Promise<Task> {
    const id = uuid();
    // New cards always append to the end of the todo column (position = max+1).
    // Run inside a transaction and serialize on the column lock so concurrent
    // inserts can't compute the same MAX(position)+1 and collide.
    return this.db.withTransaction(async (q) => {
      await this.lockColumn(q, 'todo');
      await q(
        `INSERT INTO tasks (id, title, description, status, source_message_id, group_id, created_by, priority, due_date, position)
         VALUES ($1, $2, $3, 'todo', $4, $5, $6, $7, $8,
                 (SELECT COALESCE(MAX(position) + 1, 0) FROM tasks WHERE status = 'todo'))`,
        [
          id,
          input.title,
          input.description,
          input.sourceMessageId,
          input.groupId,
          input.createdBy,
          input.priority ?? null,
          input.dueDate ?? null,
        ],
      );
      return (await this.findByIdWith(q, id))!;
    });
  }

  // Standard SELECT that JOINs the assignee's display name.
  private selectSql = `
    SELECT t.*, u.display_name AS assignee_name
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assignee_id`;

  async findAll(): Promise<Task[]> {
    return this.db.query<Task>(`${this.selectSql} ORDER BY t.status, t.position, t.created_at`);
  }

  async findById(id: string): Promise<Task | null> {
    // Outside a transaction: use the pool's auto-checkout query, which matches the Query shape.
    return this.findByIdWith((sql, params) => this.db.query(sql, params ?? []), id);
  }

  // findById over an arbitrary query function so it works inside a transaction (read-your-writes).
  private async findByIdWith(q: Query, id: string): Promise<Task | null> {
    const rows = await q<Task>(`${this.selectSql} WHERE t.id = $1`, [id]);
    return rows[0] ?? null;
  }

  // Transaction-scoped advisory lock keyed by column name. Two writers touching the
  // same column run one-at-a-time; different columns never block each other. Works for
  // empty columns too (unlike SELECT ... FOR UPDATE, which locks zero rows when empty).
  private lockColumn(q: Query, status: TaskStatus): Promise<unknown> {
    return q('SELECT pg_advisory_xact_lock(hashtext($1))', [`task_col:${status}`]);
  }

  async updateStatus(id: string, status: TaskStatus): Promise<Task | null> {
    // Changing column appends the card to the end of the new column.
    return this.db.withTransaction(async (q) => {
      await this.lockColumn(q, status);
      await q(
        `UPDATE tasks
         SET status = $2,
             position = (SELECT COALESCE(MAX(position) + 1, 0) FROM tasks WHERE status = $2 AND id <> $1),
             updated_at = now()
         WHERE id = $1`,
        [id, status],
      );
      return this.findByIdWith(q, id);
    });
  }

  // Move a card to the specified column and position, then rewrite positions for the whole column (0..n).
  // The whole read-renumber-write sequence is atomic and serialized on the target column,
  // so concurrent drags can't interleave and corrupt position ordering.
  async move(id: string, status: TaskStatus, index: number): Promise<Task | null> {
    return this.db.withTransaction(async (q) => {
      await this.lockColumn(q, status);

      const exists = await this.findByIdWith(q, id);
      if (!exists) return null;

      const rows = await q<{ id: string }>(
        `SELECT id FROM tasks WHERE status = $1 AND id <> $2 ORDER BY position, created_at`,
        [status, id],
      );
      const ordered = rows.map((r) => r.id);
      ordered.splice(Math.min(Math.max(index, 0), ordered.length), 0, id);

      for (let i = 0; i < ordered.length; i++) {
        if (ordered[i] === id) {
          await q(
            `UPDATE tasks SET status = $2, position = $3, updated_at = now() WHERE id = $1`,
            [id, status, i],
          );
        } else {
          await q(`UPDATE tasks SET position = $2 WHERE id = $1`, [ordered[i], i]);
        }
      }
      return this.findByIdWith(q, id);
    });
  }

  async assign(id: string, userId: string): Promise<Task | null> {
    await this.db.query(
      `UPDATE tasks SET assignee_id = $2, updated_at = now() WHERE id = $1`,
      [id, userId],
    );
    return this.findById(id);
  }
}
