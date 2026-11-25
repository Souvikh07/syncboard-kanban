import cors from "cors";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type Database from "better-sqlite3";
import {
  COLUMNS,
  MIN_POSITION_GAP,
  POSITION_STEP,
  columnNeedsRebalance,
  computeRebalancedPositions,
  type ColumnId,
  type SSEEvent,
  type Task,
} from "@kanban/shared";
import { nextIsoTimestamp } from "./db.js";
import { createFailureInjectionMiddleware, extractMutationMeta } from "./middleware.js";
import type { SSEBroker } from "./sse.js";
import { createTaskSchema, updateTaskSchema } from "./validation.js";

export interface AppConfig {
  db: Database.Database;
  sse: SSEBroker;
  failRate?: number;
  minLatencyMs?: number;
  maxLatencyMs?: number;
  corsOrigin?: string | string[] | boolean;
  staticDir?: string | null;
}

function getDefaultFailRate(): number {
  if (process.env.FAIL_RATE !== undefined) {
    const parsed = Number.parseFloat(process.env.FAIL_RATE);
    return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0;
  }
  if (process.env.NODE_ENV === "test") {
    return 0;
  }
  return process.env.NODE_ENV === "production" ? 0 : 0.1;
}

function getDefaultLatency(): { min: number; max: number } {
  if (process.env.NODE_ENV === "test") {
    return { min: 0, max: 0 };
  }
  return { min: 100, max: 400 };
}

export function createApp(config: AppConfig): Express {
  const app = express();
  const { db, sse } = config;
  const latencyDefaults = getDefaultLatency();
  const failRate = config.failRate ?? getDefaultFailRate();
  const minLatencyMs = config.minLatencyMs ?? latencyDefaults.min;
  const maxLatencyMs = config.maxLatencyMs ?? latencyDefaults.max;

  app.use(
    cors({
      origin: config.corsOrigin ?? true,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "X-Client-Id", "X-Mutation-Id", "Last-Event-ID"],
    })
  );
  app.use(express.json({ limit: "256kb" }));
  app.use(extractMutationMeta);

  // Health check before failure injection
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // SSE stream
  app.get("/api/events", (req: Request, res: Response) => {
    const headerLastId = req.header("Last-Event-ID");
    const queryLastId =
      typeof req.query.lastEventId === "string" ? req.query.lastEventId : undefined;
    sse.addClient(res, headerLastId ?? queryLastId ?? null);
  });

  // Fetch board
  app.get("/api/board", (_req: Request, res: Response) => {
    const tasks = db
      .prepare("SELECT * FROM tasks ORDER BY status ASC, position ASC, updatedAt ASC")
      .all() as Task[];
    res.json({
      columns: COLUMNS,
      tasks,
    });
  });

  // Apply failure injection & simulated latency to mutating /api/tasks endpoints
  app.use("/api/tasks", createFailureInjectionMiddleware({ failRate, minLatencyMs, maxLatencyMs }));

  const selectTaskStmt = db.prepare("SELECT * FROM tasks WHERE id = ?");
  const selectColumnStmt = db.prepare(
    "SELECT * FROM tasks WHERE status = ? ORDER BY position ASC, updatedAt DESC, id ASC"
  );
  const maxPositionStmt = db.prepare("SELECT MAX(position) as maxPos FROM tasks WHERE status = ?");
  const insertTaskStmt = db.prepare(`
    INSERT INTO tasks (id, title, description, priority, assignee, status, position, updatedAt)
    VALUES (@id, @title, @description, @priority, @assignee, @status, @position, @updatedAt)
  `);
  const updatePositionStmt = db.prepare(
    "UPDATE tasks SET position = ?, updatedAt = ? WHERE id = ?"
  );
  const deleteTaskStmt = db.prepare("DELETE FROM tasks WHERE id = ?");

  /**
   * Rebalances a column to 1024-step integers if any adjacent gap < 1e-6
   * or if the leading position dropped too close to zero.
   */
  function maybeRebalanceColumn(
    status: ColumnId,
    primaryTaskId: string,
    eventsToEmit: SSEEvent[],
    meta: { originClientId: string | null; mutationId: string | null },
    baseTimestamp: string
  ): Task {
    const colTasks = selectColumnStmt.all(status) as Task[];
    const positions = colTasks.map((t) => t.position);
    const firstPos = positions[0];
    const needs =
      columnNeedsRebalance(positions) || (firstPos !== undefined && firstPos <= MIN_POSITION_GAP);

    if (needs) {
      const updates = computeRebalancedPositions(colTasks);
      const rebalanceTs = updates.length > 0 ? nextIsoTimestamp() : baseTimestamp;
      for (const u of updates) {
        updatePositionStmt.run(u.position, rebalanceTs, u.id);
      }
      const updatedColTasks = selectColumnStmt.all(status) as Task[];
      const changedIds = new Set(updates.map((u) => u.id));
      changedIds.add(primaryTaskId);

      for (const task of updatedColTasks) {
        if (changedIds.has(task.id)) {
          eventsToEmit.push({
            type: "task.updated",
            task,
            originClientId: meta.originClientId,
            mutationId: task.id === primaryTaskId ? meta.mutationId : null,
            updatedAt: task.updatedAt,
          });
        }
      }

      const finalPrimary = updatedColTasks.find((t) => t.id === primaryTaskId);
      if (finalPrimary) {
        return finalPrimary;
      }
    }

    const primary = selectTaskStmt.get(primaryTaskId) as Task;
    eventsToEmit.push({
      type: "task.updated",
      task: primary,
      originClientId: meta.originClientId,
      mutationId: meta.mutationId,
      updatedAt: primary.updatedAt,
    });
    return primary;
  }

  // Create task
  app.post("/api/tasks", (req: Request, res: Response) => {
    const parsed = createTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues.map((i) => i.message).join("; "),
      });
      return;
    }

    const meta = req.mutationMeta ?? { originClientId: null, mutationId: null };
    const input = parsed.data;

    const result = db.transaction(() => {
      const now = nextIsoTimestamp();
      let position = input.position;
      if (position === undefined) {
        const row = maxPositionStmt.get(input.status) as { maxPos: number | null };
        position = row.maxPos === null ? POSITION_STEP : row.maxPos + POSITION_STEP;
      }

      const newTask: Task = {
        id: crypto.randomUUID(),
        title: input.title,
        description: input.description,
        priority: input.priority,
        assignee: input.assignee,
        status: input.status,
        position,
        updatedAt: now,
      };
      insertTaskStmt.run(newTask);

      const eventsToEmit: SSEEvent[] = [];
      const colTasks = selectColumnStmt.all(newTask.status) as Task[];
      const positions = colTasks.map((t) => t.position);
      const firstPos = positions[0];
      const needs =
        columnNeedsRebalance(positions) || (firstPos !== undefined && firstPos <= MIN_POSITION_GAP);

      if (needs) {
        const updates = computeRebalancedPositions(colTasks);
        const rebalanceTs = updates.length > 0 ? nextIsoTimestamp() : now;
        for (const u of updates) {
          updatePositionStmt.run(u.position, rebalanceTs, u.id);
        }
        const updatedColTasks = selectColumnStmt.all(newTask.status) as Task[];
        const createdFinal = updatedColTasks.find((t) => t.id === newTask.id) ?? newTask;
        eventsToEmit.push({
          type: "task.created",
          task: createdFinal,
          originClientId: meta.originClientId,
          mutationId: meta.mutationId,
          updatedAt: createdFinal.updatedAt,
        });
        for (const u of updates) {
          if (u.id !== newTask.id) {
            const changedTask = updatedColTasks.find((t) => t.id === u.id);
            if (changedTask) {
              eventsToEmit.push({
                type: "task.updated",
                task: changedTask,
                originClientId: meta.originClientId,
                mutationId: null,
                updatedAt: changedTask.updatedAt,
              });
            }
          }
        }
        return { task: createdFinal, events: eventsToEmit };
      }

      eventsToEmit.push({
        type: "task.created",
        task: newTask,
        originClientId: meta.originClientId,
        mutationId: meta.mutationId,
        updatedAt: newTask.updatedAt,
      });
      return { task: newTask, events: eventsToEmit };
    })();

    for (const ev of result.events) {
      sse.emit(ev);
    }

    res.status(201).json(result.task);
  });

  // Update task
  app.patch("/api/tasks/:id", (req: Request, res: Response) => {
    const parsed = updateTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues.map((i) => i.message).join("; "),
      });
      return;
    }

    const idParam = req.params.id;
    const taskId = Array.isArray(idParam) ? idParam[0] : idParam;
    if (!taskId) {
      res.status(400).json({ error: "Missing task id" });
      return;
    }

    const meta = req.mutationMeta ?? { originClientId: null, mutationId: null };
    const input = parsed.data;

    const result = db.transaction(() => {
      const existing = selectTaskStmt.get(taskId) as Task | undefined;
      if (!existing) {
        return null;
      }

      const nextStatus = input.status ?? existing.status;
      let nextPosition = input.position ?? existing.position;

      // If moved to a new column without an explicit position, append at the end of that column.
      if (
        input.status !== undefined &&
        input.status !== existing.status &&
        input.position === undefined
      ) {
        const row = maxPositionStmt.get(nextStatus) as { maxPos: number | null };
        nextPosition = row.maxPos === null ? POSITION_STEP : row.maxPos + POSITION_STEP;
      }

      const now = nextIsoTimestamp();
      const updatedFields: Task = {
        id: existing.id,
        title: input.title ?? existing.title,
        description: input.description ?? existing.description,
        priority: input.priority ?? existing.priority,
        assignee: input.assignee ?? existing.assignee,
        status: nextStatus,
        position: nextPosition,
        updatedAt: now,
      };

      db.prepare(
        `
        UPDATE tasks
        SET title = @title,
            description = @description,
            priority = @priority,
            assignee = @assignee,
            status = @status,
            position = @position,
            updatedAt = @updatedAt
        WHERE id = @id
      `
      ).run(updatedFields);

      const eventsToEmit: SSEEvent[] = [];
      let finalTask = updatedFields;

      if (input.position !== undefined || input.status !== undefined) {
        finalTask = maybeRebalanceColumn(nextStatus, existing.id, eventsToEmit, meta, now);
      } else {
        eventsToEmit.push({
          type: "task.updated",
          task: updatedFields,
          originClientId: meta.originClientId,
          mutationId: meta.mutationId,
          updatedAt: updatedFields.updatedAt,
        });
      }

      return { task: finalTask, events: eventsToEmit };
    })();

    if (!result) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    for (const ev of result.events) {
      sse.emit(ev);
    }

    res.json(result.task);
  });

  // Delete task
  app.delete("/api/tasks/:id", (req: Request, res: Response) => {
    const idParam = req.params.id;
    const taskId = Array.isArray(idParam) ? idParam[0] : idParam;
    if (!taskId) {
      res.status(400).json({ error: "Missing task id" });
      return;
    }

    const existing = selectTaskStmt.get(taskId) as Task | undefined;
    if (!existing) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    deleteTaskStmt.run(taskId);
    const meta = req.mutationMeta ?? { originClientId: null, mutationId: null };
    const updatedAt = nextIsoTimestamp();

    sse.emit({
      type: "task.deleted",
      id: taskId,
      originClientId: meta.originClientId,
      mutationId: meta.mutationId,
      updatedAt,
    });

    res.status(204).send();
  });

  // Serve built client statically in production (or when configured)
  const staticDir = config.staticDir;
  if (staticDir && fs.existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get("*", (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith("/api") || req.path === "/health") {
        next();
        return;
      }
      res.sendFile(path.join(staticDir, "index.html"));
    });
  }

  // Fallback JSON error handler for malformed JSON bodies, etc.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SyntaxError && "status" in err) {
      res.status(400).json({ error: "Invalid JSON payload" });
      return;
    }
    const message = err instanceof Error ? err.message : "Internal server error";
    res.status(500).json({ error: message });
  });

  return app;
}
