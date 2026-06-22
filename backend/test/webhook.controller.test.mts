// HTTP-level signature-gate tests for POST /webhook (A-1, P0-1).
//
// We drive the REAL WebhookController + REAL LineClientService over HTTP with a raw-body
// middleware that mirrors NestJS `rawBody: true`. WebhookService is a spy so no DB/LINE is hit.
// (The controller is instantiated directly rather than through Nest's DI container because the
// tsx/esbuild runner does not emit `design:paramtypes`, which Nest's reflection-based DI needs.
// The signature-verification code path exercised here is identical.)
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { BadRequestException } from '@nestjs/common';
import { fakeConfig } from './helpers/config.mts';

process.env.LINE_CHANNEL_SECRET = 'test_secret';

const { LineClientService } = await import('../src/line/line-client.service');
const { WebhookController } = await import('../src/webhook/webhook.controller');

const SECRET = 'test_secret';
const sign = (body: string, secret = SECRET) =>
  crypto.createHmac('sha256', secret).update(body).digest('base64');

let server: http.Server;
let baseUrl: string;
const handled: unknown[][] = [];
const spy = { handleEvents: (...args: unknown[]) => { handled.push(args); return Promise.resolve(); } };
const controller = new WebhookController(new LineClientService(fakeConfig()), spy as never);

before(async () => {
  const app = express();
  // Mirror NestFactory.create(AppModule, { rawBody: true }): keep req.rawBody alongside parsed body.
  app.use(
    express.json({
      verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.post('/webhook', async (req: express.Request & { rawBody?: Buffer }, res) => {
    try {
      const result = await controller.receive(req as never, req.header('x-line-signature') as never);
      res.status(200).json(result);
    } catch (e) {
      if (e instanceof BadRequestException) {
        res.status(400).json(e.getResponse());
      } else {
        res.status(500).json({ error: (e as Error).message });
      }
    }
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  handled.length = 0;
});

async function post(body: string, sig?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (sig !== undefined) headers['x-line-signature'] = sig;
  const res = await fetch(`${baseUrl}/webhook`, { method: 'POST', headers, body });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

test('valid signature → 200 { ok: true } and handleEvents called once with events', async () => {
  const body = JSON.stringify({ events: [{ type: 'message', message: { type: 'text', id: 'm1', text: 'hi' } }] });
  const res = await post(body, sign(body));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(handled.length, 1);
  assert.equal(Array.isArray(handled[0][0]), true);
  assert.equal((handled[0][0] as unknown[]).length, 1);
});

test('bad signature → 400 invalid signature, handleEvents not called', async () => {
  const body = JSON.stringify({ events: [] });
  const res = await post(body, sign(body, 'wrong_secret'));
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(res.body), /invalid signature/);
  assert.equal(handled.length, 0);
});

test('missing x-line-signature header → 400', async () => {
  const body = JSON.stringify({ events: [] });
  const res = await post(body); // no signature
  assert.equal(res.status, 400);
  assert.equal(handled.length, 0);
});

test('empty events array with valid sig → 200, handleEvents called with []', async () => {
  const body = JSON.stringify({ events: [] });
  const res = await post(body, sign(body));
  assert.equal(res.status, 200);
  assert.equal(handled.length, 1);
  assert.deepEqual(handled[0][0], []);
});

test('body field missing entirely (no events) with valid sig → 200, handleEvents called with []', async () => {
  const body = JSON.stringify({});
  const res = await post(body, sign(body));
  assert.equal(res.status, 200);
  assert.deepEqual(handled[0][0], []);
});

test('body tampered after signing → 400', async () => {
  const original = JSON.stringify({ events: [{ id: 1 }] });
  const sig = sign(original);
  const tampered = JSON.stringify({ events: [{ id: 999 }] });
  const res = await post(tampered, sig);
  assert.equal(res.status, 400);
  assert.equal(handled.length, 0);
});
