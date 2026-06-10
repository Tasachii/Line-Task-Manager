import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TasksRepository } from './tasks.repository';
import { EventsGateway } from '../realtime/events.gateway';
import { LineClientService } from '../line/line-client.service';
import { NewTaskInput, Task, TaskStatus, TASK_STATUSES } from './dto/task.types';

// ป้ายสถานะภาษาไทยสำหรับข้อความแจ้งเตือนในกลุ่ม
const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: '📥 Todo (รอรับงาน)',
  in_process: '🔧 In Process (กำลังทำ)',
  test: '🧪 Test (กำลังเทส)',
  done: '✅ Done (เสร็จแล้ว)',
};

@Injectable()
export class TasksService {
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
      throw new NotFoundException(`unknown status: ${status}`);
    }
    const task = await this.repo.updateStatus(id, status);
    if (!task) throw new NotFoundException('task not found');
    this.events.taskUpdated(task);

    // แจ้งความคืบหน้ากลับเข้ากลุ่ม LINE (fire-and-forget — push พังไม่กระทบ API)
    const who = task.assignee_name ? `\nผู้รับผิดชอบ: ${task.assignee_name}` : '';
    void this.line.pushToGroup(
      task.group_id,
      `งาน: ${task.title}\nสถานะ → ${STATUS_LABELS[status]}${who}`,
    );
    return task;
  }

  async assign(id: string, userId: string, displayName?: string): Promise<Task> {
    if (displayName) {
      await this.repo.upsertUser(userId, displayName); // กัน FK พังถ้ายังไม่มี user นี้
    } else if (!(await this.repo.userExists(userId))) {
      // ไม่มี user และไม่ส่งชื่อมา → ตอบ 400 ชัดๆ แทนปล่อยให้ FK พังเป็น 500
      throw new BadRequestException('unknown user — provide displayName');
    }
    const task = await this.repo.assign(id, userId);
    if (!task) throw new NotFoundException('task not found');
    this.events.taskUpdated(task);

    void this.line.pushToGroup(
      task.group_id,
      `🙋 ${task.assignee_name ?? displayName ?? 'มีคน'} รับงาน "${task.title}" แล้ว`,
    );
    return task;
  }
}
