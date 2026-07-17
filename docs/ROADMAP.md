# Roadmap & Handoff Notes

A prioritized backlog written for a developer picking this project up cold. Read
[PROJECT_GUIDE.md](../PROJECT_GUIDE.md) first for architecture and conventions, then this file for
"what to build next and where to start". Each item lists **why**, **where in the code**, an
**approach**, and **acceptance criteria** so it can be handed off without further context.

## Current status (baseline)

Shipped and verified (unit + integration + e2e, green in CI):

- LINE webhook intake → `/task` keyword parsing → 4-column Kanban board with drag-and-drop.
- Optional AI extraction of keyword-free messages (`ANTHROPIC_API_KEY`, default model `claude-haiku-4-5`).
- Assignment, priority/due-date badges, overdue indicator, realtime sync over Socket.IO.
- Hardening pass (see [review/CHANGES.md](review/CHANGES.md)): atomic position writes (transaction +
  per-column advisory lock), constant-time auth, per-IP rate limiting, `400` on invalid status.

What is **not** connected: a real LINE Official Account / live group — that is operator setup, not code.
See the [Go-Live Checklist](../README.md#go-live-checklist).

## Priority legend

- **P0** — blocks selling to more than one team. Do these before scaling.
- **P1** — high user value, no architectural blocker.
- **P2** — operability / quality investments.
- **P3** — nice-to-have.

---

## P0 — Multi-tenant foundation

These two ship together: per-group isolation is meaningless without a real board identity, and LINE
Login is what supplies that identity. Today anyone with the shared password sees **every** group's
tasks, and the assignee identity is a client-generated random id (`App.tsx` `loadMember`).

### P0.1 — LINE Login (board identity = LINE identity)

- **Why:** Replaces the shared password and the spoofable client-side member id with a real per-user
  LINE identity. Unblocks per-group access control and trustworthy assignment.
- **Where:** New auth flow alongside `auth/board-key.guard.ts`; frontend `App.tsx` login path and
  `socket.ts` / `api.ts` (swap `x-board-key` for a session token); `users` table already exists
  (`migrations/002_create_users.sql`, `users.line_user_id`).
- **Approach:** LINE Login (OAuth 2.0 / OIDC) → verify id_token → issue a short-lived session
  (signed JWT or httpOnly cookie) → guard reads the session instead of (or in addition to) the
  board key. Keep `BOARD_PASSWORD` as a fallback for local dev.
- **Acceptance:** A user logs in with LINE; their `line_user_id` is the board identity; assignment
  uses it (no client-supplied id); the board key path still works for local dev.
- **External setup:** A LINE Login channel + redirect URIs in the LINE console.
- **Effort:** L.

### P0.2 — Per-group board isolation

- **Why:** Privacy. With the bot in multiple clients' groups, every board viewer currently sees all
  tasks across all groups. `tasks.group_id` is already stored — the board just doesn't filter on it.
- **Where:** `tasks.repository.ts` `findAll()` (add a `group_id` filter), `tasks.controller.ts`
  (scope by the caller's groups), realtime `events.gateway.ts` (emit to per-group rooms instead of
  `server.emit` to everyone), frontend group selector.
- **Approach:** Map an authenticated user (from P0.1) to the groups they belong to, then filter REST
  queries and scope Socket.IO broadcasts to group rooms. Add a `group_members` table or derive
  membership from LINE group profile lookups.
- **Acceptance:** A user only sees tasks for groups they belong to; realtime events for group A never
  reach a client viewing only group B.
- **Depends on:** P0.1.
- **Effort:** M–L.

---

## P1 — High-value features

### P1.1 — Edit and delete cards from the board — ✅ shipped

- **Why:** Today cards are immutable once created; typos and stale tasks can't be fixed from the UI.
- **Where:** `PATCH /tasks/:id` and `DELETE /tasks/:id` in `tasks.controller.ts` →
  `tasks.service.ts` → `tasks.repository.ts`; frontend `TaskCard.tsx` (edit/delete affordance),
  `api.ts`. Emits `task:updated` on edit and `task:deleted` on delete. Delete is a soft-delete
  (`tasks.deleted_at`, `migrations/006_add_deleted_at_to_tasks.sql`) — the row is kept for history
  and excluded from `findAll`/`findById`, not hard-deleted.
- **Shipped scope:** title/description/assignee edit + soft-delete, both group-scoped (IDOR-safe)
  and covered by unit + integration tests.
- **Not yet done:** priority/due-date are not editable from this endpoint — open a follow-up if
  needed (small addition: extend `UpdateTaskDto` + `TasksRepository.update()`'s field list).
- **Effort:** M.

### P1.2 — Weekly statistics & summary reports (Phase 4)

- **Why:** Planned Phase 4 in [system design](01-architecture/00-system-design.md); gives the group
  visibility (backlog size, completion counts, average time per task).
- **Where:** New scheduled job (cron) computing stats from `tasks` (use `created_at`/`updated_at`),
  pushed via `line-client.service.ts` `pushToGroup`. Mind the OA quota (~300 msg/month free).
- **Acceptance:** A weekly summary posts to each active group with backlog/done counts and average
  cycle time; schedule and on/off are configurable via env.
- **Effort:** M.

---

## P2 — Operability & quality

### P2.1 — Structured logging, metrics, tracing

- **Why:** Current logging is `Logger.warn/error` strings; hard to debug or alert in production.
- **Where:** Backend bootstrap (`main.ts`), cross-cutting. Add request ids, structured (JSON) logs,
  and a `/metrics` endpoint (Prometheus) for webhook volume, AI latency/failures, push failures.
- **Acceptance:** Logs are structured and correlatable; key counters are scrapeable.
- **Effort:** M.

### P2.2 — Run e2e in CI

- **Why:** `frontend/scripts/e2e.mjs` exists but CI only runs unit + integration + build.
- **Where:** `.github/workflows/ci.yml` — add a job with Postgres + headless Chrome, start backend
  (`LINE_CHANNEL_SECRET=test_secret`) and Vite, then run `npm run test:e2e`.
- **Acceptance:** e2e runs on PRs and gates merge.
- **Effort:** S–M.

---

## P3 — Nice-to-have

- **Enforce `users.role`** (`member`/`admin`) — the column exists (`migrations/002`) but nothing
  checks it. Gate destructive actions (P1.1 delete) behind `admin` once roles mean something.
- **Pagination / archiving** — the board loads all tasks for a group at once; add archiving of old
  `done` cards or pagination as volume grows.
- **Down-migrations / a migration version table** — migrations are currently forward-only and
  idempotent (`IF NOT EXISTS`); add versioning if rollbacks become necessary.

---

## How to pick up an item

1. Read [PROJECT_GUIDE.md](../PROJECT_GUIDE.md) §2 (architecture) and §9 (conventions).
2. Check the "Where in the code" pointers above and the relevant flow doc in [docs/flows/](flows/index.html).
3. Follow the error philosophy (PROJECT_GUIDE §9): webhook fail-open, board API explicit 4xx, realtime
   events on every mutation.
4. Add tests at the right layer (unit for pure logic, integration for SQL/concurrency, e2e for UI) and
   keep CI green.
