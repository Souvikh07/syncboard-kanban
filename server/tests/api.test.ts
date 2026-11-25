import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { BoardResponse, SSEEvent, Task } from "@kanban/shared";
import { createApp } from "../src/app.js";
import { initDatabase } from "../src/db.js";
import { SSEBroker } from "../src/sse.js";

interface ParsedSSEMessage {
  id: string | null;
  event: string | null;
  data: SSEEvent;
}

function connectSSE(
  url: string,
  headers: Record<string, string> = {}
): {
  messages: ParsedSSEMessage[];
  waitForCount: (count: number, timeoutMs?: number) => Promise<void>;
  close: () => void;
} {
  const messages: ParsedSSEMessage[] = [];
  const waiters: Array<() => void> = [];
  let buffer = "";

  const req = http.get(url, { headers }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const rawBlock = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        idx = buffer.indexOf("\n\n");

        const lines = rawBlock.split("\n");
        let id: string | null = null;
        let event: string | null = null;
        let dataStr = "";
        for (const line of lines) {
          if (line.startsWith(":")) {
            continue;
          }
          if (line.startsWith("id:")) {
            id = line.slice(3).trim();
          } else if (line.startsWith("event:")) {
            event = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataStr += line.slice(5).trim();
          }
        }
        if (dataStr) {
          messages.push({
            id,
            event,
            data: JSON.parse(dataStr) as SSEEvent,
          });
          for (const w of waiters) {
            w();
          }
        }
      }
    });
  });

  return {
    messages,
    waitForCount: (count: number, timeoutMs = 2000) =>
      new Promise((resolve, reject) => {
        if (messages.length >= count) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${count} SSE messages (got ${messages.length})`));
        }, timeoutMs);
        const check = () => {
          if (messages.length >= count) {
            clearTimeout(timer);
            resolve();
          }
        };
        waiters.push(check);
      }),
    close: () => {
      req.destroy();
    },
  };
}

describe("Kanban Server API & SSE", () => {
  let db: Database.Database;
  let sse: SSEBroker;

  beforeEach(() => {
    db = initDatabase(":memory:", { seed: true });
    sse = new SSEBroker({ heartbeatMs: 0 });
  });

  afterEach(() => {
    sse.close();
    db.close();
  });

  it("returns /health and seeded /api/board with 20 tasks across 4 columns", async () => {
    const app = createApp({ db, sse, failRate: 0, minLatencyMs: 0, maxLatencyMs: 0 });

    const healthRes = await request(app).get("/health");
    expect(healthRes.status).toBe(200);
    expect(healthRes.body.status).toBe("ok");

    const boardRes = await request(app).get("/api/board");
    expect(boardRes.status).toBe(200);
    const board = boardRes.body as BoardResponse;
    expect(board.columns.map((c) => c.id)).toEqual(["backlog", "todo", "in-progress", "done"]);
    expect(board.tasks.length).toBe(20);
  });

  it("validates POST and PATCH payloads with zod and returns 400/404", async () => {
    const app = createApp({ db, sse, failRate: 0, minLatencyMs: 0, maxLatencyMs: 0 });

    const badCreate = await request(app).post("/api/tasks").send({ title: "" });
    expect(badCreate.status).toBe(400);
    expect(typeof badCreate.body.error).toBe("string");

    const unknownField = await request(app)
      .post("/api/tasks")
      .send({ title: "Valid", unknownProp: true });
    expect(unknownField.status).toBe(400);

    const badPatch = await request(app).patch("/api/tasks/nonexistent").send({});
    expect(badPatch.status).toBe(400);

    const missingPatch = await request(app)
      .patch("/api/tasks/missing-id")
      .send({ title: "Updated" });
    expect(missingPatch.status).toBe(404);

    const missingDelete = await request(app).delete("/api/tasks/missing-id");
    expect(missingDelete.status).toBe(404);
  });

  it("supports full CRUD and failure injection (?fail=1 and failRate=1)", async () => {
    const app = createApp({ db, sse, failRate: 0, minLatencyMs: 0, maxLatencyMs: 0 });

    const createdRes = await request(app)
      .post("/api/tasks")
      .set("X-Client-Id", "tab-1")
      .set("X-Mutation-Id", "mut-1")
      .send({ title: "New Task", priority: "high", assignee: "Aria", status: "todo" });
    expect(createdRes.status).toBe(201);
    const created = createdRes.body as Task;
    expect(created.id).toBeTruthy();
    expect(created.updatedAt).toBeTruthy();
    expect(created.position).toBe(7 * 1024);

    const patchedRes = await request(app)
      .patch(`/api/tasks/${created.id}`)
      .send({ title: "Edited Task", status: "done" });
    expect(patchedRes.status).toBe(200);
    const patched = patchedRes.body as Task;
    expect(patched.title).toBe("Edited Task");
    expect(patched.status).toBe("done");
    expect(patched.position).toBe(5 * 1024);

    const forcedFail = await request(app)
      .patch(`/api/tasks/${created.id}?fail=1`)
      .send({ title: "Should Fail" });
    expect(forcedFail.status).toBe(500);

    const delRes = await request(app).delete(`/api/tasks/${created.id}`);
    expect(delRes.status).toBe(204);

    const failingApp = createApp({ db, sse, failRate: 1, minLatencyMs: 0, maxLatencyMs: 0 });
    const rateFail = await request(failingApp).post("/api/tasks").send({ title: "Blocked" });
    expect(rateFail.status).toBe(500);
  });

  it("rebalances a column in one transaction and emits task.updated for every changed task", async () => {
    const cleanDb = initDatabase(":memory:", { seed: false });
    const app = createApp({ db: cleanDb, sse, failRate: 0, minLatencyMs: 0, maxLatencyMs: 0 });

    const t1 = (await request(app).post("/api/tasks").send({ title: "T1", status: "todo" }))
      .body as Task;
    const t2 = (await request(app).post("/api/tasks").send({ title: "T2", status: "todo" }))
      .body as Task;
    expect(t2.position).toBe(2048);
    const t3 = (await request(app).post("/api/tasks").send({ title: "T3", status: "todo" }))
      .body as Task;

    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const stream = connectSSE(`http://127.0.0.1:${port}/api/events`);

    // Wait briefly for SSE connection
    await new Promise((r) => setTimeout(r, 50));

    // Move t3 right next to t1 within < 1e-6 gap
    const patchRes = await request(app)
      .patch(`/api/tasks/${t3.id}`)
      .set("X-Client-Id", "tab-A")
      .set("X-Mutation-Id", "mut-rebalance")
      .send({ position: t1.position + 1e-7 });

    expect(patchRes.status).toBe(200);
    // t1=1024, t3=2048, t2=3072 -> t3 and t2 both changed positions!
    await stream.waitForCount(2);

    const board = (await request(app).get("/api/board")).body as BoardResponse;
    const positions = board.tasks.map((t) => ({ title: t.title, position: t.position }));
    expect(positions).toEqual([
      { title: "T1", position: 1024 },
      { title: "T3", position: 2048 },
      { title: "T2", position: 3072 },
    ]);

    const updatedTitles = stream.messages.map((m) =>
      m.data.type === "task.updated" ? m.data.task.title : ""
    );
    expect(updatedTitles).toContain("T3");
    expect(updatedTitles).toContain("T2");

    stream.close();
    server.close();
    cleanDb.close();
  });

  it("emits SSE events with originClientId, mutationId, id:, and supports Last-Event-ID replay", async () => {
    const app = createApp({ db, sse, failRate: 0, minLatencyMs: 0, maxLatencyMs: 0 });
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;

    const stream1 = connectSSE(`http://127.0.0.1:${port}/api/events`);
    await new Promise((r) => setTimeout(r, 50));

    const createRes = await request(app)
      .post("/api/tasks")
      .set("X-Client-Id", "client-xyz")
      .set("X-Mutation-Id", "mut-100")
      .send({ title: "SSE Task" });
    const created = createRes.body as Task;

    await stream1.waitForCount(1);
    const firstMsg = stream1.messages[0]!;
    expect(firstMsg.id).toBe("1");
    expect(firstMsg.event).toBe("task.created");
    expect(firstMsg.data.originClientId).toBe("client-xyz");
    expect(firstMsg.data.mutationId).toBe("mut-100");
    stream1.close();

    // Perform another mutation while disconnected
    await request(app)
      .patch(`/api/tasks/${created.id}`)
      .set("X-Client-Id", "client-abc")
      .set("X-Mutation-Id", "mut-101")
      .send({ title: "SSE Task Updated" });

    // Reconnect with Last-Event-ID: 1 -> should replay event 2
    const stream2 = connectSSE(`http://127.0.0.1:${port}/api/events`, {
      "Last-Event-ID": "1",
    });
    await stream2.waitForCount(1);
    const replayed = stream2.messages[0]!;
    expect(replayed.id).toBe("2");
    expect(replayed.data.type).toBe("task.updated");
    if (replayed.data.type === "task.updated") {
      expect(replayed.data.task.title).toBe("SSE Task Updated");
    }

    stream2.close();
    server.close();
  });
});
