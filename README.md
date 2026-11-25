# SyncBoard — Collaborative Kanban Board

A full-stack collaborative Kanban board built as a TypeScript monorepo (`/shared`, `/server`, `/client`) with SQLite persistence, float-midpoint ordering with automatic transactional rebalancing, Server-Sent Events (SSE), per-field optimistic updates with rollback, and URL-synchronized search/filters.

## 1. Install and Run

### Prerequisites

- Node.js 22+ and npm 10+

### Development

```bash
npm install
npm run dev
```

- Client dev server: `http://localhost:5173` (proxies `/api` and `/health` to `:3001`)
- API + SSE server: `http://localhost:3001`
- In dev, `FAIL_RATE` defaults to `0.1` (10% random 500s on mutating endpoints) with `100–400ms` simulated latency so optimistic UI and rollback are observable. Override with `FAIL_RATE=0 npm run dev`.

### Production (Single Service)

```bash
npm install
npm run build
NODE_ENV=production npm start
```

Express serves both the API (`/api/*`, `/health`) and the built static Vite client (`/client/dist`) on `http://localhost:3001` (or `PORT`).

### Tests, Lint & Formatting

```bash
npm test           # Vitest across shared, server (supertest + SSE), and client
npm run lint       # Strict TypeScript ESLint (no any)
npm run format:check
```

---

## 2. What Is Complete / What Is Not

### Complete

- **Monorepo & Shared Contracts (`/shared`)**: Strict TypeScript `Task`, `Column`, `SSEEvent` types and midpoint/rebalancing math (`computeInsertPosition`, `columnNeedsRebalance`, `computeRebalancedPositions`).
- **Server (`/server`)**: Express + `better-sqlite3` (WAL mode, 20 seeded tasks on first run), Zod request validation (400/404), float midpoint positioning with single-transaction column rebalancing when gap `< 1e-6`, `X-Client-Id` / `X-Mutation-Id` propagation, SSE `/api/events` with 15s heartbeats, `id:` frames, `Last-Event-ID` replay buffer, `FAIL_RATE` + `?fail=1` failure injection, `/health`, CORS, and production static serving.
- **Client (`/client`)**: TanStack Query + pending-mutation store, loading skeleton + error retry, inline task creation per column, `@dnd-kit/core` + `@dnd-kit/sortable` drag & drop (pointer + keyboard sensors, `DragOverlay`, empty-column drops), debounced title search + priority + assignee filters with `AND` semantics, URL query sync (`q`, `priority`, `assignee`, `task`) with `replaceState`/`pushState`/`popstate`, accessible slide-over `TaskDrawer` (focus trap, `Esc` to close, delete confirmation), error toasts with Retry, and live/reconnecting status badge.
- **Note on Filtered Drag & Drop**: Drag handles and sorting are disabled while filters are active (`isFiltered`), with a subtle notice in the filter bar, so hidden filtered tasks never cause ambiguous neighbor positions.

### Not Included

- User authentication, permissions, or live presence cursors/avatars.
- Offline IndexedDB mutation queue across full page reloads.
- Automated Playwright end-to-end browser tests (unit + API/SSE integration tests are automated; multi-tab E2E is covered by the manual test script below).

---

## 3. How Optimistic Updates and Rollback Work

- **Per-field snapshots (`pending`)**: Every mutation generates a `mutationId` and snapshots only the affected fields in `pending: Map<taskId, Map<field, { mutationId, previousValue }>>`, applying the change to the local board immediately.
- **Serialized per-task queue**: Mutations for the same `taskId` are chained on a per-task promise queue (`taskQueuesRef`) so a drag followed immediately by a drawer title edit resolves in order without racing.
- **Selective success resolution**: On `PATCH` success, only fields NOT owned by a newer pending `mutationId` are replaced with the server response; the resolved mutation's pending entries are cleared.
- **Field-scoped rollback & baseline propagation**: On failure, only fields still owned by the failed `mutationId` roll back to `previousValue`, and an error toast with a **Retry** button appears. If a newer mutation superseded that field while it was in flight, the failed mutation propagates its pre-failure `previousValue` into the newer entry's baseline so a subsequent failure does not resurrect failed optimistic state.
- **Create & Delete**: Creating inserts a `temp-*` task in `"saving"` state and swaps its `id` on success (or removes it on failure). Deleting hides the task immediately and restores it at its original index on failure.

---

## 4. How Real-Time Events Are Applied Without Overwriting Local Changes

- **Echo suppression**: Each tab generates a random `X-Client-Id` and attaches a unique `X-Mutation-Id` per mutation. Incoming SSE events whose `mutationId` is in our in-flight or recently completed set are ignored (while rebalance updates for neighbor tasks with `mutationId: null` still apply).
- **Field-level merge + baseline update**: When an external `task.updated` arrives for a task with pending local edits, non-pending fields update immediately from the server payload, while pending fields keep their local value and update `previousValue` in `pending` to the incoming server value so a later rollback never resurrects stale data.
- **Stale event dropping**: Events with `updatedAt` older than the currently held task's `updatedAt` are ignored.
- **Active-drag protection**: SSE events touching columns currently involved in a drag are buffered until drop completes—except `task.deleted` for the actively dragged task, which immediately cancels the drag, discards its pending mutations, and displays `"This task was deleted by someone else"` (and likewise closes the drawer if open).
- **Reconnect resync**: When `EventSource` reconnects after a drop, the client refetches `GET /api/board` and reconciles against `pending` using the same field-level merge rules.

---

## 5. Multi-Tab Manual Test Script

1. Start the app (`FAIL_RATE=0.1 npm run dev`) and open `http://localhost:5173` in **Tab A** and **Tab B**.
2. **Concurrent field edits**: In Tab A, open a task drawer and edit its **Title** (click outside or wait). In Tab B, edit the same task's **Priority** and **Description**. Both changes merge in both tabs without overwriting each other.
3. **Drag during a remote update**: Start dragging a card in **Tab A** and hold it over another column. In **Tab B**, edit or move a card in that target column. Release the card in **Tab A** — buffered remote updates flush cleanly after drop without reordering mid-drag.
4. **Remote delete while editing/dragging**: Open a task drawer (or hold it in a drag) in **Tab A**, then delete that same task in **Tab B**. Tab A closes the drawer / cancels the drag and displays `"This task was deleted by someone else"`.
5. **Forced failure & rollback (`?fail=1`)**: Open `http://localhost:5173/?fail=1`, drag a card or edit a field, observe the optimistic move followed by automatic rollback and an error toast with **Retry**. Remove `?fail=1` from the URL (or send a normal request without `?fail=1`) and click **Retry** to commit.

---

## 6. Known Limitations and What I'd Do Next

- **Single-instance in-memory SSE broker**: Events are broadcast from one Node process; scaling horizontally would require Redis Pub/Sub (or Postgres `LISTEN/NOTIFY`) between API instances and replacing SQLite with PostgreSQL.
- **Transport & presence**: Upgrading SSE + REST to WebSockets would enable live collaborator presence, typing indicators, and active-drag locks.
- **Conflict resolution**: Current merge is last-writer-wins per field (`updatedAt`); collaborative rich-text descriptions would benefit from CRDTs (e.g., Yjs) or OT.
- **Auth & multi-tenancy**: Adding user accounts, workspace/board scoping, and RBAC authorization checks on every API and stream subscription.

---

## 7. Deployment (Single Service)

This repository includes a multi-stage `Dockerfile` and `render.yaml` that build all workspaces and run one Node server serving `/client/dist` + `/api/*`.

### Option A: Render (using `render.yaml`)

1. Push this repository to GitHub/GitLab.
2. In Render Dashboard, click **New -> Blueprint** and select the repo (`render.yaml` configures Docker runtime, `/health` check, `FAIL_RATE=0`, and a 1 GB persistent disk mounted at `/data` for `DB_PATH=/data/kanban.db`).
   - _Note_: On Render's free tier without a persistent disk, remove the `disk:` block from `render.yaml`; SQLite will store data inside the container and reset to the 20 seed tasks on redeploy.

### Option B: Docker / Railway / Fly.io

```bash
docker build -t syncboard-kanban .
docker run -p 3001:3001 -v kanban_data:/data -e FAIL_RATE=0 syncboard-kanban
```

- **Fly.io**: `fly launch --no-deploy`, attach a volume (`fly volumes create kanban_data --size 1`), mount it at `/data` in `fly.toml`, set `DB_PATH=/data/kanban.db` and `FAIL_RATE=0`, then `fly deploy`.
- **Railway**: Connect the repo (auto-detects `Dockerfile`), add a Volume mounted at `/data`, and set `DB_PATH=/data/kanban.db` and `FAIL_RATE=0`.

---

## 8. Coding Agents Used

- **Antigravity**: Used end-to-end across all 6 phases to scaffold the npm workspace monorepo, implement the SQLite/Express/SSE backend and React/TanStack Query/`@dnd-kit` frontend, author Vitest + Supertest unit/integration tests, resolve strict ESLint checks, and generate deployment configuration.
