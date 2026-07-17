import { Task, TaskStatus } from './types';

// Dev proxy forwards /tasks to the backend; in production nginx handles the proxy
const BASE = '';

export class AuthError extends Error {
  constructor() {
    super('ต้องใส่รหัสผ่านบอร์ด');
  }
}

export function getBoardKey(): string {
  return localStorage.getItem('ltm_key') ?? '';
}

export function setBoardKey(key: string) {
  localStorage.setItem('ltm_key', key);
}

function headers(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-board-key': getBoardKey() };
}

async function handle<T>(res: Response, errMsg: string): Promise<T> {
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(errMsg);
  return res.json();
}

export async function fetchTasks(): Promise<Task[]> {
  const res = await fetch(`${BASE}/tasks`, { headers: headers() });
  return handle(res, 'โหลด tasks ไม่สำเร็จ');
}

export async function updateStatus(id: string, status: TaskStatus): Promise<Task> {
  const res = await fetch(`${BASE}/tasks/${id}/status`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify({ status }),
  });
  return handle(res, 'เปลี่ยนสถานะไม่สำเร็จ');
}

// Move card: specify the target column and position within that column
export async function moveTask(id: string, status: TaskStatus, index: number): Promise<Task> {
  const res = await fetch(`${BASE}/tasks/${id}/move`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify({ status, index }),
  });
  return handle(res, 'ย้ายการ์ดไม่สำเร็จ');
}

export async function assignTask(id: string, userId: string, displayName: string): Promise<Task> {
  const res = await fetch(`${BASE}/tasks/${id}/assign`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ userId, displayName }),
  });
  return handle(res, 'รับงานไม่สำเร็จ');
}

// Edit a card's title/description (fixes a bad LINE parse without losing the card).
export async function updateTask(
  id: string,
  patch: { title?: string; description?: string },
): Promise<Task> {
  const res = await fetch(`${BASE}/tasks/${id}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify(patch),
  });
  return handle(res, 'แก้ไขการ์ดไม่สำเร็จ');
}

// Soft-delete a card — it disappears from the board but the row is kept for history.
export async function deleteTask(id: string): Promise<void> {
  const res = await fetch(`${BASE}/tasks/${id}`, {
    method: 'DELETE',
    headers: headers(),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error('ลบการ์ดไม่สำเร็จ');
}
