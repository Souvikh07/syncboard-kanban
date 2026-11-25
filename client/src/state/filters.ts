import { PRIORITIES, type Priority, type Task } from "@kanban/shared";

export type PriorityFilter = Priority | "all";

export interface BoardFilters {
  q: string;
  priority: PriorityFilter;
  assignee: string; // "all" or assignee name
}

export const DEFAULT_FILTERS: BoardFilters = {
  q: "",
  priority: "all",
  assignee: "all",
};

export function isFilterActive(filters: BoardFilters): boolean {
  return filters.q.trim() !== "" || filters.priority !== "all" || filters.assignee !== "all";
}

/**
 * Pure view-layer filter composition using AND semantics across title search,
 * priority, and assignee. Never mutates the input array.
 */
export function filterTasks(tasks: readonly Task[], filters: BoardFilters): Task[] {
  const query = filters.q.trim().toLowerCase();
  const priority = filters.priority;
  const assignee = filters.assignee;

  if (!query && priority === "all" && assignee === "all") {
    return [...tasks];
  }

  return tasks.filter((task) => {
    if (query && !task.title.toLowerCase().includes(query)) {
      return false;
    }
    if (priority !== "all" && task.priority !== priority) {
      return false;
    }
    if (assignee !== "all") {
      if (assignee === "__unassigned__") {
        if (task.assignee.trim() !== "") return false;
      } else if (task.assignee !== assignee) {
        return false;
      }
    }
    return true;
  });
}

export function deriveAssignees(tasks: readonly Task[]): string[] {
  const set = new Set<string>();
  for (const t of tasks) {
    const trimmed = t.assignee.trim();
    if (trimmed) {
      set.add(trimmed);
    }
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

export interface UrlBoardState {
  filters: BoardFilters;
  taskId: string | null;
}

export function parseUrlBoardState(search: string): UrlBoardState {
  const params = new URLSearchParams(search);
  const q = params.get("q") ?? "";

  const rawPriority = params.get("priority");
  const priority: PriorityFilter =
    rawPriority && (PRIORITIES as readonly string[]).includes(rawPriority)
      ? (rawPriority as Priority)
      : "all";

  const rawAssignee = params.get("assignee");
  const assignee = rawAssignee && rawAssignee.trim() ? rawAssignee.trim() : "all";

  const rawTask = params.get("task");
  const taskId = rawTask && rawTask.trim() ? rawTask.trim() : null;

  return {
    filters: { q, priority, assignee },
    taskId,
  };
}

/**
 * Serializes filters and optional task drawer id into a query string,
 * omitting default values and preserving unrelated params (like ?fail=1).
 */
export function serializeUrlBoardState(state: UrlBoardState, currentSearch = ""): string {
  const params = new URLSearchParams(currentSearch);

  const trimmedQ = state.filters.q.trim();
  if (trimmedQ) {
    params.set("q", trimmedQ);
  } else {
    params.delete("q");
  }

  if (state.filters.priority !== "all") {
    params.set("priority", state.filters.priority);
  } else {
    params.delete("priority");
  }

  if (state.filters.assignee !== "all") {
    params.set("assignee", state.filters.assignee);
  } else {
    params.delete("assignee");
  }

  if (state.taskId) {
    params.set("task", state.taskId);
  } else {
    params.delete("task");
  }

  const str = params.toString();
  return str ? `?${str}` : "";
}
