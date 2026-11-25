import cors from "cors";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import type { Collection } from "mongodb";
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
import { docToTask, nextIsoTimestamp, type TaskDoc } from "./db.js";
import { createFailureInjectionMiddleware, extractMutationMeta } from "./middleware.js";
import type { SSEBroker } from "./sse.js";
import { createTaskSchema, updateTaskSchema } from "./validation.js";

export interface AppConfig {
  tasks: Collection<TaskDoc>;
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

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}

export function createApp(config: AppConfig): Express {
  const app = express();
  const { tasks, sse } = config;
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
  app.get(
    "/api/board",
    asyncHandler(async (_req: Request, res: Response) => {
      const docs = await tasks.find({}).sort({ status: 1, position: 1, updatedAt: 1 }).toArray();
      res.json({
        columns: COLUMNS,
        tasks: docs.map(docToTask),
      });
    })
  );

  // Apply failure injection & simulated latency to mutating /api/tasks endpoints
  app.use("/api/tasks", createFailureInjectionMiddleware({ failRate, minLatencyMs, maxLatencyMs }));

  async function getMaxColumnPosition(status: ColumnId): Promise<number | null> {
    const top = await tasks.find({ status }).sort({ position: -1 }).limit(1).next();
    return top ? top.position : null;
  }

  async function getColumnTasksSorted(status: ColumnId): Promise<Task[]> {
    const docs = await tasks
      .find({ status })
      .sort({ position: 1, updatedAt: -1, _id: 1 })
      .toArray();
    return docs.map(docToTask);
  }

  /**
   * Rebalances a column to 1024-step integers using a single bulkWrite if any
   * adjacent gap < 1e-6 or if the leading position dropped too close to zero.
   */
  async function maybeRebalanceColumn(
    status: ColumnId,
    primaryTaskId: string,
    eventsToEmit: SSEEvent[],
    meta: { originClientId: string | null; mutationId: string | null },
    baseTimestamp: string
  ): Promise<Task> {
    const colTasks = await getColumnTasksSorted(status);
    const positions = colTasks.map((t) => t.position);
    const firstPos = positions[0];
    const needs =
      columnNeedsRebalance(positions) || (firstPos !== undefined && firstPos <= MIN_POSITION_GAP);

    if (needs) {
      const updates = computeRebalancedPositions(colTasks);
      const rebalanceTs = updates.length > 0 ? nextIsoTimestamp() : baseTimestamp;

      if (updates.length > 0) {
        await tasks.bulkWrite(
          updates.map((u) => ({
            updateOne: {
              filter: { _id: u.id },
              update: { $set: { position: u.position, updatedAt: rebalanceTs } },
            },
          }))
        );
      }

      const updatedColTasks = await getColumnTasksSorted(status);
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

    const doc = await tasks.findOne({ _id: primaryTaskId });
    if (!doc) {
      throw new Error(`Task ${primaryTaskId} vanished during update`);
    }
    const primary = docToTask(doc);
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
  app.post(
    "/api/tasks",
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = createTaskSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: parsed.error.issues.map((i) => i.message).join("; "),
        });
        return;
      }

      const meta = req.mutationMeta ?? { originClientId: null, mutationId: null };
      const input = parsed.data;
      const now = nextIsoTimestamp();

      let position = input.position;
      if (position === undefined) {
        const maxPos = await getMaxColumnPosition(input.status);
        position = maxPos === null ? POSITION_STEP : maxPos + POSITION_STEP;
      }

      const newDoc: TaskDoc = {
        _id: crypto.randomUUID(),
        title: input.title,
        description: input.description,
        priority: input.priority,
        assignee: input.assignee,
        status: input.status,
        position,
        updatedAt: now,
      };
      await tasks.insertOne(newDoc);
      const newTask = docToTask(newDoc);

      const eventsToEmit: SSEEvent[] = [];
      const colTasks = await getColumnTasksSorted(newTask.status);
      const positions = colTasks.map((t) => t.position);
      const firstPos = positions[0];
      const needs =
        columnNeedsRebalance(positions) || (firstPos !== undefined && firstPos <= MIN_POSITION_GAP);

      let responseTask = newTask;

      if (needs) {
        const updates = computeRebalancedPositions(colTasks);
        const rebalanceTs = updates.length > 0 ? nextIsoTimestamp() : now;
        if (updates.length > 0) {
          await tasks.bulkWrite(
            updates.map((u) => ({
              updateOne: {
                filter: { _id: u.id },
                update: { $set: { position: u.position, updatedAt: rebalanceTs } },
              },
            }))
          );
        }
        const updatedColTasks = await getColumnTasksSorted(newTask.status);
        const createdFinal = updatedColTasks.find((t) => t.id === newTask.id) ?? newTask;
        responseTask = createdFinal;

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
      } else {
        eventsToEmit.push({
          type: "task.created",
          task: newTask,
          originClientId: meta.originClientId,
          mutationId: meta.mutationId,
          updatedAt: newTask.updatedAt,
        });
      }

      for (const ev of eventsToEmit) {
        sse.emit(ev);
      }

      res.status(201).json(responseTask);
    })
  );

  // Update task
  app.patch(
    "/api/tasks/:id",
    asyncHandler(async (req: Request, res: Response) => {
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

      const existingDoc = await tasks.findOne({ _id: taskId });
      if (!existingDoc) {
        res.status(404).json({ error: "Task not found" });
        return;
      }

      const meta = req.mutationMeta ?? { originClientId: null, mutationId: null };
      const input = parsed.data;
      const nextStatus = input.status ?? existingDoc.status;
      let nextPosition = input.position ?? existingDoc.position;

      // If moved to a new column without an explicit position, append at the end of that column.
      if (
        input.status !== undefined &&
        input.status !== existingDoc.status &&
        input.position === undefined
      ) {
        const maxPos = await getMaxColumnPosition(nextStatus);
        nextPosition = maxPos === null ? POSITION_STEP : maxPos + POSITION_STEP;
      }

      const now = nextIsoTimestamp();
      const updatedFields = {
        title: input.title ?? existingDoc.title,
        description: input.description ?? existingDoc.description,
        priority: input.priority ?? existingDoc.priority,
        assignee: input.assignee ?? existingDoc.assignee,
        status: nextStatus,
        position: nextPosition,
        updatedAt: now,
      };

      await tasks.updateOne({ _id: taskId }, { $set: updatedFields });

      const eventsToEmit: SSEEvent[] = [];
      let finalTask: Task = {
        id: existingDoc._id,
        ...updatedFields,
      };

      if (input.position !== undefined || input.status !== undefined) {
        finalTask = await maybeRebalanceColumn(
          nextStatus,
          existingDoc._id,
          eventsToEmit,
          meta,
          now
        );
      } else {
        eventsToEmit.push({
          type: "task.updated",
          task: finalTask,
          originClientId: meta.originClientId,
          mutationId: meta.mutationId,
          updatedAt: finalTask.updatedAt,
        });
      }

      for (const ev of eventsToEmit) {
        sse.emit(ev);
      }

      res.json(finalTask);
    })
  );

  // Delete task
  app.delete(
    "/api/tasks/:id",
    asyncHandler(async (req: Request, res: Response) => {
      const idParam = req.params.id;
      const taskId = Array.isArray(idParam) ? idParam[0] : idParam;
      if (!taskId) {
        res.status(400).json({ error: "Missing task id" });
        return;
      }

      const deleteResult = await tasks.deleteOne({ _id: taskId });
      if (deleteResult.deletedCount === 0) {
        res.status(404).json({ error: "Task not found" });
        return;
      }

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
    })
  );

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

  // Fallback JSON error handler for malformed JSON bodies or async errors
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
