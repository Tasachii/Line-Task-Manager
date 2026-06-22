// Unit tests for DTO validation via ValidationPipe (task.types.ts decorators).
import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';

const { UpdateStatusDto, MoveDto, AssignDto } = await import('../src/tasks/dto/task.types');

const pipe = new ValidationPipe({ whitelist: true, transform: true });
const meta = (metatype: unknown): ArgumentMetadata =>
  ({ type: 'body', metatype, data: '' }) as ArgumentMetadata;

async function expectReject(metatype: unknown, value: unknown) {
  await assert.rejects(() => pipe.transform(value, meta(metatype)), BadRequestException);
}

// UpdateStatusDto
test('UpdateStatusDto: invalid status → rejected', async () => {
  await expectReject(UpdateStatusDto, { status: 'nope' });
});
test('UpdateStatusDto: valid status → passes', async () => {
  const out = await pipe.transform({ status: 'done' }, meta(UpdateStatusDto));
  assert.equal(out.status, 'done');
});

// MoveDto
test('MoveDto: non-int index → rejected', async () => {
  await expectReject(MoveDto, { status: 'todo', index: 1.5 });
});
test('MoveDto: negative index (@Min 0) → rejected', async () => {
  await expectReject(MoveDto, { status: 'todo', index: -1 });
});
test('MoveDto: invalid status → rejected', async () => {
  await expectReject(MoveDto, { status: 'bad', index: 0 });
});
test('MoveDto: valid payload passes and whitelist strips unknown fields', async () => {
  const out = await pipe.transform(
    { status: 'in_process', index: 2, hacker: 'drop table' },
    meta(MoveDto),
  );
  assert.equal(out.status, 'in_process');
  assert.equal(out.index, 2);
  assert.equal('hacker' in out, false);
});

// AssignDto
test('AssignDto: empty userId (@MinLength 1) → rejected', async () => {
  await expectReject(AssignDto, { userId: '' });
});
test('AssignDto: missing optional displayName → passes', async () => {
  const out = await pipe.transform({ userId: 'U123' }, meta(AssignDto));
  assert.equal(out.userId, 'U123');
  assert.equal(out.displayName, undefined);
});
test('AssignDto: displayName provided → passes through', async () => {
  const out = await pipe.transform({ userId: 'U123', displayName: 'Nok' }, meta(AssignDto));
  assert.equal(out.displayName, 'Nok');
});
