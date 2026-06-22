// Unit tests for EventsGateway — WebSocket auth + group-scoped broadcast (A-4, A-8).
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Server, Socket } from 'socket.io';
import type { Task } from '../src/tasks/dto/task.types';
import { fakeConfig } from './helpers/config.mts';

const { EventsGateway } = await import('../src/realtime/events.gateway');
const { BoardAuthService } = await import('../src/auth/board-auth.service');

function makeGateway(overrides: Record<string, string | undefined> = {}) {
  const config = fakeConfig(overrides);
  return new EventsGateway(new BoardAuthService(config), config);
}

// Fake socket recording disconnect + room joins.
function fakeSocket(authKey?: unknown): Socket & { disconnected: boolean; rooms: string[] } {
  const s = {
    disconnected: false,
    rooms: [] as string[],
    handshake: { auth: authKey === undefined ? {} : { key: authKey } },
    disconnect(_close?: boolean) {
      this.disconnected = true;
      return this;
    },
    join(room: string) {
      this.rooms.push(room);
    },
  };
  return s as unknown as Socket & { disconnected: boolean; rooms: string[] };
}

test('no auth configured → connection kept', () => {
  const gw = makeGateway({ BOARD_PASSWORD: undefined, BOARD_GROUPS: undefined });
  const sock = fakeSocket('anything');
  gw.handleConnection(sock);
  assert.equal(sock.disconnected, false);
});

test('single BOARD_PASSWORD: correct auth.key → kept', () => {
  const gw = makeGateway({ BOARD_PASSWORD: 'pw' });
  const sock = fakeSocket('pw');
  gw.handleConnection(sock);
  assert.equal(sock.disconnected, false);
});

test('wrong key → disconnect(true)', () => {
  const gw = makeGateway({ BOARD_PASSWORD: 'pw' });
  const sock = fakeSocket('wrong');
  gw.handleConnection(sock);
  assert.equal(sock.disconnected, true);
});

test('missing key → disconnect(true)', () => {
  const gw = makeGateway({ BOARD_PASSWORD: 'pw' });
  const sock = fakeSocket(undefined);
  gw.handleConnection(sock);
  assert.equal(sock.disconnected, true);
});

test('non-string key → disconnect(true)', () => {
  const gw = makeGateway({ BOARD_PASSWORD: 'pw' });
  const sock = fakeSocket(12345);
  gw.handleConnection(sock);
  assert.equal(sock.disconnected, true);
});

// A-8: with per-group keys, a socket joins only its authorized group's room.
test('per-group: socket joins its group room; events go only to that room', () => {
  const groups = JSON.stringify({ groupA: 'keyA', groupB: 'keyB' });
  const gw = makeGateway({ BOARD_GROUPS: groups });
  const sock = fakeSocket('keyA');
  gw.handleConnection(sock);
  assert.equal(sock.disconnected, false);
  assert.deepEqual(sock.rooms, ['board:group:groupA']);

  const toRooms: { room: string; name: string; arg?: unknown }[] = [];
  gw.server = {
    to: (room: string) => ({
      emit: (name: string, arg?: unknown) => toRooms.push({ room, name, arg }),
    }),
    emit: () => assert.fail('should not broadcast globally in per-group mode'),
  } as unknown as Server;

  const taskA = { id: 't1', group_id: 'groupA' } as unknown as Task;
  gw.taskCreated(taskA);
  assert.deepEqual(toRooms, [{ room: 'board:group:groupA', name: 'task:created', arg: taskA }]);
});

test('single-tenant mode: taskCreated / taskUpdated / tasksReordered broadcast globally', () => {
  const gw = makeGateway({ BOARD_PASSWORD: 'pw' });
  const emitted: { name: string; arg?: unknown }[] = [];
  gw.server = { emit: (name: string, arg?: unknown) => emitted.push({ name, arg }) } as unknown as Server;

  const task = { id: 't1', title: 'x', group_id: 'G1' } as unknown as Task;
  gw.taskCreated(task);
  gw.taskUpdated(task);
  gw.tasksReordered('G1');

  assert.deepEqual(emitted[0], { name: 'task:created', arg: task });
  assert.deepEqual(emitted[1], { name: 'task:updated', arg: task });
  assert.equal(emitted[2].name, 'tasks:refresh');
});
