import puppeteer from 'puppeteer-core';
import crypto from 'crypto';

// Chrome path is env-driven so the script runs on Linux CI as well as macOS dev.
// On CI set CHROME_PATH to the installed binary (e.g. via browser-actions/setup-chrome).
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP = 'http://localhost:5173';
const results = [];
const ok = (name, pass, detail = '') => {
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
ok('webhook rejects a forged signature (400)', (await postWebhook(sigBody, badSig)).status === 400);
ok('webhook accepts a valid signature (200)', (await postWebhook(sigBody, goodSig)).status === 200);

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
  await pageA.goto(APP, { waitUntil: 'networkidle0' });

  // 1. Enter name — board appears
  await pageA.waitForSelector('.app__me-input');
  await pageA.type('.app__me-input', 'ผู้ทดสอบ');
  await pageA.waitForSelector('.col', { timeout: 5000 });
  const labels = await pageA.$$eval('.col__label', (els) => els.map((e) => e.textContent));
  ok('board has 4 columns', JSON.stringify(labels) === JSON.stringify(['Todo', 'In Process', 'Test', 'Done']), labels.join(' / '));

  // 2. Open second tab
  const pageB = await browser.newPage();
  await pageB.setViewport({ width: 1400, height: 900 });
  await pageB.goto(APP, { waitUntil: 'networkidle0' });
  await pageB.waitForSelector('.col', { timeout: 5000 });

  // 3. Fire webhook — card must appear on both tabs without a page refresh
  const TITLE = 'งานทดสอบ UI realtime ' + Date.now();
  await sendWebhook('msg_ui_' + Date.now(), '/task ' + TITLE);
  const appeared = async (page) =>
    page.waitForFunction(
      (t) => [...document.querySelectorAll('.card__title')].some((el) => el.textContent === t),
      { timeout: 6000, polling: 100 }, TITLE,
    ).then(() => true).catch(() => false);
  ok('new card appears on tab A (realtime)', await appeared(pageA));
  ok('new card appears on tab B (realtime)', await appeared(pageB));

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

  // 5. Drag card from Todo to In Process (simulating dnd-kit pointer drag)
  const cardHandle = await pageA.evaluateHandle((t) => {
    return [...document.querySelectorAll('.col--todo .card')].find(
      (c) => c.querySelector('.card__title')?.textContent === t,
    );
  }, TITLE);
  const cardBox = await cardHandle.asElement().boundingBox();
  const dropBox = await (await pageA.$('.col--in_process .col__drop')).boundingBox();
  await pageA.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + 12);
  await pageA.mouse.down();
  // Move in increments to exceed the 5px activation distance
  for (let i = 1; i <= 10; i++) {
    await pageA.mouse.move(
      cardBox.x + cardBox.width / 2 + ((dropBox.x + dropBox.width / 2 - cardBox.x - cardBox.width / 2) * i) / 10,
      cardBox.y + 12 + ((dropBox.y + 60 - cardBox.y - 12) * i) / 10,
      { steps: 2 },
    );
  }
  await pageA.mouse.up();
  const moved = await pageB.waitForFunction(
    (t) => [...document.querySelectorAll('.col--in_process .card__title')].some((el) => el.textContent === t),
    { timeout: 6000, polling: 100 }, TITLE,
  ).then(() => true).catch(() => false);
  ok('drag card Todo to In Process (visible on tab B)', moved);

  // 6. Collect JS errors and take screenshot
  ok('no JS errors on page', errorsA.length === 0, errorsA.join('; '));
  await pageA.screenshot({ path: '/tmp/ltm_board.png' });
} finally {
  await browser.close();
}
console.log(results.join('\n'));
