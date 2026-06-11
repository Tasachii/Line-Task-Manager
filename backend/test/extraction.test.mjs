// Unit tests for the task extractor — run against built code: npm run build && npm test
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TASK_KEYWORD = '/task';
delete process.env.ANTHROPIC_API_KEY; // disable AI — test keyword path only

const { TaskExtractionService } = await import('../dist/tasks/task-extraction.service.js');
const svc = new TaskExtractionService();

test('multiple lines produce multiple tasks', async () => {
  const out = await svc.extract('/task แก้ปุ่ม login\nเปลี่ยนสีปุ่ม');
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'แก้ปุ่ม login');
  assert.equal(out[1].title, 'เปลี่ยนสีปุ่ม');
});

test('no keyword and no AI → skip message', async () => {
  assert.deepEqual(await svc.extract('สวัสดีครับ วันนี้กินข้าวยัง'), []);
});

test('keyword is matched case-insensitively', async () => {
  const out = await svc.extract('/TASK ทดสอบ');
  assert.equal(out.length, 1);
});

test('bare /task with no body → no tasks created', async () => {
  assert.deepEqual(await svc.extract('/task'), []);
  assert.deepEqual(await svc.extract('/task   \n  '), []);
});

test('!ด่วน → priority high and token stripped from title', async () => {
  const out = await svc.extract('/task แก้ระบบจ่ายเงิน !ด่วน');
  assert.equal(out[0].priority, 'high');
  assert.ok(!out[0].title.includes('!ด่วน'));
});

test('!low → priority low', async () => {
  const out = await svc.extract('/task ปรับสีปุ่ม !low');
  assert.equal(out[0].priority, 'low');
});

test('@YYYY-MM-DD → due date parsed and stripped from title', async () => {
  const out = await svc.extract('/task ส่งรายงาน @2026-07-01');
  assert.equal(out[0].dueDate, '2026-07-01');
  assert.ok(!out[0].title.includes('@2026'));
});

test('title truncated at 60 graphemes + … (Thai vowels not split)', async () => {
  const long = 'กี่'.repeat(70); // 70 Thai graphemes with vowels+tone marks (210 code points)
  const out = await svc.extract(`/task ${long}`);
  assert.ok(out[0].title.endsWith('…'));
  // exactly 60 graphemes + ellipsis, must not end with a dangling combining vowel
  const seg = [...new Intl.Segmenter('th', { granularity: 'grapheme' }).segment(out[0].title)];
  assert.equal(seg.length, 61);
});

test('short title is not truncated', async () => {
  const out = await svc.extract('/task งานสั้น');
  assert.equal(out[0].title, 'งานสั้น');
});

test('priority and due date can be combined and both are stripped', async () => {
  const out = await svc.extract('/task แก้บั๊ก checkout !high @2026-08-15');
  assert.equal(out[0].priority, 'high');
  assert.equal(out[0].dueDate, '2026-08-15');
  assert.ok(!out[0].title.includes('!high'));
  assert.ok(!out[0].title.includes('@2026'));
  assert.equal(out[0].title, 'แก้บั๊ก checkout');
});

test('!สูง (Thai) → priority high', async () => {
  const out = await svc.extract('/task รีบทำหน่อย !สูง');
  assert.equal(out[0].priority, 'high');
});

test('!ต่ำ (Thai) → priority low', async () => {
  const out = await svc.extract('/task เก็บงานเล็กน้อย !ต่ำ');
  assert.equal(out[0].priority, 'low');
});

test('due date in the middle of the text is parsed and removed', async () => {
  const out = await svc.extract('/task ส่งงาน @2026-09-01 ให้ลูกค้า');
  assert.equal(out[0].dueDate, '2026-09-01');
  assert.ok(!out[0].title.includes('@2026'));
});

test('exactly 60 graphemes is not truncated (no ellipsis at the boundary)', async () => {
  const exactly60 = 'ก'.repeat(60);
  const out = await svc.extract(`/task ${exactly60}`);
  assert.equal(out[0].title, exactly60);
  assert.ok(!out[0].title.endsWith('…'));
});

test('blank lines between tasks are ignored', async () => {
  const out = await svc.extract('/task งานหนึ่ง\n\n   \nงานสอง');
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'งานหนึ่ง');
  assert.equal(out[1].title, 'งานสอง');
});

test('description preserves the full line while title may be truncated', async () => {
  const long = 'ก'.repeat(80);
  const out = await svc.extract(`/task ${long}`);
  assert.equal(out[0].description, long);
  assert.ok(out[0].title.endsWith('…'));
});
