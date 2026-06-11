# Project Guide

Everything you need to know before working on LINE Task Manager. The [README](README.md) covers setup and usage; this guide covers how the system is built and the conventions to follow when changing it.

## 1. What This Project Is

LINE Task Manager turns messages in a LINE group chat into cards on a shared Kanban board. The team works the board (`Todo → In Process → Test → Done`), and the bot reports progress back into the group. The primary users are a Thai software team and their clients, which is why all end-user copy (bot replies, board UI labels) is in Thai. Code, comments, and documentation are in English.

## 2. Architecture

```
LINE Group ──> LINE Platform ──(HTTPS webhook)──> Backend (NestJS)
                                                     │
                                  ┌──────────────────┼──────────────────┐
                                  │                  │                  │
                            PostgreSQL        Claude API          Socket.IO
                          (tasks, users,    (optional task       (realtime board
                           line_messages)    extraction)           updates)
                                                     ▲
                              Frontend (React Kanban board, REST + WebSocket)
```

In production every component runs in Docker, and nginx (in the frontend container) is the single public entry point: it serves the board SPA and proxies `/tasks`, `/health`, `/webhook`, and `/socket.io/` to the backend. One domain or tunnel covers both the board and the LINE webhook.

### Message-to-card pipeline

1. LINE POSTs events to `/webhook`. The controller verifies the `x-line-signature` header against `LINE_CHANNEL_SECRET` using the raw request body (`rawBody: true` in `main.ts`); invalid signatures get HTTP 400.
2. `WebhookService` processes each event independently — one failing event never fails the batch. Only text messages from group chats are considered. A `join` event triggers a greeting message that explains usage.
3. The message ID is checked against `line_messages` before insert; duplicates (LINE retries webhooks) are skipped silently.
4. `TaskExtractionService` decides what the message means:
   - Starts with the keyword (`TASK_KEYWORD`, default `/task`, case-insensitive): each non-empty line becomes one task. Inline tokens are parsed and stripped: `@YYYY-MM-DD` sets the due date; `!high` / `!สูง` / `!ด่วน` sets high priority; `!low` / `!ต่ำ` sets low priority. Titles are truncated at 60 graphemes using `Intl.Segmenter` so Thai combining marks are never split.
   - No keyword and `ANTHROPIC_API_KEY` is set: the message goes to Claude with a JSON-schema-constrained output (`EXTRACT_SCHEMA`). The model classifies task vs. conversation and may return multiple tasks. The client uses a 15-second timeout and one retry; any failure is fail-open — the message is skipped and the webhook never blocks or errors.
   - No keyword and no API key: the message is ignored.
5. Created tasks are persisted with `position` appended to the end of Todo, broadcast over WebSocket (`task:created`), and confirmed in the group via the reply token.

### Board operations

- The frontend loads `GET /tasks` once, then stays in sync via Socket.IO events. `task:created` and `task:updated` carry the full task; `tasks:refresh` means "re-fetch everything" and is emitted after drag-and-drop reordering, because multiple cards' positions change at once.
- Drag and drop calls `PATCH /tasks/:id/move` with `{status, index}`. The repository renumbers positions in the affected column. A status-only change (`PATCH /tasks/:id/status`) appends to the end of the target column.
- All position writes (`createTask`, `move`, `updateStatus`) run inside a transaction (`DatabaseService.withTransaction`) and take a per-column `pg_advisory_xact_lock`. This serializes concurrent writers on the same Kanban column so two simultaneous drags or intakes can never compute the same `position` or interleave a renumber — different columns never block each other.
- Assignment (`POST /tasks/:id/assign`) upserts the user first when a `displayName` is provided; an unknown user without a display name returns 400 rather than surfacing a foreign-key error as 500.
- LINE push notifications are fire-and-forget (`void` promises): a LINE API failure never fails the board API call. Cross-column moves notify the group only if the target status is in `NOTIFY_STATUSES`; assignment notices are controlled by `NOTIFY_ASSIGN`.

## 3. Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Backend | NestJS 10 (Express), TypeScript | Modules: webhook, tasks, line, realtime, database, health, auth |
| LINE | `@line/bot-sdk` v11 | Signature validation, reply, push, group member profile |
| AI | `@anthropic-ai/sdk` | Optional; JSON-schema structured output; default model `claude-haiku-4-5` (override with `AI_EXTRACT_MODEL`) |
| Database | PostgreSQL 16, raw SQL via `pg` | No ORM; queries live in repositories |
| Realtime | Socket.IO (`@nestjs/websockets`) | Single gateway, broadcast to all clients |
| Frontend | React 18, Vite 5, TypeScript | SPA, no router |
| Drag and drop | `@dnd-kit/core` + `@dnd-kit/sortable` | Cross-column and in-column sorting |
| E2E tests | `puppeteer-core` driving system Chrome | Plain script, no test framework |
| Unit tests | Node.js built-in test runner (`node --test`) | No Jest |
| Deployment | Docker Compose, nginx | Multi-stage builds, health checks, auto-migration |

## 4. Repository Layout

```
backend/
  src/
    main.ts                      # bootstrap: rawBody, CORS, global ValidationPipe
    app.module.ts
    webhook/                     # LINE event intake (signature check in controller)
    tasks/
      tasks.controller.ts        # REST endpoints (guarded by BoardKeyGuard)
      tasks.service.ts           # orchestration + LINE notifications
      tasks.repository.ts        # all SQL for tasks/users/messages
      task-extraction.service.ts # keyword parser + optional Claude extraction
      dto/task.types.ts          # types, DTOs with class-validator rules
    line/line-client.service.ts  # LINE SDK wrapper (reply, push, member name)
    realtime/events.gateway.ts   # Socket.IO gateway + connection auth
    auth/board-key.guard.ts      # shared-password guard (x-board-key header)
    database/                    # pg pool, migration runner
    health/health.controller.ts  # /health with DB probe
  test/extraction.test.mjs       # unit tests for extraction (runs against dist/)
frontend/
  src/
    App.tsx                      # data loading, socket wiring, connection banner
    components/Board.tsx         # dnd-kit DndContext, optimistic updates
    components/Column.tsx, TaskCard.tsx
    api.ts                       # REST client, x-board-key header
    socket.ts                    # Socket.IO client, auth key
  scripts/e2e.mjs                # Puppeteer e2e script
  nginx.conf                     # production reverse proxy
migrations/                      # numbered SQL files, applied in order
docs/
  01-architecture/00-system-design.md
  flows/                         # interactive HTML + Mermaid flow diagrams
docker-compose.yml               # db (default) + backend/frontend ("full" profile)
.github/workflows/ci.yml         # backend and frontend jobs
```

## 5. Data Model

Tables are created by plain SQL files in `migrations/`, applied in filename order by `npm run migrate` (also run automatically on container startup). Migrations are idempotent (`IF NOT EXISTS`); there is no down-migration or version table.

- `line_messages` — raw inbound messages; `message_id` (PK) doubles as the webhook dedupe key.
- `users` — known LINE users; `id` equals `line_user_id` for now; `role` is `member` or `admin` (role is not yet enforced anywhere).
- `tasks` — the cards. Key fields: `status` (`todo | in_process | test | done`), `position` (integer order within a column), `priority` (`low | medium | high`, nullable), `due_date` (nullable), `assignee_id`/`created_by` (FK to users), `source_message_id` (FK to line_messages).

Adding a column: create a new numbered migration file; never edit an applied one.

## 6. Security Model

- **Webhook**: protected by LINE's HMAC signature; never put it behind the board password.
- **Board REST API**: `BoardKeyGuard` compares the `x-board-key` header to `BOARD_PASSWORD` using a constant-time comparison (`crypto.timingSafeEqual`). If `BOARD_PASSWORD` is unset, auth is disabled entirely — acceptable for local development only.
- **WebSocket**: the gateway disconnects clients whose `handshake.auth.key` does not match the password (same constant-time comparison).
- **Rate limiting**: a global `ThrottlerGuard` caps board-API requests per IP (`THROTTLE_LIMIT`/`THROTTLE_TTL_MS`, default 120/min). The webhook and `/health` opt out with `@SkipThrottle()` — the webhook is gated by its HMAC signature and LINE delivers in bursts; `/health` is polled by probes.
- **CORS**: `CORS_ORIGIN` restricts both REST and WebSocket origins; unset means `*`.
- **Validation**: a global `ValidationPipe` with `whitelist: true` strips unknown body fields; DTOs in `dto/task.types.ts` define the allowed shapes.
- `/health` is intentionally unauthenticated for Docker health checks and load balancers.

## 7. Configuration

All backend configuration is environment variables read directly via `process.env` (loaded from `backend/.env` by `dotenv`). The full table is in the [README](README.md#environment-variables-backendenv). Notes for developers:

- `TaskExtractionService` and `TasksService` read their env vars at construction time; changing notification or AI settings requires a backend restart.
- In Docker Compose, `DATABASE_URL` is overridden to point at the `db` service, so the value in `.env` (localhost) applies only to local development.
- The frontend has no build-time configuration. REST calls use relative paths: the Vite dev server proxies `/tasks` to `http://localhost:3000` (see `vite.config.ts`), and nginx proxies in production. The WebSocket connects to `http://localhost:3000` in dev and same-origin in production (`socket.ts`). The board password is entered in the UI, stored in `localStorage` under `ltm_key`, and sent as the `x-board-key` header and the socket `auth.key`.

## 8. Development Workflow

```bash
docker compose up -d                  # PostgreSQL only
cd backend && npm install && cp .env.example .env && npm run migrate
npm run start:dev                     # NestJS watch mode on :3000
cd ../frontend && npm install && npm run dev   # Vite on :5173
```

- To exercise the webhook without LINE, POST to `/webhook` with a computed signature, or run the backend with `LINE_CHANNEL_SECRET=test_secret` and use the e2e script's helper as a reference (`frontend/scripts/e2e.mjs` signs payloads with HMAC-SHA256).
- The full-stack deployment (`docker compose --profile full`) maps backend `:3000` and nginx `:8080`. In development, Vite proxies REST calls to the backend, so no CORS configuration is needed locally.

### Testing

| Suite | Command | Requirements |
|---|---|---|
| Backend unit | `cd backend && npm run build && npm test` | None (tests run against `dist/`) — build first |
| Backend integration | `cd backend && npm run test:integration` | Build first; Postgres up and migrated (`docker compose up -d && npm run migrate`). Covers `position` ordering and concurrency of `createTask`/`move` against a real database |
| Frontend types/build | `cd frontend && npm run build` | None |
| End-to-end | `cd frontend && npm run test:e2e` | Backend on `:3000` with `LINE_CHANNEL_SECRET=test_secret`, Postgres up, Vite dev server on `:5173`, Chrome installed |

The e2e script injects a task through the webhook (with a real signature), then drives Chrome through board rendering, realtime updates, drag and drop, and assignment.

CI (`.github/workflows/ci.yml`) runs backend build + unit tests + integration tests (against a Postgres service container) and frontend type-check + build on every push to `main` and every pull request. E2E is not run in CI.

## 9. Conventions

- **Language**: code, comments, commit messages, and docs in English. End-user copy — LINE bot messages, push notifications, the AI extraction prompt, and board UI labels — is intentionally Thai; do not translate it.
- **No ORM**: SQL lives in repository classes (`tasks.repository.ts`). Keep queries there, not in services.
- **Error philosophy**: the webhook must always return 200 quickly once the signature is valid — per-event errors are logged and swallowed; AI extraction is fail-open; LINE pushes are fire-and-forget. Board API errors, by contrast, should be explicit (400/404) rather than leaking as 500s.
- **Realtime**: any mutation that changes a single task emits `task:created`/`task:updated`; anything that renumbers positions emits `tasks:refresh`.
- **Thai text handling**: use grapheme-aware operations (`Intl.Segmenter`) when slicing user text; never `substring` Thai strings.
- **Commits**: imperative, descriptive subject lines; no AI attribution trailers.

## 10. Known Limitations and Roadmap

Current limitations:

- A single shared password authenticates everyone; there is no per-user identity on the board (assignment identity is supplied by the client).
- `users.role` exists but is unused.
- No pagination; the board loads all tasks in all groups (multi-group data is stored but the board does not filter by group).
- Cards cannot be edited or deleted from the board.
- Push notifications consume LINE OA quota (~300/month on the free plan) — tune `NOTIFY_STATUSES` accordingly.

Planned next:

- LINE Login so board identity matches LINE identity
- Weekly statistics and summaries posted to the group
- Card editing and deletion from the board

## 11. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Webhook Verify fails in LINE console | Tunnel/domain not reaching nginx (`:8080`) or backend; wrong `LINE_CHANNEL_SECRET` |
| Webhook returns 400 | Signature mismatch — secret is wrong, or the body was re-serialized by a proxy before reaching the backend |
| Bot silent in group | "Allow bot to join group chats" disabled, webhooks off in OA Manager, or message had no keyword and no `ANTHROPIC_API_KEY` set |
| Board empty but tasks exist | Wrong `x-board-key` (REST returns 401) or `CORS_ORIGIN` blocking the frontend origin |
| Board not updating live | WebSocket rejected: missing/incorrect `auth.key`, or proxy not forwarding `/socket.io/` upgrades |
| `npm test` fails immediately | Run `npm run build` first — unit tests import from `dist/` |
| Duplicate cards | Should not happen: check `line_messages` dedupe; LINE retries are expected and absorbed |
