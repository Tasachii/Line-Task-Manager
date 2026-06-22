// Unit tests for the extracted constant-time comparison (A-12 / D-5).
import test from 'node:test';
import assert from 'node:assert/strict';

const { safeEqual } = await import('../src/common/safe-equal');

test('equal strings → true', () => {
  assert.equal(safeEqual('s3cret', 's3cret'), true);
});

test('differing same-length strings → false', () => {
  assert.equal(safeEqual('abcdef', 'abcxef'), false);
});

test('differing length → false (no throw from timingSafeEqual)', () => {
  assert.equal(safeEqual('short', 'longer-key'), false);
  assert.equal(safeEqual('', 'x'), false);
});

test('empty vs empty → true', () => {
  assert.equal(safeEqual('', ''), true);
});

test('non-ASCII multi-byte handled by UTF-8 byte length', () => {
  // Identical multi-byte strings match.
  assert.equal(safeEqual('ผ่าน', 'ผ่าน'), true);
  // Same grapheme count but different bytes → false, and must not throw.
  assert.equal(safeEqual('ก', 'ข'), false);
});
