import type { EditableTaskField, SSEEvent, Task, UpdateTaskInput } from "@kanban/shared";

export interface PendingFieldEntry<K extends EditableTaskField = EditableTaskField> {
  mutationId: string;
  previousValue: Task[K];
}

export type TaskPendingFields = Map<EditableTaskField, PendingFieldEntry>;
export type PendingMap = Map<string, TaskPendingFields>;

const EDITABLE_FIELDS: readonly EditableTaskField[] = [
  "title",
  "description",
  "priority",
  "assignee",
  "status",
  "position",
];

export function clonePendingMap(pending: PendingMap): PendingMap {
  const next: PendingMap = new Map();
  for (const [taskId, fields] of pending.entries()) {
    next.set(taskId, new Map(fields));
  }
  return next;
}

/**
 * Snapshots only the affected fields of the affected task and applies the
 * optimistic patch locally at once.
 */
export function applyOptimisticUpdate(
  tasks: readonly Task[],
  pending: PendingMap,
  taskId: string,
  patch: UpdateTaskInput,
  mutationId: string
): { tasks: Task[]; pending: PendingMap; changedFields: EditableTaskField[] } {
  const targetIndex = tasks.findIndex((t) => t.id === taskId);
  if (targetIndex === -1) {
    return { tasks: [...tasks], pending, changedFields: [] };
  }

  const currentTask = tasks[targetIndex];
  if (!currentTask) {
    return { tasks: [...tasks], pending, changedFields: [] };
  }
  const nextPending = clonePendingMap(pending);
  let taskPending = nextPending.get(taskId);
  if (!taskPending) {
    taskPending = new Map();
    nextPending.set(taskId, taskPending);
  }

  const changedFields: EditableTaskField[] = [];
  const nextTask: Task = { ...currentTask };

  for (const field of EDITABLE_FIELDS) {
    const incomingVal = patch[field];
    if (incomingVal !== undefined) {
      changedFields.push(field);
      taskPending.set(field, {
        mutationId,
        previousValue: currentTask[field],
      });
      (nextTask as Record<EditableTaskField, Task[EditableTaskField]>)[field] = incomingVal;
    }
  }

  const nextTasks = [...tasks];
  nextTasks[targetIndex] = nextTask;

  return { tasks: nextTasks, pending: nextPending, changedFields };
}

/**
 * On mutation success: replaces the task with the server response ONLY for
 * fields not covered by a newer pending mutation; clears matching pending entries.
 */
export function applyUpdateSuccess(
  tasks: readonly Task[],
  pending: PendingMap,
  serverTask: Task,
  mutationId: string,
  changedFields: readonly EditableTaskField[]
): { tasks: Task[]; pending: PendingMap } {
  const nextPending = clonePendingMap(pending);
  const taskPending = nextPending.get(serverTask.id);

  const idx = tasks.findIndex((t) => t.id === serverTask.id);
  if (idx === -1) {
    // Task was deleted locally while request was in flight
    if (taskPending) {
      for (const field of changedFields) {
        if (taskPending.get(field)?.mutationId === mutationId) {
          taskPending.delete(field);
        }
      }
      if (taskPending.size === 0) {
        nextPending.delete(serverTask.id);
      }
    }
    return { tasks: [...tasks], pending: nextPending };
  }

  const localTask = tasks[idx];
  if (!localTask) {
    return { tasks: [...tasks], pending: nextPending };
  }
  const mergedTask: Task = { ...serverTask };

  if (taskPending) {
    for (const field of EDITABLE_FIELDS) {
      const entry = taskPending.get(field);
      if (!entry) {
        continue;
      }
      if (entry.mutationId === mutationId) {
        if (changedFields.includes(field)) {
          taskPending.delete(field);
        }
      } else {
        // Newer pending mutation owns this field: keep local value,
        // and update its rollback baseline if this earlier mutation just committed a value.
        (mergedTask as Record<EditableTaskField, Task[EditableTaskField]>)[field] =
          localTask[field];
      }
    }
    if (taskPending.size === 0) {
      nextPending.delete(serverTask.id);
    }
  }

  const nextTasks = [...tasks];
  nextTasks[idx] = mergedTask;
  return { tasks: nextTasks, pending: nextPending };
}

/**
 * On mutation failure: rolls back ONLY the fields this mutation changed,
 * and ONLY if no newer pending mutation owns that field.
 * If a newer pending mutation owns the field, propagates our rollback baseline
 * so a subsequent failure does not resurrect failed optimistic state.
 */
export function applyUpdateFailure(
  tasks: readonly Task[],
  pending: PendingMap,
  taskId: string,
  mutationId: string,
  changedFields: readonly EditableTaskField[],
  snapshots: Partial<Record<EditableTaskField, Task[EditableTaskField]>>
): { tasks: Task[]; pending: PendingMap } {
  const nextPending = clonePendingMap(pending);
  const taskPending = nextPending.get(taskId);
  const idx = tasks.findIndex((t) => t.id === taskId);

  if (idx === -1) {
    if (taskPending) {
      for (const field of changedFields) {
        if (taskPending.get(field)?.mutationId === mutationId) {
          taskPending.delete(field);
        }
      }
      if (taskPending.size === 0) {
        nextPending.delete(taskId);
      }
    }
    return { tasks: [...tasks], pending: nextPending };
  }

  const currentTask = tasks[idx];
  if (!currentTask) {
    return { tasks: [...tasks], pending: nextPending };
  }
  const rolledBack: Task = { ...currentTask };

  if (taskPending) {
    for (const field of changedFields) {
      const entry = taskPending.get(field);
      if (!entry) {
        continue;
      }
      if (entry.mutationId === mutationId) {
        (rolledBack as Record<EditableTaskField, Task[EditableTaskField]>)[field] =
          entry.previousValue;
        taskPending.delete(field);
      } else {
        const snapshotVal = snapshots[field];
        if (snapshotVal !== undefined) {
          // Propagate the earlier pre-failure baseline to the newer mutation
          taskPending.set(field, {
            mutationId: entry.mutationId,
            previousValue: snapshotVal,
          });
        }
      }
    }
    if (taskPending.size === 0) {
      nextPending.delete(taskId);
    }
  }

  const nextTasks = [...tasks];
  nextTasks[idx] = rolledBack;
  return { tasks: nextTasks, pending: nextPending };
}

export function applyOptimisticCreate(tasks: readonly Task[], tempTask: Task): Task[] {
  return [...tasks, tempTask];
}

export function applyCreateSuccess(
  tasks: readonly Task[],
  tempId: string,
  serverTask: Task
): Task[] {
  const withoutDuplicate = tasks.filter((t) => t.id !== serverTask.id);
  const idx = withoutDuplicate.findIndex((t) => t.id === tempId);
  if (idx === -1) {
    return [...withoutDuplicate, serverTask];
  }
  const next = [...withoutDuplicate];
  next[idx] = serverTask;
  return next;
}

export function applyCreateFailure(tasks: readonly Task[], tempId: string): Task[] {
  return tasks.filter((t) => t.id !== tempId);
}

export function applyOptimisticDelete(tasks: readonly Task[], taskId: string): Task[] {
  return tasks.filter((t) => t.id !== taskId);
}

export function applyDeleteFailure(
  tasks: readonly Task[],
  snapshot: Task,
  originalIndex: number
): Task[] {
  if (tasks.some((t) => t.id === snapshot.id)) {
    return [...tasks];
  }
  const next = [...tasks];
  const insertAt = Math.min(Math.max(0, originalIndex), next.length);
  next.splice(insertAt, 0, snapshot);
  return next;
}

export interface SSEApplyResult {
  tasks: Task[];
  pending: PendingMap;
  ignored: boolean;
  deletedActiveTask: boolean;
}

/**
 * Applies a single remote SSE event onto the board state using field-level merge,
 * updatedAt staleness filtering, and pending rollback-baseline updates.
 */
export function applyRemoteSSEEvent(
  tasks: readonly Task[],
  pending: PendingMap,
  event: SSEEvent,
  knownOwnMutationIds: ReadonlySet<string>
): SSEApplyResult {
  if (event.mutationId && knownOwnMutationIds.has(event.mutationId)) {
    return { tasks: [...tasks], pending, ignored: true, deletedActiveTask: false };
  }

  if (event.type === "task.created") {
    const incoming = event.task;
    const existing = tasks.find((t) => t.id === incoming.id);
    if (existing) {
      // Dedupe; only update if newer
      if (incoming.updatedAt <= existing.updatedAt) {
        return { tasks: [...tasks], pending, ignored: true, deletedActiveTask: false };
      }
      return mergeRemoteTask(tasks, pending, incoming);
    }
    return {
      tasks: [...tasks, incoming],
      pending,
      ignored: false,
      deletedActiveTask: false,
    };
  }

  if (event.type === "task.updated") {
    const incoming = event.task;
    const existing = tasks.find((t) => t.id === incoming.id);
    if (!existing) {
      return {
        tasks: [...tasks, incoming],
        pending,
        ignored: false,
        deletedActiveTask: false,
      };
    }
    if (incoming.updatedAt < existing.updatedAt) {
      return { tasks: [...tasks], pending, ignored: true, deletedActiveTask: false };
    }
    return mergeRemoteTask(tasks, pending, incoming);
  }

  // task.deleted
  const exists = tasks.some((t) => t.id === event.id);
  const nextPending = clonePendingMap(pending);
  const hadPending = nextPending.delete(event.id);
  return {
    tasks: exists ? tasks.filter((t) => t.id !== event.id) : [...tasks],
    pending: nextPending,
    ignored: !exists && !hadPending,
    deletedActiveTask: true,
  };
}

function mergeRemoteTask(
  tasks: readonly Task[],
  pending: PendingMap,
  incoming: Task
): SSEApplyResult {
  const nextPending = clonePendingMap(pending);
  const taskPending = nextPending.get(incoming.id);
  const idx = tasks.findIndex((t) => t.id === incoming.id);

  if (idx === -1) {
    return {
      tasks: [...tasks, incoming],
      pending: nextPending,
      ignored: false,
      deletedActiveTask: false,
    };
  }

  const localTask = tasks[idx];
  if (!localTask) {
    return {
      tasks: [...tasks],
      pending: nextPending,
      ignored: false,
      deletedActiveTask: false,
    };
  }
  const merged: Task = { ...incoming };

  if (taskPending) {
    for (const field of EDITABLE_FIELDS) {
      const entry = taskPending.get(field);
      if (entry) {
        // Keep local optimistic value, update rollback baseline to incoming server value
        (merged as Record<EditableTaskField, Task[EditableTaskField]>)[field] = localTask[field];
        taskPending.set(field, {
          mutationId: entry.mutationId,
          previousValue: incoming[field],
        });
      }
    }
  }

  const nextTasks = [...tasks];
  nextTasks[idx] = merged;
  return {
    tasks: nextTasks,
    pending: nextPending,
    ignored: false,
    deletedActiveTask: false,
  };
}

/**
 * Reconciles a full server snapshot (e.g. on SSE reconnect) against local tasks
 * and pending mutations: pending fields win and their rollback baselines update
 * to the fresh server values; optimistic temp tasks are preserved.
 */
export function reconcileBoardFromServer(
  localTasks: readonly Task[],
  serverTasks: readonly Task[],
  pending: PendingMap,
  savingTempIds: ReadonlySet<string>,
  pendingDeleteIds: ReadonlySet<string>
): { tasks: Task[]; pending: PendingMap } {
  const nextPending = clonePendingMap(pending);
  const localById = new Map(localTasks.map((t) => [t.id, t]));
  const serverIds = new Set(serverTasks.map((t) => t.id));
  const mergedTasks: Task[] = [];

  for (const serverTask of serverTasks) {
    if (pendingDeleteIds.has(serverTask.id)) {
      continue;
    }

    const localTask = localById.get(serverTask.id);
    const taskPending = nextPending.get(serverTask.id);

    if (localTask && taskPending && taskPending.size > 0) {
      const merged: Task = { ...serverTask };
      for (const field of EDITABLE_FIELDS) {
        const entry = taskPending.get(field);
        if (entry) {
          (merged as Record<EditableTaskField, Task[EditableTaskField]>)[field] = localTask[field];
          taskPending.set(field, {
            mutationId: entry.mutationId,
            previousValue: serverTask[field],
          });
        }
      }
      mergedTasks.push(merged);
    } else {
      mergedTasks.push(serverTask);
    }
  }

  // Keep any in-flight optimistic temp creations
  for (const tempId of savingTempIds) {
    const tempTask = localById.get(tempId);
    if (tempTask) {
      mergedTasks.push(tempTask);
    }
  }

  // Discard pending entries for tasks that no longer exist on the server
  for (const taskId of nextPending.keys()) {
    if (!serverIds.has(taskId) && !savingTempIds.has(taskId)) {
      nextPending.delete(taskId);
    }
  }

  return { tasks: mergedTasks, pending: nextPending };
}
