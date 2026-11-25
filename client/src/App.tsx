import React, { useCallback, useEffect, useMemo, useState } from "react";
import { COLUMNS, type Task } from "@kanban/shared";
import { BoardSkeleton } from "./components/BoardSkeleton.js";
import { Column } from "./components/Column.js";
import { TaskDrawer } from "./components/TaskDrawer.js";
import { ToastContainer } from "./components/ToastContainer.js";
import { BoardProvider, useBoardStore } from "./state/boardStore.js";

function readTaskIdFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const val = params.get("task");
  return val && val.trim() ? val.trim() : null;
}

function writeTaskIdToUrl(taskId: string | null): void {
  const url = new URL(window.location.href);
  if (taskId) {
    url.searchParams.set("task", taskId);
  } else {
    url.searchParams.delete("task");
  }
  window.history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function BoardWorkspace(): React.JSX.Element {
  const {
    board,
    isLoading,
    isError,
    error,
    refetchBoard,
    connectionStatus,
    forceFailNext,
    setForceFailNext,
  } = useBoardStore();

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() => readTaskIdFromUrl());

  useEffect(() => {
    const onPopState = () => {
      setSelectedTaskId(readTaskIdFromUrl());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const handleSelectTask = useCallback((taskId: string) => {
    setSelectedTaskId(taskId);
    writeTaskIdToUrl(taskId);
  }, []);

  const handleCloseDrawer = useCallback(() => {
    setSelectedTaskId(null);
    writeTaskIdToUrl(null);
  }, []);

  const tasksByColumn = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const col of COLUMNS) {
      map.set(col.id, []);
    }
    for (const task of board?.tasks ?? []) {
      const list = map.get(task.status);
      if (list) {
        list.push(task);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.position - b.position || a.updatedAt.localeCompare(b.updatedAt));
    }
    return map;
  }, [board?.tasks]);

  const activeTask = useMemo(() => {
    if (!selectedTaskId || !board) return null;
    return board.tasks.find((t) => t.id === selectedTaskId) ?? null;
  }, [board, selectedTaskId]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar__brand">
          <div className="topbar__logo" aria-hidden="true">
            K
          </div>
          <h1 className="topbar__title">SyncBoard Kanban</h1>
        </div>

        <div className="topbar__controls">
          <label className="fail-toggle" title="Force ?fail=1 on mutations for testing rollback">
            <input
              type="checkbox"
              checked={forceFailNext}
              onChange={(e) => setForceFailNext(e.target.checked)}
            />
            <span>Simulate Failure (?fail=1)</span>
          </label>

          <div
            className={`status-pill status-pill--${connectionStatus}`}
            role="status"
            aria-label={`Real-time connection: ${connectionStatus}`}
          >
            <span className="status-pill__dot" aria-hidden="true" />
            <span>{connectionStatus === "live" ? "Live" : "Reconnecting"}</span>
          </div>
        </div>
      </header>

      <main className="main-content">
        {isLoading && <BoardSkeleton />}

        {isError && (
          <div className="error-banner" role="alert">
            <h2>Unable to load board</h2>
            <p>{error?.message ?? "An unexpected network error occurred."}</p>
            <button type="button" className="btn btn--primary" onClick={refetchBoard}>
              Retry
            </button>
          </div>
        )}

        {board && (
          <div className="board-grid">
            {board.columns.map((col) => {
              const colTasks = tasksByColumn.get(col.id) ?? [];
              return (
                <Column
                  key={col.id}
                  column={col}
                  tasks={colTasks}
                  totalCount={colTasks.length}
                  isFiltered={false}
                  onSelectTask={handleSelectTask}
                />
              );
            })}
          </div>
        )}
      </main>

      <TaskDrawer task={activeTask} onClose={handleCloseDrawer} />
      <ToastContainer />
    </div>
  );
}

export function App(): React.JSX.Element {
  return (
    <BoardProvider>
      <BoardWorkspace />
    </BoardProvider>
  );
}

export default App;
