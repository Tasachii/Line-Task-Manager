import puppeteer from 'puppeteer-core';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

// Chrome path is env-driven so the script runs on Linux CI as well as macOS dev.
// On CI set CHROME_PATH to the installed binary (e.g. via browser-actions/setup-chrome).
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP = 'http://localhost:5173';
const SCREENSHOT = fileURLToPath(new URL('../dist/e2e-board.png', import.meta.url));
const results = [];
let failed = false;
const ok = (name, pass, detail = '') => {
  if (!pass) failed = true;
  results.push(`${pass ? 'PASS' : 'FAIL'} | ${name}${detail ? ' — ' + detail : ''}`);
};

function sendWebhook(msgId, text) {
  const body = JSON.stringify({
    events: [{
      type: 'message',
      message: { type: 'text', id: msgId, text },
      source: { type: 'group', groupId: 'G_test_group', userId: 'U_test_user' },
      replyToken: 'rt_ui', timestamp: Date.now(), mode: 'active',
      webhookEventId: 'we_' + msgId, deliveryContext: { isRedelivery: false },
    }],
  });
  const sig = crypto.createHmac('sha256', 'test_secret').update(body).digest('base64');
  return fetch('http://localhost:3000/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-line-signature': sig },
    body,
  });
}

// Posts a webhook with an explicit signature (used to assert the signature gate rejects forgeries).
function postWebhook(body, sig) {
  return fetch('http://localhost:3000/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-line-signature': sig },
    body,
  });
}

// Signature gate (A-1): a wrong signature must be rejected with 400 and a valid one accepted with 200.
const sigBody = JSON.stringify({ events: [] });
const badSig = crypto.createHmac('sha256', 'wrong_secret').update(sigBody).digest('base64');
const goodSig = crypto.createHmac('sha256', 'test_secret').update(sigBody).digest('base64');
const rejectedSignature = await postWebhook(sigBody, badSig);
const acceptedSignature = await postWebhook(sigBody, goodSig);
ok('webhook rejects a forged signature (400)', rejectedSignature.status === 400, String(rejectedSignature.status));
ok('webhook accepts a valid signature (200)', acceptedSignature.status === 200, String(acceptedSignature.status));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  // Flags required to launch Chrome in a sandboxed CI runner (GitHub Actions).
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
try {
  const pageA = await browser.newPage();
  const errorsA = [];
  pageA.on('pageerror', (e) => errorsA.push(e.message));
  await pageA.setViewport({ width: 1400, height: 900 });
  await pageA.goto(APP, { waitUntil: 'domcontentloaded' });

  // 1. Enter name — board appears
  await pageA.waitForSelector('.app__me-input');
  await pageA.type('.app__me-input', 'ผู้ทดสอบ');
  await pageA.waitForSelector('.col', { timeout: 5000 });
  const labels = await pageA.$$eval('.col__label', (els) => els.map((e) => e.textContent));
  ok('board has 4 columns', JSON.stringify(labels) === JSON.stringify(['Todo', 'In Process', 'Test', 'Done']), labels.join(' / '));

  // 2. Open second tab
  const pageB = await browser.newPage();
  await pageB.setViewport({ width: 1400, height: 900 });
  await pageB.goto(APP, { waitUntil: 'domcontentloaded' });
  await pageB.waitForSelector('.col', { timeout: 5000 });

  // 3. Fire webhook — card must appear on both tabs without a page refresh
  const TITLE = 'งานทดสอบ UI realtime ' + Date.now();
  const webhookResponse = await sendWebhook(
    'msg_ui_' + Date.now(),
    `/task ${TITLE} @2026-02-30`,
  );
  ok('invalid-date task webhook is accepted (200)', webhookResponse.status === 200, String(webhookResponse.status));
  const fixtureTasks = (await (await fetch('http://localhost:3000/tasks')).json())
    .filter((task) => task.title === TITLE);
  ok('invalid-date webhook stores exactly one task', fixtureTasks.length === 1, String(fixtureTasks.length));
  ok('invalid-date task is stored without a due date', fixtureTasks[0]?.due_date === null);
  const appeared = async (page) =>
    page.waitForFunction(
      (t) => [...document.querySelectorAll('.card__title')].some((el) => el.textContent === t),
      { timeout: 6000, polling: 100 }, TITLE,
    ).then(() => true).catch(() => false);
  const appearedA = await appeared(pageA);
  const appearedB = await appeared(pageB);
  ok('new card appears on tab A (realtime)', appearedA);
  ok('new card appears on tab B (realtime)', appearedB);
  if (!appearedA || !appearedB) {
    console.error(results.join('\n'));
    throw new Error('known fixture card did not appear');
  }

  // 4. Click "take task" on tab A — assignee name appears on tab B
  const clicked = await pageA.evaluate((t) => {
    const card = [...document.querySelectorAll('.card')].find(
      (c) => c.querySelector('.card__title')?.textContent === t,
    );
    const btn = card?.querySelector('.card__take');
    if (!btn) return false;
    btn.click();
    return true;
  }, TITLE);
  ok('take-task button is clickable', clicked);
  const assigneeShown = await pageB.waitForFunction(
    (t) => {
      const card = [...document.querySelectorAll('.card')].find(
        (c) => c.querySelector('.card__title')?.textContent === t,
      );
      return card?.querySelector('.card__assignee')?.textContent.includes('ผู้ทดสอบ');
    },
    { timeout: 6000, polling: 100 }, TITLE,
  ).then(() => true).catch(() => false);
  ok('assignee name synced to tab B (realtime)', assigneeShown);

  // 5. Drag card from Todo to In Process (simulating dnd-kit pointer drag).
  // Tab B was opened last, so foreground tab A before sending pointer events.
  await pageA.bringToFront();
  const cardHandle = await pageA.waitForFunction((t) => {
    return [...document.querySelectorAll('.col--todo .card')].find(
      (c) => c.querySelector('.card__title')?.textContent === t,
    );
  }, { timeout: 6000, polling: 100 }, TITLE);
  const cardElement = cardHandle.asElement();
  if (!cardElement) throw new Error('known fixture card is not an element');
  await cardElement.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  const cardBox = await cardElement.boundingBox();
  const dropTarget = await pageA.waitForSelector('.col--in_process .col__drop');
  const dropBox = await dropTarget.boundingBox();
  if (!cardBox || !dropBox) throw new Error('known fixture card or drop target has no layout box');
  const startX = cardBox.x + cardBox.width / 2;
  const startY = cardBox.y + 12;
  const viewport = pageA.viewport();
  if (!viewport) throw new Error('browser viewport is unavailable');
  const visibleDropTop = Math.max(0, dropBox.y);
  const visibleDropBottom = Math.min(viewport.height, dropBox.y + dropBox.height);
  if (visibleDropBottom <= visibleDropTop) throw new Error('drop target is outside the viewport');
  const dropY = (visibleDropTop + visibleDropBottom) / 2;
  await pageA.mouse.move(startX, startY);
  await pageA.mouse.down();
  await pageA.mouse.move(startX, startY + 40, { steps: 2 });
  await pageA.waitForSelector('.card--overlay', { timeout: 2000 });
  await pageA.mouse.move(dropBox.x + dropBox.width / 2, dropY);
  await pageA.mouse.up();
  const moved = await pageB.waitForFunction(
    (t) => [...document.querySelectorAll('.col--in_process .card__title')].some((el) => el.textContent === t),
    { timeout: 6000, polling: 100 }, TITLE,
  ).then(() => true).catch(() => false);
  ok('drag card Todo to In Process (visible on tab B)', moved);

  // 6. Collect JS errors and take screenshot
  ok('no JS errors on page', errorsA.length === 0, errorsA.join('; '));
  await pageA.screenshot({ path: SCREENSHOT });
} finally {
  await browser.close();
}
console.log(results.join('\n'));
process.exit(failed ? 1 : 0);
