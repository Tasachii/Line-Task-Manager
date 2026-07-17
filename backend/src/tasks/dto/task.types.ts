import { IsIn, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

export type TaskStatus = 'todo' | 'in_process' | 'test' | 'done';

export const TASK_STATUSES: TaskStatus[] = ['todo', 'in_process', 'test', 'done'];

export type TaskPriority = 'low' | 'medium' | 'high';

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  source_message_id: string | null;
  group_id: string;
  created_by: string | null;
  assignee_id: string | null;
  assignee_name?: string | null; // populated via JOIN with users
  priority: TaskPriority | null;
  due_date: string | null;
  position: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null; // soft-delete marker; non-null tasks are excluded from board queries
}

// Data produced by the extractor before it becomes an actual database row.
export interface NewTaskInput {
  title: string;
  description: string;
  groupId: string;
  sourceMessageId: string;
  createdBy: string;
  priority?: TaskPriority;
  dueDate?: string; // YYYY-MM-DD
}

// DTOs are classes so ValidationPipe can inspect the actual payload before it reaches the service.
export class UpdateStatusDto {
  @IsIn(TASK_STATUSES)
  status: TaskStatus;
}

export class MoveDto {
  @IsIn(TASK_STATUSES)
  status: TaskStatus;

  @IsInt()
  @Min(0)
  index: number; // target position within the destination column
}

export class AssignDto {
  @IsString()
  @MinLength(1)
  userId: string;

  @IsOptional()
  @IsString()
  displayName?: string; // for board members not yet present in the users table
}

// Edit a card's title/description/assignee. All fields optional — only supplied fields change.
export class UpdateTaskDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  assigneeId?: string;

  @IsOptional()
  @IsString()
  assigneeName?: string; // for board members not yet present in the users table (same as AssignDto)
}
