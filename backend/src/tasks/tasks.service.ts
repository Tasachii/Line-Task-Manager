import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TasksRepository } from './tasks.repository';
import { EventsGateway } from '../realtime/events.gateway';
import { AppConfigService } from '../config/app-config.service';
import { NewTaskInput, Task, TaskStatus, TASK_STATUSES, UpdateTaskDto } from './dto/task.types';
import { NotificationOutboxService } from '../notifications/notification-outbox.service';

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
  private readonly notifyStatuses: Set<string>;
  private readonly notifyAssign: boolean;

  constructor(
    private readonly repo: TasksRepository,
    private readonly events: EventsGateway,
    private readonly config: AppConfigService,
    private readonly notifications: NotificationOutboxService,
  ) {
    this.notifyStatuses = new Set(
      this.config.notifyStatuses
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    this.notifyAssign = this.config.notifyAssign;
  }

  async createMany(inputs: NewTaskInput[]): Promise<Task[]> {
    const created: Task[] = [];
    for (const input of inputs) {
      // Under per-group isolation, keep each group's column contiguous so the group-scoped
      // board (which drags against a group-relative index) stays consistent with the DB.
      const scope = this.config.perGroupAuthEnabled ? input.groupId : undefined;
      const task = await this.repo.createTask(input, scope);
      this.events.taskCreated(task); // realtime broadcast
      created.push(task);
    }
    return created;
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
  ): Promise<Task[] | null> {
    const scope = this.config.perGroupAuthEnabled ? message.groupId : undefined;
    const created = await this.repo.claimMessageAndCreateTasks(message, inputs, scope);
    if (created) {
      for (const task of created) this.events.taskCreated(task);
    }
    return created;
  }

  // groupId scopes the read to one group (per-group board isolation); undefined returns all groups.
  findAll(groupId?: string): Promise<Task[]> {
    return this.repo.findAll(groupId);
  }

  // groupId (from the board key) scopes the write so a per-group caller can only mutate its own
  // group's tasks; a cross-group id resolves to null → NotFoundException (404).
  async changeStatus(id: string, status: TaskStatus, groupId?: string): Promise<Task> {
    if (!TASK_STATUSES.includes(status)) {
      // Invalid status is a bad request (400), not a missing resource (404).
      throw new BadRequestException(`unknown status: ${status}`);
    }
    const notificationText = this.notifyStatuses.has(status)
      ? (updated: Task) => this.statusNotification(updated, status)
      : undefined;
    const task = await this.repo.updateStatus(id, status, groupId, notificationText);
    if (!task) throw new NotFoundException('task not found');
    this.events.taskUpdated(task);
    if (notificationText) this.notifications.kick();
    return task;
  }

  // Drag card: changes both column and order — notifies LINE only on cross-column moves.
  // groupId scopes the write to the caller's group (cross-group id → 404).
  async move(id: string, status: TaskStatus, index: number, groupId?: string): Promise<Task> {
    const notificationText = this.notifyStatuses.has(status)
      ? (updated: Task) => this.statusNotification(updated, status)
      : undefined;
    const task = await this.repo.move(id, status, index, groupId, notificationText);
    if (!task) throw new NotFoundException('task not found');

    // Other cards in the column also shift positions — broadcast refresh so all clients re-fetch order.
    this.events.tasksReordered(task.group_id);
    if (notificationText) this.notifications.kick();
    return task;
  }

  // groupId scopes the write to the caller's group (cross-group id → 404).
  async assign(id: string, userId: string, displayName?: string, groupId?: string): Promise<Task> {
    if (displayName) {
      await this.repo.upsertUser(userId, displayName); // ensure user exists to avoid FK violation
    } else if (!(await this.repo.userExists(userId))) {
      // Unknown user with no display name supplied — return 400 explicitly rather than letting the FK fail as 500.
      throw new BadRequestException('unknown user — provide displayName');
    }
    const notificationText = this.notifyAssign
      ? (assigned: Task) => `🙋 ${assigned.assignee_name ?? displayName ?? 'มีคน'} รับงาน "${assigned.title}" แล้ว`
      : undefined;
    const task = await this.repo.assign(id, userId, groupId, notificationText);
    if (!task) throw new NotFoundException('task not found');
    this.events.taskUpdated(task);

    if (notificationText) this.notifications.kick();
    return task;
  }

  // Edit title/description/assignee — the fix for a bad LINE-parse (title/description) or a
  // wrong claim (assignee) without losing the card. groupId scopes the write like the other
  // mutators (cross-group id → 404). assigneeId reuses assign()'s user-resolution rule: a known
  // user id is accepted as-is, an unknown one requires assigneeName to upsert it first.
  async update(id: string, dto: UpdateTaskDto, groupId?: string): Promise<Task> {
    if (dto.assigneeId !== undefined) {
      if (dto.assigneeName) {
        await this.repo.upsertUser(dto.assigneeId, dto.assigneeName);
      } else if (!(await this.repo.userExists(dto.assigneeId))) {
        throw new BadRequestException('unknown user — provide assigneeName');
      }
    }
    const task = await this.repo.update(
      id,
      { title: dto.title, description: dto.description, assigneeId: dto.assigneeId },
      groupId,
    );
    if (!task) throw new NotFoundException('task not found');
    this.events.taskUpdated(task);
    return task;
  }

  // Soft-delete: card disappears from the board but the row (and its history) is kept.
  // groupId scopes the write to the caller's group (cross-group id → 404).
  async remove(id: string, groupId?: string): Promise<{ id: string }> {
    const deleted = await this.repo.softDelete(id, groupId);
    if (!deleted) throw new NotFoundException('task not found');
    this.events.taskDeleted(deleted.id, deleted.group_id);
    return { id: deleted.id };
  }

  private statusNotification(task: Task, status: TaskStatus): string {
    const who = task.assignee_name ? `\nผู้รับผิดชอบ: ${task.assignee_name}` : '';
    return `งาน: ${task.title}\nสถานะ → ${STATUS_LABELS[status]}${who}`;
  }
}
