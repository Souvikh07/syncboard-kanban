import crypto from "node:crypto";
import { MongoClient, type Collection, type Db } from "mongodb";
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

export interface TaskDoc {
  _id: string;
  title: string;
  description: string;
  priority: Priority;
  assignee: string;
  status: ColumnId;
  position: number;
  updatedAt: string;
}

export function docToTask(doc: TaskDoc): Task {
  return {
    id: doc._id,
    title: doc.title,
    description: doc.description,
    priority: doc.priority,
    assignee: doc.assignee,
    status: doc.status,
    position: doc.position,
    updatedAt: doc.updatedAt,
  };
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
    assignee: "Ananya",
    status: "backlog",
  },
  {
    title: "Support CSV export for sprint retrospective",
    description: "Allow exporting filtered tasks as a downloadable CSV report.",
    priority: "low",
    assignee: "Rohan",
    status: "backlog",
  },
  {
    title: "Evaluate WebSocket upgrade path",
    description:
      "Document trade-offs between SSE + REST and bidirectional WebSockets for presence.",
    priority: "medium",
    assignee: "Aarav",
    status: "backlog",
  },
  {
    title: "Design dark mode color tokens",
    description: "Define high-contrast surface, border, and priority badge variables.",
    priority: "low",
    assignee: "Vikram",
    status: "backlog",
  },
  {
    title: "Add archived column retention policy",
    description: "Automatically hide tasks completed more than 30 days ago behind a toggle.",
    priority: "medium",
    assignee: "Priya",
    status: "backlog",
  },

  // Todo (6)
  {
    title: "Implement optimistic rollback toast actions",
    description: "Surface a Retry button on failed mutations so users can recover immediately.",
    priority: "high",
    assignee: "Aarav",
    status: "todo",
  },
  {
    title: "Add URL query sync for board filters",
    description:
      "Keep search query, priority, assignee, and active task drawer reflected in URLSearchParams.",
    priority: "high",
    assignee: "Rohan",
    status: "todo",
  },
  {
    title: "Build focus trap for task detail drawer",
    description: "Ensure Tab cycling stays inside the drawer and Escape closes it cleanly.",
    priority: "medium",
    assignee: "Ananya",
    status: "todo",
  },
  {
    title: "Write position rebalancing integration tests",
    description: "Verify 1e-6 threshold triggers a bulkWrite 1024-step rebalance.",
    priority: "high",
    assignee: "Vikram",
    status: "todo",
  },
  {
    title: "Add per-column empty state messaging",
    description: "Show helpful feedback when a column has zero tasks or zero filter matches.",
    priority: "low",
    assignee: "Priya",
    status: "todo",
  },
  {
    title: "Audit aria-labels on drag handles and cards",
    description: "Test screen reader announcements for card moves across columns.",
    priority: "medium",
    assignee: "Ananya",
    status: "todo",
  },

  // In Progress (5)
  {
    title: "Wire SSE real-time event stream",
    description:
      "Broadcast task.created, task.updated, and task.deleted with originClientId and mutationId.",
    priority: "high",
    assignee: "Aarav",
    status: "in-progress",
  },
  {
    title: "Serialize per-task mutation queues",
    description: "Prevent drag-and-drop and immediate drawer edits from racing on the same task.",
    priority: "high",
    assignee: "Rohan",
    status: "in-progress",
  },
  {
    title: "Buffer column reorders during active drag",
    description:
      "Defer incoming SSE events affecting the column currently being dragged until drop.",
    priority: "medium",
    assignee: "Vikram",
    status: "in-progress",
  },
  {
    title: "Configure single-service Render deployment",
    description:
      "Build shared, server, and client workspaces and serve static assets from Express.",
    priority: "medium",
    assignee: "Priya",
    status: "in-progress",
  },
  {
    title: "Add live connection status indicator",
    description: "Show whether the SSE EventSource is live or currently reconnecting.",
    priority: "low",
    assignee: "Ananya",
    status: "in-progress",
  },

  // Done (4)
  {
    title: "Configure MongoDB tasks collection and index",
    description: "Set up MongoDB driver with compound index on { status: 1, position: 1 }.",
    priority: "high",
    assignee: "Aarav",
    status: "done",
  },
  {
    title: "Define shared Task and SSE types",
    description: "Create strict TypeScript contracts in /shared consumed by server and client.",
    priority: "medium",
    assignee: "Rohan",
    status: "done",
  },
  {
    title: "Set up Zod request body validation",
    description: "Return structured 400 errors on invalid POST and PATCH payloads.",
    priority: "medium",
    assignee: "Vikram",
    status: "done",
  },
  {
    title: "Implement health check endpoint",
    description: "Expose GET /health for service readiness probes.",
    priority: "low",
    assignee: "Priya",
    status: "done",
  },
];

export interface DatabaseContext {
  client: MongoClient;
  db: Db;
  tasks: Collection<TaskDoc>;
}

export async function initDatabase(
  mongoUri: string,
  options: { seed?: boolean; dbName?: string } = {}
): Promise<DatabaseContext> {
  const client = new MongoClient(mongoUri);
  await client.connect();

  const db = options.dbName ? client.db(options.dbName) : client.db();
  const tasks = db.collection<TaskDoc>("tasks");

  await tasks.createIndex({ status: 1, position: 1 });

  if (options.seed ?? true) {
    await seedIfEmpty(tasks);
  }

  return { client, db, tasks };
}

export async function seedIfEmpty(tasks: Collection<TaskDoc>): Promise<void> {
  const existingCount = await tasks.countDocuments({}, { limit: 1 });
  if (existingCount > 0) {
    return;
  }

  const columnCounts = new Map<ColumnId, number>();
  const docs: TaskDoc[] = [];

  for (const item of SEED_TASKS) {
    const idx = (columnCounts.get(item.status) ?? 0) + 1;
    columnCounts.set(item.status, idx);
    docs.push({
      _id: crypto.randomUUID(),
      title: item.title,
      description: item.description,
      priority: item.priority,
      assignee: item.assignee,
      status: item.status,
      position: idx * POSITION_STEP,
      updatedAt: nextIsoTimestamp(),
    });
  }

  await tasks.insertMany(docs);
}
