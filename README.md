# LINE Task Manager

A Kanban board integrated with LINE group chats. A bot reads messages in a LINE group, extracts actionable tasks, and places them on a four-column board (`Todo → In Process → Test → Done`). Status changes and assignments are pushed back to the group automatically.

For a complete onboarding reference (architecture, data model, API, conventions), see [PROJECT_GUIDE.md](PROJECT_GUIDE.md).

## Screenshots

The Kanban board — four columns, priority and due-date badges (overdue cards turn red), drag-and-drop, and per-card assignment:

![Kanban board](docs/review/board-overview.png)

When `BOARD_PASSWORD` is set, the board is gated by a password (compared in constant time):

![Locked board](docs/review/board-locked.png)

## Project Status

The full message-to-board pipeline is **implemented and verified** — a signed webhook payload
flows through signature check → dedupe → extraction → persistence → realtime board update → group reply.
CI runs the unit suite (signature verification, the webhook controller's signature gate, webhook-service
branch handling, AI extraction with the Anthropic client mocked, the board guard, the realtime gateway,
and DTO validation — gated by a c8 coverage threshold), the Postgres integration suite (repository
position/concurrency), and the browser end-to-end suite (board rendering, realtime updates, drag-and-drop,
and the webhook 400-on-bad-signature gate).

What is **not** done for you, because it needs your own credentials and a public URL: connecting the bot
to a **real LINE Official Account** and a live group. Until the checklist below is complete, the bot
cannot receive messages from an actual LINE group.

### Go-Live Checklist

Complete these in order to take the bot from "runs locally" to "reads tasks from a real LINE group".
Detailed steps for each are in [Connecting a LINE Official Account](#connecting-a-line-official-account).

- [ ] **1. Create a LINE Messaging API channel** in the [LINE Developers Console](https://developers.line.biz).
- [ ] **2. Put real credentials in `backend/.env`** — `LINE_CHANNEL_SECRET` and `LINE_CHANNEL_ACCESS_TOKEN`.
      (Local tests use `LINE_CHANNEL_SECRET=test_secret` and no token, so live LINE calls return 401 — that is expected in dev.)
- [ ] **3. Set `BOARD_PASSWORD` and `CORS_ORIGIN`** before exposing the board publicly.
- [ ] **4. Run the stack** — `docker compose --profile full up -d --build` (board + webhook served on `:8080`).
- [ ] **5. Expose a public HTTPS URL** to `:8080` — `ngrok http 8080` for testing, or deploy behind a real domain.
- [ ] **6. Configure the webhook in LINE** — set Webhook URL to `https://<your-domain>/webhook`, click **Verify** (must report Success), and enable **Use webhook**.
- [ ] **7. Allow group chats** — in LINE Official Account Manager: Webhooks **on**, Auto-response **off**, and enable **Allow bot to join group chats**.
- [ ] **8. Invite the bot to a group** and send `/task ...` (one line per task). Cards should appear on the board, and the bot should reply in the group.
- [ ] **9. (Optional) Enable no-keyword AI intake** — set `ANTHROPIC_API_KEY` so plain messages that describe work become cards without the `/task` keyword.

> **How task detection works:** without `ANTHROPIC_API_KEY`, only messages starting with `/task` create cards
> (one line = one task); plain chat is ignored. With the key set, the AI also classifies keyword-free messages.

## Features

- Task intake from LINE via the `/task` keyword; one line per task, with deduplication on LINE webhook retries
- Optional AI classification of natural-language messages (no keyword required) using the Claude API, enabled by setting `ANTHROPIC_API_KEY`
- Priority tokens (`!high`, `!low`, plus Thai aliases) and due dates (`@YYYY-MM-DD`) parsed onto cards, with overdue indicators
- Four-column Kanban board with cross-column drag and drop and persistent in-column ordering
- LINE push notifications on status change and assignment, with configurable status filtering to limit message quota usage
- Realtime board updates for all connected clients over WebSocket, with a reconnection banner on connection loss
- Shared board password (`BOARD_PASSWORD`) protecting both REST and WebSocket access, plus configurable CORS
- Full Docker deployment (PostgreSQL, backend, frontend behind nginx) exposed through a single public URL for both the board and the LINE webhook
- Unit tests, end-to-end tests, and GitHub Actions CI

## Repository Layout

| Path | Description |
|---|---|
| `backend/` | NestJS application: LINE webhook, REST API, WebSocket gateway, AI extraction, PostgreSQL access |
| `frontend/` | React + Vite + dnd-kit Kanban board, with `nginx.conf` for production |
| `migrations/` | SQL migrations (`line_messages`, `users`, `tasks`) |
| `docs/` | System design document and interactive flow diagrams |
| `docker-compose.yml` | PostgreSQL for development; full stack via the `full` profile |
| `.github/workflows/` | CI: build and test for backend and frontend |

## Development Setup

Requires Node.js 20+ and Docker.

```bash
# 1. PostgreSQL
docker compose up -d

# 2. Backend
cd backend
npm install
cp .env.example .env        # fill in LINE channel credentials
npm run migrate
npm run start:dev           # http://localhost:3000

# 3. Frontend (separate terminal)
cd frontend
npm install
npm run dev                 # http://localhost:5173
```

## Production Deployment (Docker)

```bash
cp backend/.env.example backend/.env   # fill in all values (see table below)
docker compose --profile full up -d --build
```

- The board and webhook are served behind nginx at `http://localhost:8080`. Point your domain or tunnel at this single endpoint.
- The backend waits for the database, runs migrations automatically on startup, and exposes a health check at `/health`.

### Environment Variables (`backend/.env`)

| Variable | Required | Description |
|---|---|---|
| `LINE_CHANNEL_SECRET` | Yes | From the LINE Developers Console; used to verify webhook signatures |
| `LINE_CHANNEL_ACCESS_TOKEN` | Yes | From the LINE Developers Console; used to send messages |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `TASK_KEYWORD` | No | Keyword that marks a message as a task (default `/task`) |
| `BOARD_PASSWORD` | Recommended | Single shared board key; authorizes the whole board (one LINE group). Unset disables auth (development only). |
| `BOARD_GROUPS` | For multi-group | JSON map `{ "<group_id>": "<board_key>" }` enabling **per-group isolation**: each key authorizes reads/writes for exactly one LINE group, so a key for group A can never see group B's tasks. Takes precedence over `BOARD_PASSWORD`. See [Per-group board isolation](#per-group-board-isolation). |
| `CORS_ORIGIN` | Recommended | Allowed board origin, e.g. `https://board.example.com`; unset allows `*` |
| `NOTIFY_STATUSES` | No | Comma-separated statuses that trigger group notifications (default: all). Set e.g. `done` to conserve quota |
| `NOTIFY_ASSIGN` | No | Notify the group when a task is assigned (default `true`) |
| `ANTHROPIC_API_KEY` | No | Enables AI classification of messages without the keyword |
| `AI_EXTRACT_MODEL` | No | Claude model for extraction (default `claude-haiku-4-5`, the low-cost default; use `claude-opus-4-8` for higher accuracy) |
| `THROTTLE_LIMIT` | No | Max board-API requests per IP per window (default `120`) |
| `THROTTLE_TTL_MS` | No | Rate-limit window in milliseconds (default `60000`). The LINE webhook and `/health` are exempt |
| `WEBHOOK_CONCURRENCY` | No | Max LINE events processed concurrently per webhook delivery (default `3`); bounds AI calls and DB transactions under burst |
| `PORT` | No | HTTP port the backend listens on (default `3000`) |

> All environment variables are validated at startup by `@nestjs/config` (a `class-validator` schema in
> `backend/src/config/env.validation.ts`). A malformed value — a non-numeric `PORT`, invalid `BOARD_GROUPS`
> JSON, an unknown `NODE_ENV` — fails fast and the backend refuses to boot. In production, `assertProdConfig`
> additionally requires board auth (`BOARD_PASSWORD` **or** `BOARD_GROUPS`), an explicit `CORS_ORIGIN`, and a
> non-empty `LINE_CHANNEL_SECRET`.

### Per-group board isolation

By default a single `BOARD_PASSWORD` (or no auth in dev) grants access to the whole board, which is correct
for a **single LINE group**. To onboard multiple groups without exposing one group's tasks to another, set
`BOARD_GROUPS` to a JSON map of `group_id → board key`:

```bash
# Each LINE group gets its own key. A member entering keyA on the board sees only group A's tasks;
# the REST list (GET /tasks) and the realtime WebSocket room are both scoped to that group_id.
BOARD_GROUPS={"Cabc123...":"keyA","Cdef456...":"keyB"}
```

When `BOARD_GROUPS` is set it takes precedence over `BOARD_PASSWORD`: the board key resolves to the one
`group_id` it authorizes, `GET /tasks` returns only that group's rows (`WHERE group_id = $1`), and the
WebSocket gateway joins the socket to that group's room so realtime events never cross groups. The
`group_id` is the LINE group identifier captured when the bot first sees a message from that group. Single-group
deploys need no extra configuration — leave `BOARD_GROUPS` unset and use `BOARD_PASSWORD` (or nothing in dev).

## Connecting a LINE Official Account

### LINE Developers Console (https://developers.line.biz)

1. Create a Provider and a **Messaging API channel** (this is the bot's LINE Official Account).
2. **Basic settings** tab: copy the **Channel secret** into `backend/.env` as `LINE_CHANNEL_SECRET`.
3. **Messaging API** tab: click **Issue** under Channel access token (long-lived) and set `LINE_CHANNEL_ACCESS_TOKEN`.
4. Open a tunnel to nginx: `ngrok http 8080` (or `ngrok http 3000` when running the backend directly in development).
5. Set the **Webhook URL** to `https://<your-domain>/webhook`, click **Verify** (it must report Success), and enable **Use webhook**.
6. In **LINE Official Account Manager** (https://manager.line.biz), under Settings → Response settings: set **Chat** off, **Auto-response** off, **Webhooks** on, and **Greeting message** off.
7. Under Settings → Account settings, enable **Allow bot to join group chats**; without this the bot cannot be invited to a group.

### Trying It Out

8. Invite the bot to a group. It posts a greeting with usage instructions.
9. Send a message in the group:

```
/task Fix the login button on the landing page !high @2026-07-01
Change the button color to green
```

This creates two cards in Todo (the first with high priority and a due date), and the bot confirms the intake in the group.

If `ANTHROPIC_API_KEY` is set, plain messages that describe work (for example, a bug report written conversationally) are converted to cards without the keyword, while ordinary conversation is ignored.

### Group Notifications

- Moving a card across columns pushes a status update to the group.
- Assigning a task pushes an assignment notice.
- Restrict notifications to specific statuses with `NOTIFY_STATUSES`. Push messages consume the Official Account's message quota (the free plan includes roughly 300 messages per month).

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/webhook` | LINE signature | Receives events from the LINE platform |
| GET | `/health` | None | Health check, including database connectivity |
| GET | `/tasks` | `x-board-key` | List tasks ordered by column position. With `BOARD_GROUPS`, scoped to the key's group; otherwise all tasks |
| PATCH | `/tasks/:id/status` | `x-board-key` | Change status (card is appended to the target column) |
| PATCH | `/tasks/:id/move` | `x-board-key` | Move a card to `{status, index}`; used by drag and drop |
| POST | `/tasks/:id/assign` | `x-board-key` | Assign a task: `{userId, displayName}` |

WebSocket events (clients must send `auth.key` when a password is set): `task:created`, `task:updated`, `tasks:refresh`.

## Testing

```bash
# Unit tests — run from source via tsx (no build step needed). Covers signature verification,
# the webhook signature gate, webhook-service branches, AI extraction (Anthropic mocked),
# the board guard, the realtime gateway, and DTO validation.
cd backend && npm test

# Unit tests with coverage (c8, fails below lines 80 / functions 80 / branches 70).
cd backend && npm run test:cov

# Integration tests (real PostgreSQL: position ordering and concurrency of createTask/move).
# Requires Postgres up and migrated.
docker compose up -d && npm run migrate && npm run test:integration

# End-to-end tests (drives a real Chrome session: board rendering, realtime updates, drag and drop,
# and the webhook 400-on-bad-signature gate). Requires the backend on :3000 (started with
# LINE_CHANNEL_SECRET=test_secret) and Vite on :5173. Set CHROME_PATH on non-macOS hosts.
cd frontend && npm run test:e2e
```

GitHub Actions runs three jobs on every push and pull request: **backend** (build, unit tests with
the c8 coverage gate, then the Postgres integration suite), **frontend** (type-check and build), and
**e2e** (boots the backend + Vite preview and runs the browser suite headless via Chrome). The e2e job
depends on backend and frontend passing.

## Design Decisions

| Topic | Decision |
|---|---|
| Task detection | `/task` keyword, with optional AI classification enabled by `ANTHROPIC_API_KEY` |
| Multiple tasks per message | Each line after the keyword becomes one task |
| Duplicate prevention | `message_id` is checked before insert to absorb LINE webhook retries |
| Card ordering | A per-column `position` is persisted; ordering survives moves, inserts, and page refreshes |
| Ordering integrity | Position writes (`create`, `move`, status change) run in a transaction and serialize on a per-column advisory lock, so concurrent edits cannot corrupt order |
| Authentication | A board key compared in constant time. Single-group: one shared `BOARD_PASSWORD`. Multi-group: `BOARD_GROUPS` maps a key to one `group_id`, isolating each group's board (LINE Login is planned for per-user identity) |
| Rate limiting | Per-IP throttle on the board API; webhook and health checks are exempt |
| AI failure handling | Fail-open: if extraction errors or times out, the message is skipped and the webhook is never blocked |

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md) for the prioritized, handoff-ready backlog (with code pointers
and acceptance criteria). In short:

- **P0 (before multi-team use):** LINE Login for per-user identity
- **P1:** edit/delete cards from the board; weekly statistics posted to the group
- **P2:** structured logging/metrics

> **Per-group isolation is implemented.** `TasksRepository.findAll(groupId)` scopes reads by
> `group_id`, and the board key resolves to the group it authorizes (via `BOARD_GROUPS`), so one
> group's tasks are never visible to a holder of another group's key — over both REST and the
> realtime WebSocket. See [Per-group board isolation](#per-group-board-isolation). The contract is
> covered by an integration test in `backend/test/repository.integration.mts` plus guard/controller
> unit tests in `backend/test/{board-key.guard,tasks.controller,config}.test.mts`.
