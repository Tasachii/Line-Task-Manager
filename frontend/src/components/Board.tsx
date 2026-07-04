import { useEffect, useRef, useState } from 'react';
import {
  closestCorners,
  DndContext,
  DragEndEvent,
  DragOverEvent,
  DragOverlay,
  DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { COLUMNS, Task, TaskStatus } from '../types';
import { assignTask, fetchTasks, moveTask } from '../api';
import { getSocket } from '../socket';
import { Column } from './Column';
import { TaskCard } from './TaskCard';

interface Props {
  currentMember: { id: string; name: string };
}

const COLUMN_IDS = COLUMNS.map((c) => c.status) as string[];

export function Board({ currentMember }: Props) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const dragging = useRef(false);

  // Require a 5px movement before drag starts (so button clicks inside cards still work).
  // KeyboardSensor makes cards operable without a pointer: focus a card, Space to pick up,
  // arrow keys to move between/within columns, Space to drop.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    fetchTasks().then(setTasks).catch((e) => setError(e.message));

    const socket = getSocket();
    const onCreated = (task: Task) => setTasks((prev) => [...prev, task]);
    const onUpdated = (task: Task) =>
      setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t)));
    // Multiple cards reordered simultaneously — refetch the board (skip if dragging to prevent card jitter)
    const onRefresh = () => {
      if (!dragging.current) fetchTasks().then(setTasks).catch(() => undefined);
    };
    const onDisconnect = () => setOffline(true);
    const onConnect = () => {
      setOffline(false);
      onRefresh(); // Reconnected — refetch latest state in case events were missed during disconnect
    };

    socket.on('task:created', onCreated);
    socket.on('task:updated', onUpdated);
    socket.on('tasks:refresh', onRefresh);
    socket.on('disconnect', onDisconnect);
    socket.on('connect', onConnect);
    return () => {
      socket.off('task:created', onCreated);
      socket.off('task:updated', onUpdated);
      socket.off('tasks:refresh', onRefresh);
      socket.off('disconnect', onDisconnect);
      socket.off('connect', onConnect);
    };
  }, []);

  // The hovered id during drag can be either a card or a column (when the column is empty)
  function findColumn(id: string): TaskStatus | undefined {
    if (COLUMN_IDS.includes(id)) return id as TaskStatus;
    return tasks.find((t) => t.id === id)?.status;
  }

  function handleDragStart(e: DragStartEvent) {
    dragging.current = true;
    setActiveId(String(e.active.id));
  }

  // While dragging across columns: update state immediately so the drop placeholder is visible
  function handleDragOver(e: DragOverEvent) {
    const { active, over } = e;
    if (!over) return;
    const activeCol = findColumn(String(active.id));
    const overCol = findColumn(String(over.id));
    if (!activeCol || !overCol || activeCol === overCol) return;

    setTasks((prev) => {
      const moving = prev.find((t) => t.id === active.id);
      if (!moving) return prev;
      const rest = prev.filter((t) => t.id !== active.id);
      const updated = { ...moving, status: overCol };
      const overIdx = rest.findIndex((t) => t.id === over.id);
      if (overIdx === -1) return [...rest, updated]; // hovering an empty column — append to end
      rest.splice(overIdx, 0, updated);
      return rest;
    });
  }

  async function handleDragEnd(e: DragEndEvent) {
    dragging.current = false;
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;

    const task = tasks.find((t) => t.id === active.id);
    if (!task) return;

    // Reorder within the same column (dropping onto another card)
    let next = tasks;
    if (over.id !== active.id && !COLUMN_IDS.includes(String(over.id))) {
      const overTask = tasks.find((t) => t.id === over.id);
      if (overTask && overTask.status === task.status) {
        const from = tasks.findIndex((t) => t.id === active.id);
        const to = tasks.findIndex((t) => t.id === over.id);
        next = arrayMove(tasks, from, to);
        setTasks(next);
      }
    }

    // Final position in column — call API (state already updated optimistically; refetch on failure)
    const index = next.filter((t) => t.status === task.status).findIndex((t) => t.id === task.id);
    try {
      await moveTask(task.id, task.status, Math.max(index, 0));
    } catch (err) {
      setError((err as Error).message);
      fetchTasks().then(setTasks).catch(() => undefined);
    }
  }

  async function handleAssign(task: Task) {
    try {
      await assignTask(task.id, currentMember.id, currentMember.name);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const activeTask = tasks.find((t) => t.id === activeId) ?? null;

  return (
    <>
      {offline && <p className="board__offline">⚠️ ขาดการเชื่อมต่อ realtime — กำลังต่อใหม่…</p>}
      {error && <p className="board__error">{error}</p>}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="board">
          {COLUMNS.map((col) => (
            <Column
              key={col.status}
              status={col.status}
              label={col.label}
              tasks={tasks.filter((t) => t.status === col.status)}
              onAssign={handleAssign}
            />
          ))}
        </div>
        <DragOverlay>
          {activeTask ? <TaskCard task={activeTask} onAssign={() => {}} overlay /> : null}
        </DragOverlay>
      </DndContext>
    </>
  );
}
