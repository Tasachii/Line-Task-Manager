import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TasksRepository } from './tasks.repository';
import { EventsGateway } from '../realtime/events.gateway';
import { LineClientService } from '../line/line-client.service';
import { NewTaskInput, Task, TaskStatus, TASK_STATUSES } from './dto/task.types';

// Thai status labels used in LINE group notification messages.
const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: '📥 Todo (รอรับงาน)',
  in_process: '🔧 In Process (กำลังทำ)',
  test: '🧪 Test (กำลังเทส)',
  done: '✅ Done (เสร็จแล้ว)',
};

@Injectable()
export class TasksService {
  // Configurable set of statuses that trigger a group notification (reduces spam and OA quota usage).
  private notifyStatuses = new Set(
    (process.env.NOTIFY_STATUSES ?? 'todo,in_process,test,done')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  private notifyAssign = (process.env.NOTIFY_ASSIGN ?? 'true') !== 'false';

  constructor(
    private readonly repo: TasksRepository,
    private readonly events: EventsGateway,
    private readonly line: LineClientService,
  ) {}

  async createMany(inputs: NewTaskInput[]): Promise<Task[]> {
    const created: Task[] = [];
    for (const input of inputs) {
      const task = await this.repo.createTask(input);
      this.events.taskCreated(task); // realtime broadcast
      created.push(task);
    }
    return created;
  }

  findAll(): Promise<Task[]> {
    return this.repo.findAll();
  }

  async changeStatus(id: string, status: TaskStatus): Promise<Task> {
    if (!TASK_STATUSES.includes(status)) {
      // Invalid status is a bad request (400), not a missing resource (404).
      throw new BadRequestException(`unknown status: ${status}`);
    }
    const task = await this.repo.updateStatus(id, status);
    if (!task) throw new NotFoundException('task not found');
    this.events.taskUpdated(task);
    this.notifyStatusChange(task, status);
    return task;
  }

  // Drag card: changes both column and order — notifies LINE only on cross-column moves.
  async move(id: string, status: TaskStatus, index: number): Promise<Task> {
    const before = await this.repo.findById(id);
    if (!before) throw new NotFoundException('task not found');

    const task = await this.repo.move(id, status, index);
    if (!task) throw new NotFoundException('task not found');

    // Other cards in the column also shift positions — broadcast refresh so all clients re-fetch order.
    this.events.tasksReordered();
    if (before.status !== status) this.notifyStatusChange(task, status);
    return task;
  }

  async assign(id: string, userId: string, displayName?: string): Promise<Task> {
    if (displayName) {
      await this.repo.upsertUser(userId, displayName); // ensure user exists to avoid FK violation
    } else if (!(await this.repo.userExists(userId))) {
      // Unknown user with no display name supplied — return 400 explicitly rather than letting the FK fail as 500.
      throw new BadRequestException('unknown user — provide displayName');
    }
    const task = await this.repo.assign(id, userId);
    if (!task) throw new NotFoundException('task not found');
    this.events.taskUpdated(task);

    if (this.notifyAssign) {
      void this.line.pushToGroup(
        task.group_id,
        `🙋 ${task.assignee_name ?? displayName ?? 'มีคน'} รับงาน "${task.title}" แล้ว`,
      );
    }
    return task;
  }

  // Notifies the LINE group of a status change (fire-and-forget — push failure does not affect the API).
  private notifyStatusChange(task: Task, status: TaskStatus) {
    if (!this.notifyStatuses.has(status)) return;
    const who = task.assignee_name ? `\nผู้รับผิดชอบ: ${task.assignee_name}` : '';
    void this.line.pushToGroup(
      task.group_id,
      `งาน: ${task.title}\nสถานะ → ${STATUS_LABELS[status]}${who}`,
    );
  }
}
