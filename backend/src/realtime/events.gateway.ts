import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Task } from '../tasks/dto/task.types';
import { BoardAuthService } from '../auth/board-auth.service';
import { AppConfigService } from '../config/app-config.service';

// Room a task belongs to when per-group isolation is active. Single-tenant/dev mode uses
// one shared room so existing single-group deploys keep broadcasting to everyone.
const ALL_ROOM = 'board:all';
function roomFor(groupId: string | undefined): string {
  return groupId === undefined ? ALL_ROOM : `board:group:${groupId}`;
}

// Broadcasts events to connected board clients so they see updates in real time. When
// BOARD_GROUPS is configured, each socket joins only its authorized group's room, so a client
// holding group A's key never receives group B's task events (A-8/D-3 realtime scoping).
// CORS is applied by ConfiguredIoAdapter (main.ts) from AppConfigService, not read here.
@WebSocketGateway()
export class EventsGateway implements OnGatewayConnection {
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly auth: BoardAuthService,
    private readonly config: AppConfigService,
  ) {}

  // Authenticate on connect: resolve the auth.key to its group_id and join that room.
  // A failed resolution disconnects the socket.
  handleConnection(client: Socket) {
    const result = this.auth.resolve(client.handshake.auth?.key);
    if (!result.ok) {
      client.disconnect(true);
      return;
    }
    client.join(roomFor(result.groupId));
  }

  taskCreated(task: Task) {
    this.emit('task:created', task, task.group_id);
  }

  taskUpdated(task: Task) {
    this.emit('task:updated', task, task.group_id);
  }

  // Multiple card positions changed simultaneously (drag reorder) — clients refetch the full board.
  // groupId scopes the refresh to one group when per-group isolation is active.
  tasksReordered(groupId?: string) {
    this.emit('tasks:refresh', undefined, groupId);
  }

  // Emit to the group's room when per-group isolation is on; broadcast to everyone otherwise.
  private emit(event: string, payload: Task | undefined, groupId: string | undefined) {
    if (!this.server) return;
    if (this.config.perGroupAuthEnabled) {
      this.server.to(roomFor(groupId)).emit(event, payload);
    } else {
      this.server.emit(event, payload);
    }
  }
}
