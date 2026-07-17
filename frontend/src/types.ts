export type TaskStatus = 'todo' | 'in_process' | 'test' | 'done';

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
  assignee_name?: string | null;
  priority: TaskPriority | null;
  due_date: string | null;
  position: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'todo', label: 'Todo' },
  { status: 'in_process', label: 'In Process' },
  { status: 'test', label: 'Test' },
  { status: 'done', label: 'Done' },
];
