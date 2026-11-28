# LINE Task Manager — Kanban board for LINE group chats

![CI](https://github.com/Tasachii/Line-Task-Manager/actions/workflows/ci.yml/badge.svg)

LINE Task Manager is a webhook-driven Kanban board that turns LINE group messages into tracked tasks. A bot listens to a LINE group, parses `/task` keyword messages (or, with an Anthropic API key, plain natural-language messages) into cards, and places them on a four-column board — `Todo → In Process → Test → Done`. Status changes and assignments push a notification back to the group. The board is a React SPA served behind nginx; the backend is NestJS with PostgreSQL. Multiple LINE groups can share one deployment with full per-group data isolation via `BOARD_GROUPS`.

**Issues** — [github.com/Tasachii/Line-Task-Manager/issues](https://github.com/Tasachii/Line-Task-Manager/issues)

---

## Screenshots

| Board | Lock screen |
| --- | --- |
| ![Kanban board — four columns, priority badges, drag-and-drop](docs/review/board-overview.png) | ![Password gate shown when BOARD_PASSWORD is set](docs/review/board-locked.png) |

---

## What it is

A single deployment handles one or more LINE groups. Each message that contains `/task` (one line = one card) is parsed for priority tokens (`!high`, `!low`, and Thai aliases) and due dates (`@YYYY-MM-DD`). With `ANTHROPIC_API_KEY` set, the Claude API also screens keyword-free messages and promotes those that describe real work. The board reflects every change in real time over WebSocket; group members get a LINE push when a card moves or is assigned.

- **Backend stack** — NestJS 11 · PostgreSQL 16 · @line/bot-sdk 11 · @anthropic-ai/sdk · Socket.IO 4 · TypeScript 5
- **Frontend stack** — React 18 · Vite 5 · @dnd-kit · socket.io-client · TypeScript 5

---

## Repository layout

| Path | Contents |
| --- | --- |
| `backend/` | NestJS app — webhook, REST API, WebSocket gateway, AI extraction, PostgreSQL access |
| `frontend/` | React + Vite Kanban SPA with `nginx.conf` for production |
| `migrations/` | SQL migrations (`line_messages`, `users`, `tasks`) |
| `docs/` | Architecture doc, interactive flow diagrams, roadmap |
| `docker-compose.dev.yml` | Local PostgreSQL published on `:5432` for development |
| `docker-compose.yml` | Production stack via `--profile full`; only nginx is published |
| `.github/workflows/ci.yml` | CI: backend · frontend (required gates) · e2e (best-effort) |

---

## Installation

**Requirements** — [Node 22](https://nodejs.org) · [Docker](https://docs.docker.com/get-docker/) (for PostgreSQL / full-stack deployment)

**Mac / Linux**
```bash
git clone https://github.com/Tasachii/Line-Task-Manager.git
cd Line-Task-Manager
cp backend/.env.example backend/.env    # fill in LINE credentials (see Configuration table)
```

**Windows**
```bat
git clone https://github.com/Tasachii/Line-Task-Manager.git
cd Line-Task-Manager
copy backend\.env.example backend\.env  :: fill in LINE credentials (see Configuration table)
```

---

## Running

### Development

```bash
docker compose -f docker-compose.dev.yml up -d   # start PostgreSQL on :5432

# Backend (separate terminal)
cd backend
npm install
npm run migrate                         # create tables in the local database
npm run start:dev                       # NestJS watch mode on :3000

# Frontend (separate terminal)
cd frontend
npm install
npm run dev                             # Vite dev server on :5173
```

### Production (Docker)

```bash
export POSTGRES_PASSWORD='choose-a-strong-database-password'
docker compose --profile full up -d --build   # PostgreSQL + backend + nginx on :8080
```

The full profile requires `POSTGRES_PASSWORD` and publishes only nginx on `:8080`; PostgreSQL and
the backend remain on the internal Compose network. The backend waits for the database, runs
migrations automatically on startup, and exposes its health check through nginx. Point your domain
or ngrok tunnel at `:8080` — both the Kanban board and the LINE webhook use that single endpoint.

### Upgrading an existing production data volume

PostgreSQL applies `POSTGRES_PASSWORD` only when it creates a new data directory. For an existing
`ltm_pgdata` volume, start only the internal production database, then update the existing `line`
user's password through its local socket. Enter the same value at the prompt that you exported:

```bash
printf 'New database password: '
IFS= read -r -s POSTGRES_PASSWORD
printf '\n'
export POSTGRES_PASSWORD
docker compose --profile full up -d db
docker compose --profile full exec db psql -U line -d line_task_manager -c '\password line'
docker compose --profile full up -d --build
```

The hidden prompt keeps the password out of shell history. Run these commands from the same
checkout and keep the same Compose project name so it reuses the existing named volume.

### Backup and restore

Create a consistent custom-format dump while the app is running:

```bash
./scripts/backup-database.sh /secure/path/line-task-manager.dump
```

Copy the dump to another machine immediately; a file kept only beside the production volume is not
a usable disaster-recovery backup. To restore, start only a fresh production database, restore the
dump, then start the application:

```bash
docker compose --profile full up -d db
./scripts/restore-database.sh /secure/path/line-task-manager.dump
docker compose --profile full up -d --build
```

The restore command refuses a database that already contains public tables. Use a new volume or an
otherwise empty `line_task_manager` database.

---

## Connecting a LINE Official Account

1. Create a LINE Official Account, or open an existing one in [LINE Official Account Manager](https://manager.line.biz).
2. In Official Account Manager, open **Settings → Messaging API**, enable the Messaging API, and select the provider that will own the channel. This creates the Messaging API channel; channels can no longer be created directly in the Developers Console. See LINE's [official setup guide](https://developers.line.biz/en/docs/messaging-api/getting-started/).
3. Open that channel in the [LINE Developers Console](https://developers.line.biz/console/). On **Basic settings**, copy **Channel secret** into `backend/.env` as `LINE_CHANNEL_SECRET`.
4. On **Messaging API**, issue a long-lived channel access token and set it as `LINE_CHANNEL_ACCESS_TOKEN`.
5. Still on **Messaging API**, enable **Allow bot to join group chats**.
6. Expose `:8080` publicly with `ngrok http 8080` for development or a real production domain.
7. Set **Webhook URL** to `https://<your-domain>/webhook`, click **Verify** (it must report Success), then enable both **Use webhook** and **Webhook redelivery**. See LINE's [webhook redelivery instructions](https://developers.line.biz/en/docs/messaging-api/receiving-messages/#enable-webhook-redelivery).
8. In Official Account Manager, open **Settings → Response settings** and turn **Chat** and **Auto-response** off.
9. Invite the bot to a group. Send:

```
/task Fix the login button on the landing page !high @2026-07-01
Change the button color to green
```

Two cards appear in Todo (the first with high priority and a due date); the bot confirms intake in the group.

If a `/task` message contains an impossible calendar date such as `@2026-02-30`, the card is still
created without a due date and the confirmation reply explains that the invalid date was omitted.

> Without `ANTHROPIC_API_KEY`, only `/task` messages create cards — plain conversation is ignored.
> With the key set, the AI also classifies keyword-free messages that describe work.
> For deduplication, ignored conversation retains only its LINE message ID and metadata; its text is not stored.

---

## Configuration

All variables are validated at startup by a `class-validator` schema in `backend/src/config/env.validation.ts`. A malformed value fails fast and the backend refuses to boot. In production, `assertProdConfig` additionally requires `BOARD_PASSWORD` **or** `BOARD_GROUPS`, an explicit `CORS_ORIGIN`, and a non-empty `LINE_CHANNEL_SECRET`.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `LINE_CHANNEL_SECRET` | Yes | — | From LINE Developers Console; used to verify HMAC-SHA256 webhook signatures |
| `LINE_CHANNEL_ACCESS_TOKEN` | Yes | — | From LINE Developers Console; used to send push/reply messages |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `PORT` | No | `3000` | HTTP port the backend listens on |
| `TASK_KEYWORD` | No | `/task` | Prefix that marks a message as a task intake |
| `BOARD_PASSWORD` | Recommended | — | Shared board key for single-group deploys; unset disables auth (dev only) |
| `BOARD_GROUPS` | Multi-group | — | JSON map `{"<group_id>":"<key>"}` — per-group isolation; takes precedence over `BOARD_PASSWORD` |
| `CORS_ORIGIN` | Recommended | `*` | Allowed origin for the board API/WebSocket |
| `NOTIFY_STATUSES` | No | all statuses | Comma-separated statuses that trigger a LINE push (e.g. `done` to conserve quota) |
| `NOTIFY_ASSIGN` | No | `true` | Push to the group when a task is assigned |
| `NOTIFICATION_RETRY_LIMIT` | No | `5` | Automatic LINE push attempt limit before operator intervention |
| `NOTIFICATION_RETRY_INTERVAL_MS` | No | `60000` | Delay between LINE push attempts; must be at least 1000 ms |
| `ANTHROPIC_API_KEY` | No | — | Enables AI classification of keyword-free messages via the Claude API |
| `AI_EXTRACT_MODEL` | No | `claude-haiku-4-5` | Claude model for extraction; use `claude-opus-4-8` for higher accuracy |
| `THROTTLE_LIMIT` | No | `120` | Max board-API requests per IP per window |
| `THROTTLE_TTL_MS` | No | `60000` | Rate-limit window in milliseconds (webhook and `/health` are exempt) |
| `WEBHOOK_CONCURRENCY` | No | `3` | Max LINE events processed concurrently per delivery; bounds AI calls and DB transactions under burst |

### Per-group isolation

`BOARD_GROUPS` maps each LINE group ID to its own board key. A holder of key A sees only group A's tasks — `GET /tasks` is scoped by `WHERE group_id = $1` and the WebSocket gateway joins sockets to a per-group room. Single-group deploys leave `BOARD_GROUPS` unset and use `BOARD_PASSWORD`.

```bash
BOARD_GROUPS={"Cabc123...":"keyA","Cdef456...":"keyB"}
```

---

## API

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/webhook` | LINE HMAC signature | Receives events; returns 200 after durable intake and 503 for retryable processing failures |
| `GET` | `/health` | None | Database health plus `notifications.undelivered`, `pending`, `failed` counts and `oldestOverduePendingAgeSeconds` |
| `GET` | `/tasks` | `x-board-key` | List tasks ordered by column position; scoped to the key's group when `BOARD_GROUPS` is set |
| `PATCH` | `/tasks/:id/status` | `x-board-key` | Change status — card is appended to the target column |
| `PATCH` | `/tasks/:id/move` | `x-board-key` | Move a card to `{status, index}`; used by drag-and-drop |
| `POST` | `/tasks/:id/assign` | `x-board-key` | Assign a task: `{userId, displayName}` |
| `PATCH` | `/tasks/:id` | `x-board-key` | Edit a card: `{title?, description?, assigneeId?, assigneeName?}` |
| `DELETE` | `/tasks/:id` | `x-board-key` | Soft-delete a card (kept in the database, excluded from the board) |

WebSocket: clients send `auth.key` on connect when a password is set; the server emits `task:created`, `task:updated`, `task:deleted`, `tasks:refresh`.

Status-change and assignment pushes use a PostgreSQL outbox. The card mutation and notification record commit together, then delivery runs in the background with the same LINE retry key on every attempt. LINE downtime therefore does not roll back a board change. Check `/health` for undelivered notifications; rows that reach the retry limit remain counted as `failed` for operator follow-up. The health response also includes `notifications.oldestOverduePendingAgeSeconds`, the age of the oldest due pending notification, measured from its `next_attempt_at` to the database clock at query start and rounded down to whole seconds. Future retries and failed notifications do not contribute to this age. It is `null` when nothing is due and `0` when the oldest retry became due less than one second ago (including exactly due). The age and existing counts reflect one database snapshot.

### Inspect and redrive failed notifications

The backend includes a database-only CLI for deployment operators. Its scope is **every LINE group in the database**. Use a named PostgreSQL login for each operator, supplied through `OUTBOX_OPERATOR_DATABASE_URL`. A DBA can grant read-only inspection and redrive separately. Board keys have no access to this command.

```sql
-- Replace operator_login with an existing individual login.
GRANT USAGE ON SCHEMA public TO operator_login;
GRANT SELECT ON public.failed_notifications TO operator_login;
GRANT EXECUTE ON FUNCTION public.redrive_notification(uuid) TO operator_login;
```

From `backend/`, run `npm run build` once, or use the compiled backend image. Supply the operator URL through your credential manager.

```sh
npm run --silent outbox -- list                    # up to 100 terminal failures as JSON
npm run --silent outbox -- list <last-operator-id> # next page in UUID order
npm run --silent outbox -- redrive <operator-id>   # queue one additional attempt
```

The list contains an independent operator ID, attempt count, first claim time, a safe failure category, and the current redrive decision. After resolving the cause of a rate limit, or investigating an ambiguous or interrupted request, select one row marked `eligible`. Redrive rechecks eligibility under a row lock. Exit status 0 with `{"queued":true}` confirms the queue change. Status 1 means the row is missing or ineligible. Status 2 means a usage, permission, or database error. Only the background worker contacts LINE.

Each row can receive one extra attempt over its lifetime. The database records the authenticated login, time, operator ID and prior attempt count in `public.notification_redrive_audit` in the same transaction. The audit survives successful delivery. A definitive rejection arriving after an inferred interruption can cancel an approved redrive before its extra claim. The original authorization remains recorded with a cancellation timestamp. Once the extra claim is made, an older failure cannot overwrite it. Use individual logins even when credentials are brokered, since a shared database login yields a shared audit identity.

The worker preserves the original recipient, message, and retry key. A timeout or 5xx may follow acceptance, so every attempt uses the first durable claim as the earliest possible send. The worker stops at 23 hours, reserving one hour of LINE’s 24-hour deduplication window for timing uncertainty. A successful response or a 409 with an accepted request ID settles the row. Acceptance does not confirm receipt by a user. [LINE retry semantics](https://developers.line.biz/en/docs/messaging-api/retrying-api-request/)

Apply migration 008 and replace all older workers before enabling operator grants. Previously failed rows without structured failure history, invalid keys, uncertain timestamps, expired windows and permanent rejections stay available for inspection. Redrive provides no key rotation or budget reset. A crash after the extra claim can consume the allowance even if LINE never received the request.

---

## Testing

```bash
# Unit tests across signature verification, webhook controller/service,
# notification retries, AI extraction, board guard, realtime gateway, and DTO validation.
cd backend && npm test

# Unit tests with coverage (c8; thresholds: lines 80, functions 80, branches 70).
cd backend && npm run test:cov

# Integration tests against real PostgreSQL. Set DATABASE_URL to a dedicated test database.
# Covers ordering, tenant scoping, outbox redrive races, eligibility and audit.
# The operator privilege test switches session identities and requires a test superuser.
docker compose -f docker-compose.dev.yml up -d
cd backend && npm run migrate && npm run test:integration

# End-to-end tests — Puppeteer/Chrome: real board rendering, realtime updates,
# drag-and-drop, invalid-date intake, and the signature gate. CI replaces only
# the external LINE HTTPS calls with an in-process stand-in.
# Requires backend on :3000 (LINE_CHANNEL_SECRET=test_secret) and Vite on :5173.
cd frontend && npm run test:e2e
```

CI runs three jobs on every push and pull request. **backend** (build + unit tests + Postgres integration) and **frontend** (type-check + build) are required gates. **e2e** runs after both pass but is `continue-on-error: true` — browser/Chrome flakiness in the sandboxed runner does not fail the workflow. All jobs use Node 22.

---

## Design decisions

| Topic | Decision |
| --- | --- |
| Webhook signature | Raw-body HMAC-SHA256 (`X-Line-Signature`) verified before any parsing — tampered payloads are rejected with 400 before touching the database |
| Card ordering | A `position` column persists in-column order across moves, inserts, and page refreshes |
| Ordering integrity | Position writes run in a transaction serialized on a per-column PostgreSQL advisory lock — concurrent edits cannot corrupt order |
| Per-group key model | `BOARD_GROUPS` maps each LINE `group_id` to its own board key; `GET /tasks` and the WebSocket room are both scoped to that group, so key A never exposes group B's data |
| Duplicate prevention | `message_id` is claimed atomically to absorb LINE webhook retries — the same message never creates cards twice; ignored chat bodies are not retained |
| AI failure | Extraction errors and timeouts return 503 so LINE retries the webhook; message-ID deduplication prevents successfully handled events from creating duplicate cards |
| Rate limiting | Per-IP throttle on the board API; the LINE webhook and `/health` are exempt |
| Prod startup guard | `assertProdConfig` refuses to boot in production without board auth, explicit `CORS_ORIGIN`, and a non-empty `LINE_CHANNEL_SECRET` |

---

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md) for the full prioritized backlog with code pointers and acceptance criteria.

- [x] Signed webhook (HMAC raw-body)
- [x] Per-group board isolation via `BOARD_GROUPS`
- [x] Advisory-lock ordering with concurrency coverage
- [x] Optional AI extraction with retry-safe webhook intake
- [x] Real-time board updates over WebSocket
- [x] Docker full-stack deployment
- [ ] LINE Login for per-user identity (P0 — before multi-team use)
- [x] Edit and soft-delete cards from the board (P1) — title/description/assignee edit; priority/due-date edit not yet exposed
- [ ] Weekly statistics posted to the LINE group (P1)
- [ ] Structured logging and metrics (P2)

---

## License

MIT © Phasathat Jaruchitsophon
