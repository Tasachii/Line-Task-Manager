import test from 'node:test';
import assert from 'node:assert/strict';
const { runOperator } = await import('../src/notifications/outbox-operator');

test('command requires one explicit redrive target and a dedicated database URL', async t => {
  const stderr = t.mock.method(console, 'error', () => {});
  for (const args of [[], ['redrive'], ['redrive', '--all'], ['list', 'private-value'], ['list', '', 'extra']]) {
    assert.equal(await runOperator(args, undefined), 2);
  }
  assert.equal(await runOperator(['list'], undefined), 2);
  assert.ok(!JSON.stringify(stderr.mock.calls).includes('private-value'));
});
