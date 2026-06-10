import { Injectable } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { DatabaseService } from '../database/database.service';
import { NewTaskInput, Task, TaskStatus } from './dto/task.types';

@Injectable()
export class TasksRepository {
  constructor(private readonly db: DatabaseService) {}

  // กันซ้ำ: เคย process messageId นี้ไปแล้วหรือยัง
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

  // upsert user จาก LINE
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
    await this.db.query(
      `INSERT INTO tasks (id, title, description, status, source_message_id, group_id, created_by)
       VALUES ($1, $2, $3, 'todo', $4, $5, $6)`,
      [id, input.title, input.description, input.sourceMessageId, input.groupId, input.createdBy],
    );
    return (await this.findById(id))!;
  }

  // select มาตรฐาน join ชื่อคนรับงานมาด้วย
  private selectSql = `
    SELECT t.*, u.display_name AS assignee_name
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assignee_id`;

  async findAll(): Promise<Task[]> {
    return this.db.query<Task>(`${this.selectSql} ORDER BY t.status, t.position, t.created_at`);
  }

  async findById(id: string): Promise<Task | null> {
    const rows = await this.db.query<Task>(`${this.selectSql} WHERE t.id = $1`, [id]);
    return rows[0] ?? null;
  }

  async updateStatus(id: string, status: TaskStatus): Promise<Task | null> {
    await this.db.query(
      `UPDATE tasks SET status = $2, updated_at = now() WHERE id = $1`,
      [id, status],
    );
    return this.findById(id);
  }

  async assign(id: string, userId: string): Promise<Task | null> {
    await this.db.query(
      `UPDATE tasks SET assignee_id = $2, updated_at = now() WHERE id = $1`,
      [id, userId],
    );
    return this.findById(id);
  }
}
