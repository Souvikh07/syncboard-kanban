import { describe, expect, it } from "vitest";
import type { Task } from "@kanban/shared";
import {
  applyOptimisticUpdate,
  applyRemoteSSEEvent,
  applyUpdateFailure,
  applyUpdateSuccess,
  reconcileBoardFromServer,
  type PendingMap,
} from "../src/state/boardMerge.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Initial title",
    description: "Initial desc",
    priority: "medium",
    assignee: "Aria",
    status: "todo",
    position: 1024,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("boardMerge optimistic updates, rollback, and SSE merge", () => {
  it("snapshots only affected fields and rolls back on failure without clobbering newer pending fields", () => {
    const t1 = makeTask();
    let tasks = [t1];
    let pending: PendingMap = new Map();

    // M1 changes status + position (drag)
    const m1 = applyOptimisticUpdate(
      tasks,
      pending,
      "t1",
      { status: "in-progress", position: 2048 },
      "mut-1"
    );
    tasks = m1.tasks;
    pending = m1.pending;
    expect(tasks[0]!.status).toBe("in-progress");
    expect(tasks[0]!.position).toBe(2048);

    // M2 immediately changes title while M1 is still in flight
    const m2 = applyOptimisticUpdate(tasks, pending, "t1", { title: "Renamed" }, "mut-2");
    tasks = m2.tasks;
    pending = m2.pending;
    expect(tasks[0]!.title).toBe("Renamed");

    // M1 fails -> rolls back status + position, preserves M2's title!
    const m1Fail = applyUpdateFailure(tasks, pending, "t1", "mut-1", m1.changedFields, {
      status: "todo",
      position: 1024,
    });
    tasks = m1Fail.tasks;
    pending = m1Fail.pending;

    expect(tasks[0]!.status).toBe("todo");
    expect(tasks[0]!.position).toBe(1024);
    expect(tasks[0]!.title).toBe("Renamed");
    expect(pending.get("t1")?.has("title")).toBe(true);
    expect(pending.get("t1")?.has("status")).toBe(false);
  });

  it("applies M1 success only for fields not owned by M2", () => {
    const t1 = makeTask();
    let tasks = [t1];
    let pending: PendingMap = new Map();

    const m1 = applyOptimisticUpdate(tasks, pending, "t1", { status: "done" }, "mut-1");
    tasks = m1.tasks;
    pending = m1.pending;

    const m2 = applyOptimisticUpdate(tasks, pending, "t1", { title: "Local Edit" }, "mut-2");
    tasks = m2.tasks;
    pending = m2.pending;

    const serverAfterM1 = makeTask({
      status: "done",
      title: "Initial title",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });

    const res = applyUpdateSuccess(tasks, pending, serverAfterM1, "mut-1", m1.changedFields);
    expect(res.tasks[0]!.status).toBe("done");
    expect(res.tasks[0]!.title).toBe("Local Edit");
    expect(res.pending.get("t1")?.get("title")?.mutationId).toBe("mut-2");
  });

  it("propagates pre-failure baseline when an earlier mutation on the same field fails while superseded", () => {
    const t1 = makeTask({ title: "V0" });
    let tasks = [t1];
    let pending: PendingMap = new Map();

    const m1 = applyOptimisticUpdate(tasks, pending, "t1", { title: "V1" }, "mut-1");
    tasks = m1.tasks;
    pending = m1.pending;

    const m2 = applyOptimisticUpdate(tasks, pending, "t1", { title: "V2" }, "mut-2");
    tasks = m2.tasks;
    pending = m2.pending;

    // M1 fails first -> M2 still owns title, but M2's rollback baseline becomes V0
    const m1Fail = applyUpdateFailure(tasks, pending, "t1", "mut-1", m1.changedFields, {
      title: "V0",
    });
    tasks = m1Fail.tasks;
    pending = m1Fail.pending;
    expect(tasks[0]!.title).toBe("V2");
    expect(pending.get("t1")?.get("title")?.previousValue).toBe("V0");

    // Now M2 also fails -> rolls back cleanly to V0 (not V1!)
    const m2Fail = applyUpdateFailure(tasks, pending, "t1", "mut-2", m2.changedFields, {
      title: "V1",
    });
    expect(m2Fail.tasks[0]!.title).toBe("V0");
  });

  it("merges remote SSE events field-by-field and updates rollback baseline without clobbering pending fields", () => {
    const t1 = makeTask({ title: "Original", priority: "low" });
    const m1 = applyOptimisticUpdate([t1], new Map(), "t1", { title: "My Local Title" }, "mut-1");

    const sseRes = applyRemoteSSEEvent(
      m1.tasks,
      m1.pending,
      {
        type: "task.updated",
        task: makeTask({
          title: "Remote Title",
          priority: "high",
          updatedAt: "2026-01-01T00:00:05.000Z",
        }),
        originClientId: "other-tab",
        mutationId: "remote-mut",
        updatedAt: "2026-01-01T00:00:05.000Z",
      },
      new Set(["mut-1"])
    );

    expect(sseRes.ignored).toBe(false);
    // Remote non-pending field applied:
    expect(sseRes.tasks[0]!.priority).toBe("high");
    // Pending local field preserved:
    expect(sseRes.tasks[0]!.title).toBe("My Local Title");
    // Rollback baseline updated to incoming remote value so later failure doesn't resurrect "Original":
    expect(sseRes.pending.get("t1")?.get("title")?.previousValue).toBe("Remote Title");
  });

  it("drops stale SSE events based on updatedAt and ignores own mutation echoes", () => {
    const t1 = makeTask({ updatedAt: "2026-01-01T00:00:10.000Z", title: "Current" });

    const stale = applyRemoteSSEEvent(
      [t1],
      new Map(),
      {
        type: "task.updated",
        task: makeTask({ updatedAt: "2026-01-01T00:00:05.000Z", title: "Stale" }),
        originClientId: "other-tab",
        mutationId: "m-old",
        updatedAt: "2026-01-01T00:00:05.000Z",
      },
      new Set()
    );
    expect(stale.ignored).toBe(true);
    expect(stale.tasks[0]!.title).toBe("Current");

    const echo = applyRemoteSSEEvent(
      [t1],
      new Map(),
      {
        type: "task.updated",
        task: makeTask({ updatedAt: "2026-01-01T00:00:12.000Z", title: "Echo" }),
        originClientId: "me",
        mutationId: "my-mut",
        updatedAt: "2026-01-01T00:00:12.000Z",
      },
      new Set(["my-mut"])
    );
    expect(echo.ignored).toBe(true);
  });

  it("reconciles server snapshot on reconnect while preserving pending fields and temp tasks", () => {
    const localT1 = makeTask({ id: "t1", title: "Pending Title", priority: "low" });
    const tempTask = makeTask({ id: "temp-1", title: "Saving Task" });
    const m1 = applyOptimisticUpdate(
      [localT1],
      new Map(),
      "t1",
      { title: "Pending Title" },
      "mut-1"
    );

    const serverT1 = makeTask({
      id: "t1",
      title: "Server Title",
      priority: "high",
      updatedAt: "2026-01-01T00:00:20.000Z",
    });
    const serverT2 = makeTask({ id: "t2", title: "Added While Offline" });

    const res = reconcileBoardFromServer(
      [...m1.tasks, tempTask],
      [serverT1, serverT2],
      m1.pending,
      new Set(["temp-1"]),
      new Set()
    );

    const t1Merged = res.tasks.find((t) => t.id === "t1");
    expect(t1Merged?.title).toBe("Pending Title");
    expect(t1Merged?.priority).toBe("high");
    expect(res.pending.get("t1")?.get("title")?.previousValue).toBe("Server Title");
    expect(res.tasks.some((t) => t.id === "t2")).toBe(true);
    expect(res.tasks.some((t) => t.id === "temp-1")).toBe(true);
  });

  it("dedupes task.created and discards pending mutations on task.deleted", () => {
    const t1 = makeTask({ id: "t1", title: "Existing" });
    const m1 = applyOptimisticUpdate([t1], new Map(), "t1", { title: "Local" }, "mut-1");

    const dupCreate = applyRemoteSSEEvent(
      m1.tasks,
      m1.pending,
      {
        type: "task.created",
        task: makeTask({ id: "t1", title: "Existing", updatedAt: "2026-01-01T00:00:00.000Z" }),
        originClientId: "other",
        mutationId: "m-create",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      new Set()
    );
    expect(dupCreate.ignored).toBe(true);
    expect(dupCreate.tasks).toHaveLength(1);

    const delRes = applyRemoteSSEEvent(
      m1.tasks,
      m1.pending,
      {
        type: "task.deleted",
        id: "t1",
        originClientId: "other",
        mutationId: "m-del",
        updatedAt: "2026-01-01T00:00:05.000Z",
      },
      new Set()
    );
    expect(delRes.deletedActiveTask).toBe(true);
    expect(delRes.tasks).toHaveLength(0);
    expect(delRes.pending.has("t1")).toBe(false);
  });
});
