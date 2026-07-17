import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Task, TaskStatus } from '../types';
import { TaskCard } from './TaskCard';

interface Props {
  status: TaskStatus;
  label: string;
  tasks: Task[];
  onAssign: (task: Task) => void;
  onEdit: (task: Task, patch: { title: string; description: string }) => void | Promise<void>;
  onDelete: (task: Task) => void;
}

export function Column({ status, label, tasks, onAssign, onEdit, onDelete }: Props) {
  // droppable covers empty columns (an empty SortableContext has no drop target area)
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <section className={`col col--${status}`}>
      <header className="col__head">
        <span className="col__label">{label}</span>
        <span className="col__count">{tasks.length}</span>
      </header>
      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className={`col__drop ${isOver ? 'col__drop--over' : ''}`}>
          {tasks.map((t) => (
            <TaskCard key={t.id} task={t} onAssign={onAssign} onEdit={onEdit} onDelete={onDelete} />
          ))}
          {tasks.length === 0 && <p className="col__empty">— ว่าง —</p>}
        </div>
      </SortableContext>
    </section>
  );
}
