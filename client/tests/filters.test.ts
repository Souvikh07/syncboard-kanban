import { describe, expect, it } from "vitest";
import type { Task } from "@kanban/shared";
import {
  DEFAULT_FILTERS,
  deriveAssignees,
  filterTasks,
  parseUrlBoardState,
  serializeUrlBoardState,
} from "../src/state/filters.js";

const SAMPLE_TASKS: Task[] = [
  {
    id: "1",
    title: "Fix SSE reconnect",
    description: "",
    priority: "high",
    assignee: "Aria",
    status: "todo",
    position: 1024,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "2",
    title: "Polish dark mode tokens",
    description: "",
    priority: "low",
    assignee: "Liam",
    status: "backlog",
    position: 1024,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "3",
    title: "Fix drag overlay focus",
    description: "",
    priority: "high",
    assignee: "",
    status: "in-progress",
    position: 1024,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

describe("filter composition and URL parse/serialize", () => {
  it("combines title search (case-insensitive), priority, and assignee with AND", () => {
    const byQuery = filterTasks(SAMPLE_TASKS, {
      q: "FIX",
      priority: "all",
      assignee: "all",
    });
    expect(byQuery.map((t) => t.id)).toEqual(["1", "3"]);

    const byAllThree = filterTasks(SAMPLE_TASKS, {
      q: "fix",
      priority: "high",
      assignee: "Aria",
    });
    expect(byAllThree.map((t) => t.id)).toEqual(["1"]);

    const unassigned = filterTasks(SAMPLE_TASKS, {
      q: "",
      priority: "all",
      assignee: "__unassigned__",
    });
    expect(unassigned.map((t) => t.id)).toEqual(["3"]);
  });

  it("derives sorted unique assignees ignoring empty strings", () => {
    expect(deriveAssignees(SAMPLE_TASKS)).toEqual(["Aria", "Liam"]);
  });

  it("parses query params and ignores invalid priority values", () => {
    expect(parseUrlBoardState("?q=sse&priority=high&assignee=Aria&task=t-1")).toEqual({
      filters: { q: "sse", priority: "high", assignee: "Aria" },
      taskId: "t-1",
    });

    expect(parseUrlBoardState("?priority=bogus")).toEqual({
      filters: DEFAULT_FILTERS,
      taskId: null,
    });
  });

  it("serializes URL state omitting defaults and preserving ?fail=1", () => {
    expect(
      serializeUrlBoardState({ filters: DEFAULT_FILTERS, taskId: null }, "?q=old&priority=low")
    ).toBe("");

    expect(
      serializeUrlBoardState(
        { filters: { q: "sse", priority: "high", assignee: "all" }, taskId: "t-9" },
        "?fail=1"
      )
    ).toBe("?fail=1&q=sse&priority=high&task=t-9");
  });
});
