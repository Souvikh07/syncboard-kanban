import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  POSITION_STEP,
  type BoardResponse,
  type ColumnId,
  type CreateTaskInput,
  type EditableTaskField,
  type SSEEvent,
  type Task,
  type UpdateTaskInput,
} from "@kanban/shared";
import {
  createTaskRequest,
  deleteTaskRequest,
  fetchBoard,
  updateTaskRequest,
} from "../api/client.js";
import {
  applyCreateFailure,
  applyCreateSuccess,
  applyDeleteFailure,
  applyOptimisticCreate,
  applyOptimisticDelete,
  applyOptimisticUpdate,
  applyRemoteSSEEvent,
  applyUpdateFailure,
  applyUpdateSuccess,
  reconcileBoardFromServer,
  type PendingMap,
} from "./boardMerge.js";

export interface ToastMessage {
  id: string;
  kind: "error" | "info";
  message: string;
  retry?: () => void;
}

export type ConnectionStatus = "live" | "reconnecting";

interface BoardContextValue {
  board: BoardResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetchBoard: () => void;
  savingTaskIds: ReadonlySet<string>;
  pendingTaskIds: ReadonlySet<string>;
  toasts: readonly ToastMessage[];
  dismissToast: (id: string) => void;
  pushToast: (toast: Omit<ToastMessage, "id">) => void;
  connectionStatus: ConnectionStatus;
  setConnectionStatus: (status: ConnectionStatus) => void;
  forceFailNext: boolean;
  setForceFailNext: (val: boolean) => void;
  createTask: (input: CreateTaskInput) => void;
  updateTask: (taskId: string, patch: UpdateTaskInput) => void;
  deleteTask: (taskId: string) => void;
  handleSSEEvent: (
    event: SSEEvent,
    callbacks: {
      activeDragTaskId: string | null;
      activeDragColumns: ReadonlySet<ColumnId>;
      activeDrawerTaskId: string | null;
      onCancelDrag: () => void;
      onCloseDrawerForDeleted: () => void;
    }
  ) => void;
  flushBufferedEventsForDrop: (callbacks: {
    activeDrawerTaskId: string | null;
    onCloseDrawerForDeleted: () => void;
  }) => void;
  reconcileOnReconnect: () => Promise<void>;
}

const BoardContext = createContext<BoardContextValue | null>(null);

function newId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function BoardProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const queryClient = useQueryClient();

  // Bookkeeping refs/state for optimistic mutations & real-time merge
  const pendingRef = useRef<PendingMap>(new Map());
  const savingTempIdsRef = useRef<Set<string>>(new Set());
  const pendingDeleteIdsRef = useRef<Set<string>>(new Set());
  const taskQueuesRef = useRef<Map<string, Promise<void>>>(new Map());
  const inFlightMutationsRef = useRef<Set<string>>(new Set());
  const recentMutationsRef = useRef<string[]>([]);
  const bufferedEventsRef = useRef<SSEEvent[]>([]);

  const [savingTaskIds, setSavingTaskIds] = useState<ReadonlySet<string>>(new Set());
  const [pendingTaskIds, setPendingTaskIds] = useState<ReadonlySet<string>>(new Set());
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("reconnecting");
  const [forceFailNext, setForceFailNext] = useState<boolean>(false);

  const syncPendingTaskIds = useCallback(() => {
    setPendingTaskIds(new Set(pendingRef.current.keys()));
  }, []);

  const syncSavingTaskIds = useCallback(() => {
    setSavingTaskIds(new Set(savingTempIdsRef.current));
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback((toast: Omit<ToastMessage, "id">) => {
    const id = newId();
    setToasts((prev) => [...prev.slice(-4), { ...toast, id }]);
    if (!toast.retry) {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 5000);
    }
  }, []);

  const trackOwnMutation = useCallback((mutationId: string) => {
    inFlightMutationsRef.current.add(mutationId);
  }, []);

  const completeOwnMutation = useCallback((mutationId: string) => {
    inFlightMutationsRef.current.delete(mutationId);
    recentMutationsRef.current.push(mutationId);
    if (recentMutationsRef.current.length > 200) {
      recentMutationsRef.current.shift();
    }
  }, []);

  const getKnownOwnMutationIds = useCallback((): Set<string> => {
    const combined = new Set<string>(inFlightMutationsRef.current);
    for (const id of recentMutationsRef.current) {
      combined.add(id);
    }
    return combined;
  }, []);

  const {
    data: board,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["board"],
    queryFn: async () => {
      const serverData = await fetchBoard();
      const existing = queryClient.getQueryData<BoardResponse>(["board"]);
      if (!existing) {
        return serverData;
      }
      const reconciled = reconcileBoardFromServer(
        existing.tasks,
        serverData.tasks,
        pendingRef.current,
        savingTempIdsRef.current,
        pendingDeleteIdsRef.current
      );
      pendingRef.current = reconciled.pending;
      syncPendingTaskIds();
      return {
        columns: serverData.columns,
        tasks: reconciled.tasks,
      };
    },
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const enqueueTaskMutation = useCallback((taskId: string, fn: () => Promise<void>) => {
    const prev = taskQueuesRef.current.get(taskId) ?? Promise.resolve();
    const next = prev
      .catch(() => {
        // Keep queue alive after previous error
      })
      .then(fn)
      .finally(() => {
        if (taskQueuesRef.current.get(taskId) === next) {
          taskQueuesRef.current.delete(taskId);
        }
      });
    taskQueuesRef.current.set(taskId, next);
  }, []);

  const createTask = useCallback(
    (input: CreateTaskInput) => {
      const mutationId = newId();
      const tempId = `temp-${newId()}`;
      const currentBoard = queryClient.getQueryData<BoardResponse>(["board"]);
      const status = input.status ?? "backlog";
      const colTasks = (currentBoard?.tasks ?? []).filter((t) => t.status === status);
      const maxPos = colTasks.reduce((max, t) => Math.max(max, t.position), 0);

      const tempTask: Task = {
        id: tempId,
        title: input.title,
        description: input.description ?? "",
        priority: input.priority ?? "medium",
        assignee: input.assignee ?? "",
        status,
        position: input.position ?? maxPos + POSITION_STEP,
        updatedAt: new Date().toISOString(),
      };

      savingTempIdsRef.current.add(tempId);
      syncSavingTaskIds();
      trackOwnMutation(mutationId);

      queryClient.setQueryData<BoardResponse>(["board"], (old) => {
        if (!old) return old;
        return {
          ...old,
          tasks: applyOptimisticCreate(old.tasks, tempTask),
        };
      });

      void createTaskRequest(input, mutationId, { forceFail: forceFailNext })
        .then((created) => {
          savingTempIdsRef.current.delete(tempId);
          syncSavingTaskIds();
          queryClient.setQueryData<BoardResponse>(["board"], (old) => {
            if (!old) return old;
            return {
              ...old,
              tasks: applyCreateSuccess(old.tasks, tempId, created),
            };
          });
        })
        .catch((err: unknown) => {
          savingTempIdsRef.current.delete(tempId);
          syncSavingTaskIds();
          queryClient.setQueryData<BoardResponse>(["board"], (old) => {
            if (!old) return old;
            return {
              ...old,
              tasks: applyCreateFailure(old.tasks, tempId),
            };
          });
          const msg = err instanceof Error ? err.message : "Failed to create task";
          pushToast({
            kind: "error",
            message: `Could not create "${input.title}": ${msg}`,
            retry: () => createTask(input),
          });
        })
        .finally(() => {
          completeOwnMutation(mutationId);
        });
    },
    [
      completeOwnMutation,
      forceFailNext,
      pushToast,
      queryClient,
      syncSavingTaskIds,
      trackOwnMutation,
    ]
  );

  const updateTask = useCallback(
    (taskId: string, patch: UpdateTaskInput) => {
      const currentBoard = queryClient.getQueryData<BoardResponse>(["board"]);
      const currentTask = currentBoard?.tasks.find((t) => t.id === taskId);
      if (!currentTask) {
        return;
      }

      const mutationId = newId();
      const snapshots: Partial<Record<EditableTaskField, Task[EditableTaskField]>> = {};
      for (const key of Object.keys(patch) as EditableTaskField[]) {
        if (patch[key] !== undefined) {
          snapshots[key] = currentTask[key];
        }
      }

      const optimisticResult = applyOptimisticUpdate(
        currentBoard?.tasks ?? [],
        pendingRef.current,
        taskId,
        patch,
        mutationId
      );
      pendingRef.current = optimisticResult.pending;
      syncPendingTaskIds();
      trackOwnMutation(mutationId);

      queryClient.setQueryData<BoardResponse>(["board"], (old) => {
        if (!old) return old;
        return {
          ...old,
          tasks: optimisticResult.tasks,
        };
      });

      const changedFields = optimisticResult.changedFields;
      const shouldForceFail = forceFailNext;

      enqueueTaskMutation(taskId, async () => {
        try {
          const serverTask = await updateTaskRequest(taskId, patch, mutationId, {
            forceFail: shouldForceFail,
          });
          queryClient.setQueryData<BoardResponse>(["board"], (old) => {
            if (!old) return old;
            const res = applyUpdateSuccess(
              old.tasks,
              pendingRef.current,
              serverTask,
              mutationId,
              changedFields
            );
            pendingRef.current = res.pending;
            syncPendingTaskIds();
            return { ...old, tasks: res.tasks };
          });
        } catch (err: unknown) {
          queryClient.setQueryData<BoardResponse>(["board"], (old) => {
            if (!old) return old;
            const res = applyUpdateFailure(
              old.tasks,
              pendingRef.current,
              taskId,
              mutationId,
              changedFields,
              snapshots
            );
            pendingRef.current = res.pending;
            syncPendingTaskIds();
            return { ...old, tasks: res.tasks };
          });
          const msg = err instanceof Error ? err.message : "Failed to update task";
          pushToast({
            kind: "error",
            message: `Update failed for "${currentTask.title}": ${msg}`,
            retry: () => updateTask(taskId, patch),
          });
        } finally {
          completeOwnMutation(mutationId);
        }
      });
    },
    [
      completeOwnMutation,
      enqueueTaskMutation,
      forceFailNext,
      pushToast,
      queryClient,
      syncPendingTaskIds,
      trackOwnMutation,
    ]
  );

  const deleteTask = useCallback(
    (taskId: string) => {
      const currentBoard = queryClient.getQueryData<BoardResponse>(["board"]);
      if (!currentBoard) return;
      const originalIndex = currentBoard.tasks.findIndex((t) => t.id === taskId);
      if (originalIndex === -1) return;
      const snapshot = currentBoard.tasks[originalIndex];
      if (!snapshot) return;

      const mutationId = newId();
      pendingDeleteIdsRef.current.add(taskId);
      trackOwnMutation(mutationId);

      queryClient.setQueryData<BoardResponse>(["board"], (old) => {
        if (!old) return old;
        return {
          ...old,
          tasks: applyOptimisticDelete(old.tasks, taskId),
        };
      });

      const shouldForceFail = forceFailNext;

      enqueueTaskMutation(taskId, async () => {
        try {
          await deleteTaskRequest(taskId, mutationId, { forceFail: shouldForceFail });
          pendingRef.current.delete(taskId);
          syncPendingTaskIds();
        } catch (err: unknown) {
          queryClient.setQueryData<BoardResponse>(["board"], (old) => {
            if (!old) return old;
            return {
              ...old,
              tasks: applyDeleteFailure(old.tasks, snapshot, originalIndex),
            };
          });
          const msg = err instanceof Error ? err.message : "Failed to delete task";
          pushToast({
            kind: "error",
            message: `Could not delete "${snapshot.title}": ${msg}`,
            retry: () => deleteTask(taskId),
          });
        } finally {
          pendingDeleteIdsRef.current.delete(taskId);
          completeOwnMutation(mutationId);
        }
      });
    },
    [
      completeOwnMutation,
      enqueueTaskMutation,
      forceFailNext,
      pushToast,
      queryClient,
      syncPendingTaskIds,
      trackOwnMutation,
    ]
  );

  const applyEventNow = useCallback(
    (
      event: SSEEvent,
      callbacks: {
        activeDragTaskId?: string | null;
        activeDrawerTaskId: string | null;
        onCancelDrag?: () => void;
        onCloseDrawerForDeleted: () => void;
      }
    ) => {
      const ownIds = getKnownOwnMutationIds();
      if (event.mutationId && ownIds.has(event.mutationId)) {
        return;
      }

      if (event.type === "task.deleted") {
        if (callbacks.activeDragTaskId === event.id && callbacks.onCancelDrag) {
          callbacks.onCancelDrag();
          pushToast({ kind: "info", message: "This task was deleted by someone else" });
        } else if (callbacks.activeDrawerTaskId === event.id) {
          callbacks.onCloseDrawerForDeleted();
          pushToast({ kind: "info", message: "This task was deleted by someone else" });
        }
      }

      queryClient.setQueryData<BoardResponse>(["board"], (old) => {
        if (!old) return old;
        const result = applyRemoteSSEEvent(old.tasks, pendingRef.current, event, ownIds);
        if (result.ignored) {
          return old;
        }
        pendingRef.current = result.pending;
        syncPendingTaskIds();
        return {
          ...old,
          tasks: result.tasks,
        };
      });
    },
    [getKnownOwnMutationIds, pushToast, queryClient, syncPendingTaskIds]
  );

  const handleSSEEvent = useCallback(
    (
      event: SSEEvent,
      callbacks: {
        activeDragTaskId: string | null;
        activeDragColumns: ReadonlySet<ColumnId>;
        activeDrawerTaskId: string | null;
        onCancelDrag: () => void;
        onCloseDrawerForDeleted: () => void;
      }
    ) => {
      const ownIds = getKnownOwnMutationIds();
      if (event.mutationId && ownIds.has(event.mutationId)) {
        return;
      }

      // Deletion of the actively dragged task must immediately cancel the drag
      if (event.type === "task.deleted" && callbacks.activeDragTaskId === event.id) {
        applyEventNow(event, callbacks);
        return;
      }

      // Buffer events affecting columns currently involved in an active drag
      if (callbacks.activeDragColumns.size > 0) {
        const currentBoard = queryClient.getQueryData<BoardResponse>(["board"]);
        const touchesActiveCol = (() => {
          if (event.type === "task.created" || event.type === "task.updated") {
            if (callbacks.activeDragColumns.has(event.task.status)) {
              return true;
            }
            const existing = currentBoard?.tasks.find((t) => t.id === event.task.id);
            return existing ? callbacks.activeDragColumns.has(existing.status) : false;
          }
          const existing = currentBoard?.tasks.find((t) => t.id === event.id);
          return existing ? callbacks.activeDragColumns.has(existing.status) : false;
        })();

        if (touchesActiveCol) {
          bufferedEventsRef.current.push(event);
          return;
        }
      }

      applyEventNow(event, callbacks);
    },
    [applyEventNow, getKnownOwnMutationIds, queryClient]
  );

  const flushBufferedEventsForDrop = useCallback(
    (callbacks: { activeDrawerTaskId: string | null; onCloseDrawerForDeleted: () => void }) => {
      const buffered = bufferedEventsRef.current;
      if (buffered.length === 0) return;
      bufferedEventsRef.current = [];
      for (const ev of buffered) {
        applyEventNow(ev, callbacks);
      }
    },
    [applyEventNow]
  );

  const reconcileOnReconnect = useCallback(async () => {
    await refetch();
  }, [refetch]);

  const refetchBoard = useCallback(() => {
    void refetch();
  }, [refetch]);

  const value = useMemo<BoardContextValue>(
    () => ({
      board,
      isLoading,
      isError,
      error,
      refetchBoard,
      savingTaskIds,
      pendingTaskIds,
      toasts,
      dismissToast,
      pushToast,
      connectionStatus,
      setConnectionStatus,
      forceFailNext,
      setForceFailNext,
      createTask,
      updateTask,
      deleteTask,
      handleSSEEvent,
      flushBufferedEventsForDrop,
      reconcileOnReconnect,
    }),
    [
      board,
      isLoading,
      isError,
      error,
      refetchBoard,
      savingTaskIds,
      pendingTaskIds,
      toasts,
      dismissToast,
      pushToast,
      connectionStatus,
      forceFailNext,
      createTask,
      updateTask,
      deleteTask,
      handleSSEEvent,
      flushBufferedEventsForDrop,
      reconcileOnReconnect,
    ]
  );

  return <BoardContext.Provider value={value}>{children}</BoardContext.Provider>;
}

export function useBoardStore(): BoardContextValue {
  const ctx = useContext(BoardContext);
  if (!ctx) {
    throw new Error("useBoardStore must be used inside BoardProvider");
  }
  return ctx;
}
