import { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { Task } from '../types';

interface Props {
  task: Task;
  onAssign: (task: Task) => void;
  onEdit: (task: Task, patch: { title: string; description: string }) => void | Promise<void>;
  onDelete: (task: Task) => void;
  overlay?: boolean; // card floating under the pointer during a drag
}

// Due date has passed and task is not done — flag as overdue.
// Compare YYYY-MM-DD strings lexicographically to stay timezone-agnostic
// (Date parsing of a bare date is UTC-midnight and can flip the result near midnight).
function todayLocalISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isOverdue(task: Task): boolean {
  if (!task.due_date || task.status === 'done') return false;
  return task.due_date.slice(0, 10) < todayLocalISO();
}

export function TaskCard({ task, onAssign, onEdit, onDelete, overlay }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  });
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);

  const style: React.CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition,
    opacity: isDragging && !overlay ? 0.4 : 1,
  };

  function startEdit() {
    setTitle(task.title);
    setDescription(task.description);
    setEditing(true);
  }

  async function saveEdit() {
    const trimmed = title.trim();
    if (!trimmed) return; // title required — keep editing rather than submit an empty title
    await onEdit(task, { title: trimmed, description });
    setEditing(false);
  }

  function handleDelete() {
    if (window.confirm(`ลบการ์ด "${task.title}" ใช่หรือไม่? (กู้คืนไม่ได้จากหน้าบอร์ด)`)) {
      onDelete(task);
    }
  }

  if (editing) {
    return (
      <div
        ref={setNodeRef}
        style={style}
        className="card card--editing"
        onPointerDown={(e) => e.stopPropagation()} // editing a card must never start a drag
      >
        <input
          className="card__edit-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="ชื่องาน"
          autoFocus
        />
        <textarea
          className="card__edit-textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="รายละเอียด"
          rows={3}
        />
        <div className="card__edit-actions">
          <button className="card__take" onClick={saveEdit}>บันทึก</button>
          <button className="card__cancel" onClick={() => setEditing(false)}>ยกเลิก</button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`card ${overlay ? 'card--overlay' : ''}`}
      aria-label={`การ์ดงาน: ${task.title}`}
      {...listeners}
      {...attributes}
    >
      <div className="card__head">
        <p className="card__title">{task.title}</p>
        {!overlay && (
          <div className="card__actions">
            <button
              className="card__icon-btn"
              title="แก้ไข"
              aria-label={`แก้ไขการ์ดงาน: ${task.title}`}
              onClick={(e) => {
                e.stopPropagation();
                startEdit();
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              ✏️
            </button>
            <button
              className="card__icon-btn"
              title="ลบ"
              aria-label={`ลบการ์ดงาน: ${task.title}`}
              onClick={(e) => {
                e.stopPropagation();
                handleDelete();
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              🗑️
            </button>
          </div>
        )}
      </div>
      {task.description !== task.title && (
        <p className="card__desc">{task.description}</p>
      )}
      {(task.priority || task.due_date) && (
        <div className="card__badges">
          {task.priority && (
            <span className={`badge badge--${task.priority}`}>
              {task.priority === 'high' ? '🔥 ด่วน' : task.priority === 'low' ? 'ไม่เร่ง' : 'ปกติ'}
            </span>
          )}
          {task.due_date && (
            <span className={`badge badge--due ${isOverdue(task) ? 'badge--overdue' : ''}`}>
              📅 {task.due_date.slice(0, 10)}
            </span>
          )}
        </div>
      )}
      <div className="card__meta">
        {task.assignee_id ? (
          <span className="card__assignee">● {task.assignee_name ?? task.assignee_id}</span>
        ) : (
          <button
            className="card__take"
            onClick={(e) => {
              e.stopPropagation();
              onAssign(task);
            }}
            onPointerDown={(e) => e.stopPropagation()} // prevent pointer-down from initiating a drag
          >
            รับงาน
          </button>
        )}
      </div>
    </div>
  );
}
