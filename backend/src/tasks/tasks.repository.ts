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

  async claimMessageAndCreateTasks(
    message: {
      messageId: string;
      groupId: string;
      userId: string;
      content: string;
      displayName?: string;
    },
    inputs: NewTaskInput[],
    scopeGroupId?: string,
  ): Promise<Task[] | null> {
    return this.db.withTransaction(async (q) => {
      const claimed = await q<{ message_id: string }>(
        `INSERT INTO line_messages (message_id, group_id, user_id, content)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (message_id) DO NOTHING
         RETURNING message_id`,
        [message.messageId, message.groupId, message.userId, message.content],
      );
      if (claimed.length === 0) return null;
      if (inputs.length === 0) return [];

      await q(
        `INSERT INTO users (id, line_user_id, display_name)
         VALUES ($1, $1, $2)
         ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`,
        [message.userId, message.displayName ?? message.userId],
      );

      await this.lockColumn(q, 'todo', scopeGroupId);
      const positionParams: unknown[] = [];
      let positionScope = '';
      if (scopeGroupId !== undefined) {
        positionParams.push(scopeGroupId);
        positionScope = ' AND group_id = $1';
      }
      const [{ next_position: firstPosition }] = await q<{ next_position: number }>(
        `SELECT COALESCE(MAX(position) + 1, 0)::int AS next_position
         FROM tasks WHERE status = 'todo'${positionScope}`,
        positionParams,
      );

      const created: Task[] = [];
      for (let index = 0; index < inputs.length; index++) {
        const input = inputs[index];
        const id = uuid();
        await q(
          `INSERT INTO tasks
             (id, title, description, status, source_message_id, group_id, created_by,
              priority, due_date, position)
           VALUES ($1, $2, $3, 'todo', $4, $5, $6, $7, $8, $9)`,
          [
            id,
            input.title,
            input.description,
            message.messageId,
            message.groupId,
            message.userId,
            input.priority ?? null,
            input.dueDate ?? null,
            firstPosition + index,
          ],
        );
        created.push((await this.findByIdWith(q, id))!);
      }
      return created;
    });
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

  // `scopeGroupId` keeps each group's column contiguous under per-group isolation: when set, the
  // append position is computed within that group only (matching the group-scoped board view a
  // client drags against). Single-tenant/dev deploys pass undefined and append across all groups.
  async createTask(input: NewTaskInput, scopeGroupId?: string): Promise<Task> {
    const id = uuid();
    // New cards always append to the end of the todo column (position = max+1).
    // Run inside a transaction and serialize on the column lock so concurrent
    // inserts can't compute the same MAX(position)+1 and collide.
    return this.db.withTransaction(async (q) => {
      await this.lockColumn(q, 'todo', scopeGroupId);
      const params: unknown[] = [
        id,
        input.title,
        input.description,
        input.sourceMessageId,
        input.groupId,
        input.createdBy,
        input.priority ?? null,
        input.dueDate ?? null,
      ];
      let posFilter = '';
      if (scopeGroupId !== undefined) {
        posFilter = ' AND group_id = $9';
        params.push(scopeGroupId);
      }
      await q(
        `INSERT INTO tasks (id, title, description, status, source_message_id, group_id, created_by, priority, due_date, position)
         VALUES ($1, $2, $3, 'todo', $4, $5, $6, $7, $8,
                 (SELECT COALESCE(MAX(position) + 1, 0) FROM tasks WHERE status = 'todo'${posFilter}))`,
        params,
      );
      return (await this.findByIdWith(q, id))!;
    });
  }

  // Standard SELECT that JOINs the assignee's display name.
  private selectSql = `
    SELECT t.*, u.display_name AS assignee_name
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assignee_id`;

  // Scoped to a single group when groupId is provided (per-group board isolation, A-8/D-3);
  // returns every group's tasks only when groupId is undefined (single-tenant / dev mode).
  async findAll(groupId?: string): Promise<Task[]> {
    if (groupId !== undefined) {
      return this.db.query<Task>(
        `${this.selectSql} WHERE t.group_id = $1 ORDER BY t.status, t.position, t.created_at`,
        [groupId],
      );
    }
    return this.db.query<Task>(`${this.selectSql} ORDER BY t.status, t.position, t.created_at`);
  }

  // `groupId` scopes the lookup to one group so a per-group board key can never resolve a task
  // belonging to another group (undefined = single-tenant/dev, any group).
  async findById(id: string, groupId?: string): Promise<Task | null> {
    // Outside a transaction: use the pool's auto-checkout query, which matches the Query shape.
    return this.findByIdWith((sql, params) => this.db.query(sql, params ?? []), id, groupId);
  }

  // findById over an arbitrary query function so it works inside a transaction (read-your-writes).
  // When groupId is set the row must also belong to that group, otherwise it resolves to null.
  private async findByIdWith(q: Query, id: string, groupId?: string): Promise<Task | null> {
    const rows =
      groupId === undefined
        ? await q<Task>(`${this.selectSql} WHERE t.id = $1`, [id])
        : await q<Task>(`${this.selectSql} WHERE t.id = $1 AND t.group_id = $2`, [id, groupId]);
    return rows[0] ?? null;
  }

  // Transaction-scoped advisory lock keyed by column name. Two writers touching the
  // same column run one-at-a-time; different columns never block each other. Works for
  // empty columns too (unlike SELECT ... FOR UPDATE, which locks zero rows when empty).
  // When groupId is set the lock is per-group too, so groups renumbering the same column
  // (disjoint rows under per-group isolation) don't serialize against each other.
  private lockColumn(q: Query, status: TaskStatus, groupId?: string): Promise<unknown> {
    const key = groupId === undefined ? `task_col:${status}` : `task_col:${groupId}:${status}`;
    return q('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
  }

  // groupId (when set) both authorizes the write (task must be in that group, else null → 404)
  // and scopes the append position to the group's column.
  async updateStatus(id: string, status: TaskStatus, groupId?: string): Promise<Task | null> {
    // Changing column appends the card to the end of the new column.
    return this.db.withTransaction(async (q) => {
      await this.lockColumn(q, status, groupId);
      // Authorize + confirm existence within the caller's group before mutating.
      const existing = await this.findByIdWith(q, id, groupId);
      if (!existing) return null;

      const params: unknown[] = [id, status];
      let posFilter = '';
      if (groupId !== undefined) {
        posFilter = ' AND group_id = $3';
        params.push(groupId);
      }
      await q(
        `UPDATE tasks
         SET status = $2,
             position = (SELECT COALESCE(MAX(position) + 1, 0) FROM tasks WHERE status = $2 AND id <> $1${posFilter}),
             updated_at = now()
         WHERE id = $1`,
        params,
      );
      return this.findByIdWith(q, id, groupId);
    });
  }

  // Move a card to the specified column and position, then rewrite positions for the whole column (0..n).
  // The whole read-renumber-write sequence is atomic and serialized on the target column,
  // so concurrent drags can't interleave and corrupt position ordering. When groupId is set the
  // renumber is scoped to that group, so a group-relative drop index maps to this group's column
  // (not the merged all-groups list) and another group's positions are left untouched.
  async move(id: string, status: TaskStatus, index: number, groupId?: string): Promise<Task | null> {
    return this.db.withTransaction(async (q) => {
      await this.lockColumn(q, status, groupId);

      const exists = await this.findByIdWith(q, id, groupId);
      if (!exists) return null;

      const params: unknown[] = [status, id];
      let scopeFilter = '';
      if (groupId !== undefined) {
        scopeFilter = ' AND group_id = $3';
        params.push(groupId);
      }
      const rows = await q<{ id: string }>(
        `SELECT id FROM tasks WHERE status = $1 AND id <> $2${scopeFilter} ORDER BY position, created_at`,
        params,
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
      return this.findByIdWith(q, id, groupId);
    });
  }

  // groupId (when set) scopes the update so a per-group caller can't assign another group's task;
  // RETURNING lets us report a cross-group / missing id as null → 404 rather than a silent no-op.
  async assign(id: string, userId: string, groupId?: string): Promise<Task | null> {
    const params: unknown[] = [id, userId];
    let scopeFilter = '';
    if (groupId !== undefined) {
      scopeFilter = ' AND group_id = $3';
      params.push(groupId);
    }
    const updated = await this.db.query(
      `UPDATE tasks SET assignee_id = $2, updated_at = now() WHERE id = $1${scopeFilter} RETURNING id`,
      params,
    );
    if (updated.length === 0) return null;
    return this.findById(id, groupId);
  }
}
