# LINE Task Manager — System Design

| Item | Detail |
|---|---|
| Project | LINE Task Manager |
| Version | 1.0 |
| Last updated | 2026-06-11 |
| Status | Implemented (Phases 1–3 shipped; see §6) |

---

## §1. Overview

A Kanban board integrated with LINE group chats. A bot reads messages in a LINE group, extracts actionable tasks, and displays them on a realtime Kanban board where the team manages status through `Todo → In Process → Test → Done`.

---

## §2. Architecture Diagram

```
┌─────────────┐   messages   ┌──────────────┐
│  LINE Group │ ───────────> │ LINE Platform │
└─────────────┘              └──────┬───────┘
                                    │ Webhook (HTTPS POST)
                                    v
                          ┌──────────────────┐
                          │  Backend (NestJS) │
                          │  - webhook intake │
                          │  - task extraction│ ──> [Claude API (optional)]
                          │  - REST + WebSocket│
                          └─────────┬─────────┘
                                    │
                       ┌────────────┼────────────┐
                       v                          v
                ┌─────────────┐           ┌──────────────┐
                │ PostgreSQL  │           │  Frontend     │
                │ (tasks,     │           │  Kanban Board │
                │  users,     │           │  (React)      │
                │  messages)  │           └──────────────┘
                └─────────────┘
```

---

## §3. Bounded Contexts

| # | Context | Responsibility | Flow Doc |
|---|---|---|---|
| 1 | LINE Integration | Webhook receiving, X-Line-Signature verification, LINE API calls (Get Profile, Reply/Push Message) | [line-intake-task-creation](../flows/202606080000-line-intake-task-creation-flow.html) |
| 2 | Task Extraction | Message classification (task vs. conversation), multi-task splitting, task creation with source metadata | [line-intake-task-creation](../flows/202606080000-line-intake-task-creation-flow.html) |
| 3 | Board & Assignment | Kanban board display (4 columns), drag-and-drop status transitions, realtime WebSocket sync, member task assignment | [kanban-board-assignment](../flows/202606080001-kanban-board-assignment-flow.html) |

---

## §4. Tech Stack (as implemented)

| Component | Choice | Rationale |
|---|---|---|
| Backend | NestJS (Node.js + TypeScript) | Official LINE SDK; modular structure |
| LINE | LINE Messaging API + `@line/bot-sdk` | Core of the system |
| AI | Claude API (`@anthropic-ai/sdk`), optional | Extracts tasks from natural-language messages; failures return 503 for webhook retry |
| Frontend | React + Vite + dnd-kit | Kanban drag and drop; dnd-kit actively maintained |
| Realtime | Socket.IO | Live board updates, target delay ≤1–2 s (NFR) |
| Database | PostgreSQL 16 (raw SQL via `pg`) | Relational fit for tasks/users/messages |
| Hosting | Docker Compose + nginx | LINE webhook requires HTTPS with a valid certificate; single public entry point |

---

## §5. Data Model

See `migrations/` for the authoritative schema.

### tasks

| field | type | description |
|---|---|---|
| id | string (uuid) | Task ID |
| title | string | Short title (truncated at 60 graphemes) |
| description | text | Full detail, including original LINE message text |
| status | enum | `todo` / `in_process` / `test` / `done` |
| source_message_id | string FK | LINE messageId (→ line_messages) |
| group_id | string | Source LINE groupId |
| created_by | string FK | LINE userId of the requester (→ users) |
| assignee_id | string FK \| null | Assignee (→ users); null = unassigned |
| priority | enum \| null | low / medium / high (optional) |
| due_date | date \| null | Due date (optional) |
| position | integer | Card order within its column |
| created_at | datetime | Created timestamp |
| updated_at | datetime | Last updated timestamp |

### users

| field | type | description |
|---|---|---|
| id | string | Internal ID (currently equals line_user_id) |
| line_user_id | string | userId from LINE |
| display_name | string | Name shown on cards |
| role | enum | `member` / `admin` (not yet enforced) |

### line_messages

| field | type | description |
|---|---|---|
| message_id | string PK | messageId from LINE (webhook dedupe key) |
| group_id | string | Source groupId |
| user_id | string | Sender userId |
| content | text | Raw original message |
| created_at | datetime | Received timestamp |

---

## §6. Development Phases

| Phase | Scope | Status |
|---|---|---|
| **1 — MVP** | Webhook + `/task` keyword → 4-column Kanban board with drag and drop | Done |
| **2 — AI** | Optional AI extraction of tasks from natural-language messages | Done |
| **3 — Assign + Notify** | Task assignment, LINE notifications on status change, priority/due date | Done |
| **4 — Report** | Backlog statistics, completion counts, average time per task | Planned |

---

*Flow docs hub: [docs/flows/index.html](../flows/index.html)*
