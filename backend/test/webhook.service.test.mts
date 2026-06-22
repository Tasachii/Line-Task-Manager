// Unit tests for WebhookService.handleEvents / handleOne (A-2).
// All four injected dependencies are mocked — no DB, LINE, or AI calls happen.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { webhook } from '@line/bot-sdk';
import { fakeConfig } from './helpers/config.mts';

const { WebhookService } = await import('../src/webhook/webhook.service');

type Call = { fn: string; args: unknown[] };

// Builds the four mocks with recorded calls and overridable return values.
function makeDeps() {
  const calls: Call[] = [];
  const rec = (fn: string) => (...args: unknown[]) => {
    calls.push({ fn, args });
  };
  const state = {
    messageExists: false,
    extracted: [] as unknown[],
    memberName: 'Nok',
    created: [{ id: 't1' }] as unknown[],
  };

  const line = {
    replyText: (...a: unknown[]) => { calls.push({ fn: 'replyText', args: a }); return Promise.resolve(); },
    getGroupMemberName: (...a: unknown[]) => {
      calls.push({ fn: 'getGroupMemberName', args: a });
      return Promise.resolve(state.memberName);
    },
    pushToGroup: (...a: unknown[]) => { calls.push({ fn: 'pushToGroup', args: a }); return Promise.resolve(); },
  };
  const tasks = {
    createMany: (...a: unknown[]) => {
      calls.push({ fn: 'createMany', args: a });
      return Promise.resolve(state.created);
    },
  };
  const repo = {
    messageExists: (...a: unknown[]) => {
      calls.push({ fn: 'messageExists', args: a });
      return Promise.resolve(state.messageExists);
    },
    saveMessage: (...a: unknown[]) => { calls.push({ fn: 'saveMessage', args: a }); return Promise.resolve(); },
    upsertUser: (...a: unknown[]) => { calls.push({ fn: 'upsertUser', args: a }); return Promise.resolve(); },
  };
  const extractor = {
    extract: (...a: unknown[]) => {
      calls.push({ fn: 'extract', args: a });
      return Promise.resolve(state.extracted);
    },
  };

  const svc = new WebhookService(
    line as never,
    tasks as never,
    repo as never,
    extractor as never,
    fakeConfig(),
  );
  void rec; // rec kept for clarity; explicit closures above record calls
  const has = (fn: string) => calls.some((c) => c.fn === fn);
  const countOf = (fn: string) => calls.filter((c) => c.fn === fn).length;
  const argsOf = (fn: string) => calls.find((c) => c.fn === fn)?.args;
  return { svc, calls, state, has, countOf, argsOf };
}

function textMessage(text: string, over: Partial<Record<string, unknown>> = {}): webhook.Event {
  return {
    type: 'message',
    message: { type: 'text', id: 'm1', text },
    source: { type: 'group', groupId: 'G1', userId: 'U1' },
    replyToken: 'rt1',
    timestamp: Date.now(),
    mode: 'active',
    ...over,
  } as unknown as webhook.Event;
}

beforeEach(() => { process.env.TASK_KEYWORD = '/task'; });
afterEach(() => { delete process.env.TASK_KEYWORD; });

test('dedupe-skip: messageExists true → no save/extract/createMany', async () => {
  const d = makeDeps();
  d.state.messageExists = true;
  await d.svc.handleEvents([textMessage('/task x')]);
  assert.equal(d.has('messageExists'), true);
  assert.equal(d.has('saveMessage'), false);
  assert.equal(d.has('extract'), false);
  assert.equal(d.has('createMany'), false);
});

test('new message with a task → saved, extracted, created, confirmation replied', async () => {
  const d = makeDeps();
  d.state.extracted = [{ title: 'T', description: 'T', priority: undefined, dueDate: undefined }];
  await d.svc.handleEvents([textMessage('/task T')]);
  assert.equal(d.has('saveMessage'), true);
  assert.equal(d.has('getGroupMemberName'), true);
  assert.equal(d.has('upsertUser'), true);
  assert.equal(d.has('createMany'), true);
  // Confirmation reply sent with the created count.
  const reply = d.calls.find((c) => c.fn === 'replyText');
  assert.ok(reply, 'replyText called');
  assert.match(String(reply!.args[1]), /1/);
});

test('extraction empty → no task created, no reply', async () => {
  const d = makeDeps();
  d.state.extracted = [];
  await d.svc.handleEvents([textMessage('just chatting')]);
  assert.equal(d.has('saveMessage'), true);
  assert.equal(d.has('createMany'), false);
  assert.equal(d.has('replyText'), false);
});

test('join event with replyToken → greeting sent, then returns', async () => {
  const d = makeDeps();
  const join = { type: 'join', replyToken: 'rt-join', timestamp: Date.now(), mode: 'active' } as unknown as webhook.Event;
  await d.svc.handleEvents([join]);
  assert.equal(d.has('replyText'), true);
  assert.match(String(d.argsOf('replyText')![1]), /Task Manager Bot/);
  assert.equal(d.has('messageExists'), false);
});

test('join without replyToken → no reply', async () => {
  const d = makeDeps();
  const join = { type: 'join', timestamp: Date.now(), mode: 'active' } as unknown as webhook.Event;
  await d.svc.handleEvents([join]);
  assert.equal(d.has('replyText'), false);
});

test('non-message event (follow) → ignored', async () => {
  const d = makeDeps();
  const follow = { type: 'follow', source: { type: 'user', userId: 'U1' }, timestamp: Date.now(), mode: 'active' } as unknown as webhook.Event;
  await d.svc.handleEvents([follow]);
  assert.equal(d.has('messageExists'), false);
});

test('message but non-text (image) → ignored', async () => {
  const d = makeDeps();
  const img = textMessage('x', { message: { type: 'image', id: 'i1' } });
  await d.svc.handleEvents([img]);
  assert.equal(d.has('messageExists'), false);
});

test('text but non-group source (user) → ignored', async () => {
  const d = makeDeps();
  const dm = textMessage('/task x', { source: { type: 'user', userId: 'U1' } });
  await d.svc.handleEvents([dm]);
  assert.equal(d.has('messageExists'), false);
});

test('one failing event does not abort the batch', async () => {
  const d = makeDeps();
  d.state.extracted = [{ title: 'T', description: 'T' }];
  // Make the second event throw by giving it a message id that triggers a repo error.
  let firstSeen = false;
  const repoSvc = d.svc as unknown as { repo: { messageExists: (id: string) => Promise<boolean> } };
  const origRepo = repoSvc.repo.messageExists.bind(repoSvc.repo);
  repoSvc.repo.messageExists = (id: string) => {
    if (id === 'BOOM') throw new Error('db down');
    return origRepo(id);
  };
  const e1 = textMessage('/task one', { message: { type: 'text', id: 'm-ok-1', text: '/task one' } });
  const eBoom = textMessage('/task boom', { message: { type: 'text', id: 'BOOM', text: '/task boom' } });
  const e3 = textMessage('/task three', { message: { type: 'text', id: 'm-ok-3', text: '/task three' } });
  await d.svc.handleEvents([e1, eBoom, e3]);
  // The failing middle event did not prevent the third from being processed.
  const saved = d.calls.filter((c) => c.fn === 'saveMessage').map((c) => c.args[0]);
  assert.ok(saved.includes('m-ok-1'));
  assert.ok(saved.includes('m-ok-3'));
});

test('userId fallback to "unknown" when source.userId is missing', async () => {
  const d = makeDeps();
  d.state.extracted = [{ title: 'T', description: 'T' }];
  const ev = textMessage('/task T', { source: { type: 'group', groupId: 'G1' } });
  await d.svc.handleEvents([ev]);
  const saved = d.argsOf('saveMessage');
  assert.equal(saved![2], 'unknown'); // (messageId, groupId, userId, content)
});

test('no replyToken → tasks created but no confirmation reply', async () => {
  const d = makeDeps();
  d.state.extracted = [{ title: 'T', description: 'T' }];
  const ev = textMessage('/task T', { replyToken: undefined });
  await d.svc.handleEvents([ev]);
  assert.equal(d.has('createMany'), true);
  assert.equal(d.has('replyText'), false);
});
