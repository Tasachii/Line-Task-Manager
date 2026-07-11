// Unit tests for TaskExtractionService.extractByAI — the AI intake path (A-3, A-13, A-14).
// The Anthropic client is replaced with a stub so no live API call is made.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { fakeConfig } from './helpers/config.mts';

const { TaskExtractionService } = await import('../src/tasks/task-extraction.service');

type CreateFn = (args: unknown) => Promise<unknown>;

// Build a service whose private `anthropic` client is replaced with a stub.
function withStub(create: CreateFn) {
  const svc = new TaskExtractionService(fakeConfig({ ANTHROPIC_API_KEY: 'test' }));
  let lastArgs: unknown;
  const wrapped: CreateFn = (args) => {
    lastArgs = args;
    return create(args);
  };
  (svc as unknown as { anthropic: unknown }).anthropic = { messages: { create: wrapped } };
  return { svc, getLastArgs: () => lastArgs };
}

let savedKey: string | undefined;
let savedKeyword: string | undefined;
beforeEach(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  savedKeyword = process.env.TASK_KEYWORD;
  process.env.ANTHROPIC_API_KEY = 'test';
  process.env.TASK_KEYWORD = '/task';
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  if (savedKeyword === undefined) delete process.env.TASK_KEYWORD;
  else process.env.TASK_KEYWORD = savedKeyword;
});

// A response that returns the structured payload only in a `text` block (older shape).
const asTextBlock = (obj: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(obj) }],
});
// A-13: the SDK surfaces the parsed result in `parsed_output` with NO text block.
const asParsedOutput = (obj: unknown) => ({ parsed_output: obj, content: [] });

test('schema-parse happy path → mapped fields, title truncated', async () => {
  const longTitle = 'ก'.repeat(80);
  const { svc } = withStub(async () =>
    asTextBlock({
      tasks: [
        { title: longTitle, description: 'full description', priority: 'high', due_date: '2026-07-01' },
      ],
    }),
  );
  const out = await svc.extract('please fix the login bug');
  assert.equal(out.length, 1);
  assert.equal(out[0].description, 'full description');
  assert.equal(out[0].priority, 'high');
  assert.equal(out[0].dueDate, '2026-07-01');
  assert.ok(out[0].title.endsWith('…'), 'long AI title is truncated');
});

test('due_date null → dueDate undefined', async () => {
  const { svc } = withStub(async () =>
    asTextBlock({ tasks: [{ title: 'งาน', description: 'd', due_date: null }] }),
  );
  const out = await svc.extract('a free-form request');
  assert.equal(out[0].dueDate, undefined);
});

test('due_date present → passed through', async () => {
  const { svc } = withStub(async () =>
    asTextBlock({ tasks: [{ title: 'งาน', description: 'd', due_date: '2026-08-15' }] }),
  );
  const out = await svc.extract('another request');
  assert.equal(out[0].dueDate, '2026-08-15');
});

test('create rejects → throws unavailable instead of impersonating a no-task result', async () => {
  const { svc } = withStub(async () => {
    throw new Error('boom');
  });
  await assert.rejects(svc.extract('something'), {
    name: 'TaskExtractionUnavailableError',
    message: 'AI task extraction temporarily unavailable',
  });
});

test('timeout/abort error → throws unavailable so LINE can retry', async () => {
  const { svc } = withStub(async () => {
    const err = new Error('Request was aborted');
    err.name = 'AbortError';
    throw err;
  });
  await assert.rejects(svc.extract('something else'), {
    name: 'TaskExtractionUnavailableError',
    message: 'AI task extraction temporarily unavailable',
  });
});

test('missing structured result → throws unavailable rather than claiming as no-task', async () => {
  const { svc } = withStub(async () => ({ content: [] }));
  await assert.rejects(svc.extract('please do something'), {
    name: 'TaskExtractionUnavailableError',
  });
});

// A-13 guard: structured result delivered via parsed_output only (no text block).
// FAILS against the old code (which only read a text block, falling back to {"tasks":[]}).
test('A-13: parsed_output-only response still extracts tasks', async () => {
  const { svc } = withStub(async () =>
    asParsedOutput({
      tasks: [{ title: 'แก้บั๊ก', description: 'fix the bug', priority: 'medium', due_date: null }],
    }),
  );
  const out = await svc.extract('there is a bug in checkout');
  assert.equal(out.length, 1, 'tasks must be read from parsed_output');
  assert.equal(out[0].title, 'แก้บั๊ก');
  assert.equal(out[0].priority, 'medium');
});

test('empty tasks array → no tasks', async () => {
  const { svc } = withStub(async () => asParsedOutput({ tasks: [] }));
  assert.deepEqual(await svc.extract('สวัสดีครับ'), []);
});

test('invalid priority enum → retryable unavailable error', async () => {
  const { svc } = withStub(async () =>
    asParsedOutput({
      tasks: [{ title: 'งาน', description: 'รายละเอียด', priority: 'urgent' }],
    }),
  );
  await assert.rejects(svc.extract('please do this urgently'), {
    name: 'TaskExtractionUnavailableError',
  });
});

test('invalid field types, blank required fields, and extra keys are rejected', async () => {
  const invalidTasks = [
    { title: 42, description: 'รายละเอียด' },
    { title: '   ', description: 'รายละเอียด' },
    { title: 'งาน', description: false },
    { title: 'งาน', description: 'รายละเอียด', unexpected: true },
  ];
  for (const task of invalidTasks) {
    const { svc } = withStub(async () => asParsedOutput({ tasks: [task] }));
    await assert.rejects(svc.extract('please do this'), {
      name: 'TaskExtractionUnavailableError',
    });
  }
});

test('due_date must be a real strict YYYY-MM-DD calendar date', async () => {
  for (const due_date of ['2026-02-30', '2026-2-03', '0000-01-01', 20260701]) {
    const { svc } = withStub(async () =>
      asParsedOutput({ tasks: [{ title: 'งาน', description: 'รายละเอียด', due_date }] }),
    );
    await assert.rejects(svc.extract('please do this by a date'), {
      name: 'TaskExtractionUnavailableError',
    });
  }
});

test('keyword path bypasses AI even when ANTHROPIC_API_KEY is set', async () => {
  let called = false;
  const { svc } = withStub(async () => {
    called = true;
    return asTextBlock({ tasks: [] });
  });
  const out = await svc.extract('/task แก้ปุ่ม login');
  assert.equal(called, false, 'keyword messages must never call the AI');
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'แก้ปุ่ม login');
});
