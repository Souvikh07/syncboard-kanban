# SyncBoard — Collaborative Kanban Board

A full-stack collaborative Kanban board built as a TypeScript monorepo (`/shared`, `/server`, `/client`) with MongoDB persistence, float-midpoint ordering with automatic `bulkWrite` rebalancing, Server-Sent Events (SSE), per-field optimistic updates with rollback, and URL-synchronized search/filters.

## 1. Install and Run

### Prerequisites

- Node.js 22+ and npm 10+
- MongoDB (local `mongod`, MongoDB Docker container, or MongoDB Atlas URI)

### Development

Set `MONGODB_URI` (defaults to `mongodb://127.0.0.1:27017/kanban`):

```bash
# Example with local MongoDB via Docker (optional):
# docker run -d --name kanban-mongo -p 27017:27017 mongo:7

npm install
npm run dev
```

- Client dev server: `http://localhost:5173` (proxies `/api` and `/health` to `:3001`)
- API + SSE server: `http://localhost:3001`
- On first startup when the `tasks` collection is empty, the server seeds 20 sample tasks with UUID string `_id`s (mapped to `id` in API responses; `_id` / `ObjectId` are never exposed) and creates the `{ status: 1, position: 1 }` index.
- In dev, `FAIL_RATE` defaults to `0.1` (10% random 500s on mutating endpoints) with `100–400ms` simulated latency so optimistic UI and rollback are observable. Override with `FAIL_RATE=0 npm run dev`.

### Production (Single Service)

```bash
npm install
npm run build
NODE_ENV=production MONGODB_URI="mongodb+srv://..." npm start
```

Express serves both the API (`/api/*`, `/health`) and the built static Vite client (`/client/dist`) on `http://localhost:3001` (or `PORT`).

### Tests, Lint & Formatting

```bash
npm test           # Vitest across shared, server (supertest + mongodb-memory-server), and client
npm run lint       # Strict TypeScript ESLint (no any)
npm run format:check
```

Server tests use `mongodb-memory-server`, so no external MongoDB instance is required to run `npm test`.

---

## 2. What Is Complete / What Is Not

### Complete

- **Monorepo & Shared Contracts (`/shared`)**: Strict TypeScript `Task`, `Column`, `SSEEvent` types and midpoint/rebalancing math (`computeInsertPosition`, `columnNeedsRebalance`, `computeRebalancedPositions`).
- **Server (`/server`)**: Express + official `mongodb` driver (20 seeded tasks on empty collection, compound index `{ status: 1, position: 1 }`, UUID `_id` mapped cleanly to `id`), Zod request validation (400/404), float midpoint positioning with single `bulkWrite` column rebalancing when gap `< 1e-6`, `X-Client-Id` / `X-Mutation-Id` propagation, SSE `/api/events` with 15s heartbeats, `id:` frames, `Last-Event-ID` replay buffer, `FAIL_RATE` + `?fail=1` failure injection, `/health`, CORS, and production static serving.
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
5. **Forced failure & rollback (`?fail=1`)**: Open `http://localhost:5173/?fail=1`, drag a card or edit a field, observe the optimistic move followed by automatic rollback and an error toast with **Retry**. Remove `?fail=1` from the URL and click **Retry** to commit.

---

## 6. Known Limitations and What I'd Do Next

- **Single-instance in-memory SSE broker**: Events are broadcast from one Node process; scaling horizontally would require Redis Pub/Sub or MongoDB Change Streams across API instances.
- **Transport & presence**: Upgrading SSE + REST to WebSockets would enable live collaborator presence, typing indicators, and active-drag locks.
- **Conflict resolution**: Current merge is last-writer-wins per field (`updatedAt`); collaborative rich-text descriptions would benefit from CRDTs (e.g., Yjs) or OT.
- **Auth & multi-tenancy**: Adding user accounts, workspace/board scoping, and RBAC authorization checks on every API and stream subscription.

---

## 7. Deployment (Single Node Service + MongoDB Atlas, No Docker Required)

### Step 1: Create a Free MongoDB Atlas Cluster

1. Sign up / log in at [cloud.mongodb.com](https://cloud.mongodb.com) and click **+ Create** to create a free **M0** cluster (choose any region close to your Render/Railway region).
2. Under **Security -> Database Access**, create a database user (e.g., `kanban_user`) with **Read and write to any database** permissions and save the password.
3. Under **Security -> Network Access**, click **+ Add IP Address** -> **Allow Access from Anywhere** (`0.0.0.0/0` — convenient for this demo; restrict to your host's outbound IPs in strict production).
4. Go back to **Database -> Connect -> Drivers**, copy your connection string, replace `<password>`, and append a database name (e.g., `kanban`):
   ```
   mongodb+srv://kanban_user:<password>@cluster0.xxxxx.mongodb.net/kanban?retryWrites=true&w=majority
   ```

### Step 2A: Deploy on Render (Blueprint or Web Service)

1. Push this repo to GitHub/GitLab.
2. In Render Dashboard, either click **New -> Blueprint** (uses [render.yaml](render.yaml)) or **New -> Web Service** with:
   - **Environment**: `Node`
   - **Build Command**: `npm ci && npm run build`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/health`
3. Add environment variables:
   - `NODE_ENV=production`
   - `FAIL_RATE=0`
   - `MONGODB_URI=<your Atlas SRV string>`
4. Deploy. Render runs the build, starts Express on `PORT`, seeds 20 tasks into Atlas on first boot, and serves `/client/dist` + `/api/*` from one URL.

### Step 2B: Deploy on Railway

1. Push this repo to GitHub and in Railway click **New Project -> Deploy from GitHub repo**.
2. In service **Settings**:
   - **Build Command**: `npm ci && npm run build`
   - **Start Command**: `npm start`
   - **Healthcheck Path**: `/health`
3. In **Variables**, add:
   - `NODE_ENV=production`
   - `FAIL_RATE=0`
   - `MONGODB_URI=<your Atlas SRV string>`
4. Generate a public domain under **Settings -> Networking**.

---

## 8. Coding Agents Used

- **Antigravity**: Used end-to-end to scaffold the npm workspace monorepo, migrate the backend from SQLite to MongoDB (`mongodb` driver + `bulkWrite` rebalancing + `mongodb-memory-server` tests), build the React/TanStack Query/`@dnd-kit` frontend, author Vitest + Supertest unit/integration tests, resolve strict ESLint checks, and generate deployment configuration.
