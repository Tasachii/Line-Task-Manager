import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { timingSafeEqual } from 'crypto';
import { Server, Socket } from 'socket.io';
import { Task } from '../tasks/dto/task.types';

// Broadcasts events to all connected board clients so they see updates in real time.
@WebSocketGateway({ cors: { origin: process.env.CORS_ORIGIN ?? '*' } })
export class EventsGateway implements OnGatewayConnection {
  @WebSocketServer()
  server: Server;

  // If BOARD_PASSWORD is set, the client must supply a matching auth.key on connect.
  handleConnection(client: Socket) {
    const password = process.env.BOARD_PASSWORD;
    if (!password) return;
    const key = client.handshake.auth?.key;
    if (typeof key !== 'string' || !safeEqual(key, password)) {
      client.disconnect(true);
    }
  }

  taskCreated(task: Task) {
    this.server.emit('task:created', task);
  }

  taskUpdated(task: Task) {
    this.server.emit('task:updated', task);
  }

  // Multiple card positions changed simultaneously (drag reorder) — clients should refetch the full board.
  tasksReordered() {
    this.server.emit('tasks:refresh');
  }
}

// Constant-time key comparison (see board-key.guard.ts for rationale).
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
