import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { POSITION_STEP, type ColumnId, type Priority, type Task } from "@kanban/shared";

let lastTimestampMs = 0;

/**
 * Generates a strictly monotonic ISO 8601 timestamp so rapid sequential writes
 * never collide on the same millisecond.
 */
export function nextIsoTimestamp(): string {
  const now = Date.now();
  lastTimestampMs = now > lastTimestampMs ? now : lastTimestampMs + 1;
  return new Date(lastTimestampMs).toISOString();
}

interface SeedItem {
  title: string;
  description: string;
  priority: Priority;
  assignee: string;
  status: ColumnId;
}

const SEED_TASKS: readonly SeedItem[] = [
  // Backlog (5)
  {
    title: "Add keyboard shortcut guide modal",
    description: "Display available keyboard shortcuts when the user presses '?'.",
    priority: "low",
    assignee: "Maya",
    status: "backlog",
  },
  {
    title: "Support CSV export for sprint retrospective",
    description: "Allow exporting filtered tasks as a downloadable CSV report.",
    priority: "low",
    assignee: "Liam",
    status: "backlog",
  },
  {
    title: "Evaluate WebSocket upgrade path",
    description: "Document trade-offs between SSE + REST and bidirectional WebSockets for presence.",
    priority: "medium",
    assignee: "Aria",
    status: "backlog",
  },
  {
    title: "Design dark mode color tokens",
    description: "Define high-contrast surface, border, and priority badge variables.",
    priority: "low",
    assignee: "Noah",
    status: "backlog",
  },
  {
    title: "Add archived column retention policy",
    description: "Automatically hide tasks completed more than 30 days ago behind a toggle.",
    priority: "medium",
    assignee: "Elena",
    status: "backlog",
  },

  // Todo (6)
  {
    title: "Implement optimistic rollback toast actions",
    description: "Surface a Retry button on failed mutations so users can recover immediately.",
    priority: "high",
    assignee: "Aria",
    status: "todo",
  },
  {
    title: "Add URL query sync for board filters",
    description: "Keep search query, priority, assignee, and active task drawer reflected in URLSearchParams.",
    priority: "high",
    assignee: "Liam",
    status: "todo",
  },
  {
    title: "Build focus trap for task detail drawer",
    description: "Ensure Tab cycling stays inside the drawer and Escape closes it cleanly.",
    priority: "medium",
    assignee: "Maya",
    status: "todo",
  },
  {
    title: "Write position rebalancing integration tests",
    description: "Verify 1e-6 threshold triggers a transactional 1024-step rebalance.",
    priority: "high",
    assignee: "Noah",
    status: "todo",
  },
  {
    title: "Add per-column empty state messaging",
    description: "Show helpful feedback when a column has zero tasks or zero filter matches.",
    priority: "low",
    assignee: "Elena",
    status: "todo",
  },
  {
    title: "Audit aria-labels on drag handles and cards",
    description: "Test screen reader announcements for card moves across columns.",
    priority: "medium",
    assignee: "Maya",
    status: "todo",
  },

  // In Progress (5)
  {
    title: "Wire SSE real-time event stream",
    description: "Broadcast task.created, task.updated, and task.deleted with originClientId and mutationId.",
    priority: "high",
    assignee: "Aria",
    status: "in-progress",
  },
  {
    title: "Serialize per-task mutation queues",
    description: "Prevent drag-and-drop and immediate drawer edits from racing on the same task.",
    priority: "high",
    assignee: "Liam",
    status: "in-progress",
  },
  {
    title: "Buffer column reorders during active drag",
    description: "Defer incoming SSE events affecting the column currently being dragged until drop.",
    priority: "medium",
    assignee: "Noah",
    status: "in-progress",
  },
  {
    title: "Configure single-service production Dockerfile",
    description: "Build shared, server, and client workspaces and serve static assets from Express.",
    priority: "medium",
    assignee: "Elena",
    status: "in-progress",
  },
  {
    title: "Add live connection status indicator",
    description: "Show whether the SSE EventSource is live or currently reconnecting.",
    priority: "low",
    assignee: "Maya",
    status: "in-progress",
  },

  // Done (4)
  {
    title: "Initialize SQLite schema with WAL mode",
    description: "Set up better-sqlite3 database with indexed status and position columns.",
    priority: "high",
    assignee: "Aria",
    status: "done",
  },
  {
    title: "Define shared Task and SSE types",
    description: "Create strict TypeScript contracts in /shared consumed by server and client.",
    priority: "medium",
    assignee: "Liam",
    status: "done",
  },
  {
    title: "Set up Zod request body validation",
    description: "Return structured 400 errors on invalid POST and PATCH payloads.",
    priority: "medium",
    assignee: "Noah",
    status: "done",
  },
  {
    title: "Implement health check endpoint",
    description: "Expose GET /health for container orchestration readiness probes.",
    priority: "low",
    assignee: "Elena",
    status: "done",
  },
];

export function initDatabase(dbPath: string, options: { seed?: boolean } = {}): Database.Database {
  if (dbPath !== ":memory:") {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high')),
      assignee TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('backlog', 'todo', 'in-progress', 'done')),
      position REAL NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status_position
      ON tasks (status, position);
  `);

  const shouldSeed = options.seed ?? true;
  if (shouldSeed) {
    seedIfEmpty(db);
  }

  return db;
}

export function seedIfEmpty(db: Database.Database): void {
  const row = db.prepare("SELECT COUNT(*) as count FROM tasks").get() as { count: number };
  if (row.count > 0) {
    return;
  }

  const insert = db.prepare(`
    INSERT INTO tasks (id, title, description, priority, assignee, status, position, updatedAt)
    VALUES (@id, @title, @description, @priority, @assignee, @status, @position, @updatedAt)
  `);

  const columnCounts = new Map<ColumnId, number>();

  const seedTransaction = db.transaction(() => {
    for (const item of SEED_TASKS) {
      const idx = (columnCounts.get(item.status) ?? 0) + 1;
      columnCounts.set(item.status, idx);
      const task: Task = {
        id: crypto.randomUUID(),
        title: item.title,
        description: item.description,
        priority: item.priority,
        assignee: item.assignee,
        status: item.status,
        position: idx * POSITION_STEP,
        updatedAt: nextIsoTimestamp(),
      };
      insert.run(task);
    }
  });

  seedTransaction();
}
