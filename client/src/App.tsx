import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { COLUMNS, computeInsertPosition, type ColumnId, type Task } from "@kanban/shared";
import { BoardSkeleton } from "./components/BoardSkeleton.js";
import { Column } from "./components/Column.js";
import { FilterBar } from "./components/FilterBar.js";
import { TaskCard } from "./components/TaskCard.js";
import { TaskDrawer } from "./components/TaskDrawer.js";
import { ToastContainer } from "./components/ToastContainer.js";
import { useBoardSSE } from "./hooks/useBoardSSE.js";
import { BoardProvider, useBoardStore } from "./state/boardStore.js";
import {
  DEFAULT_FILTERS,
  deriveAssignees,
  filterTasks,
  isFilterActive,
  parseUrlBoardState,
  serializeUrlBoardState,
  type BoardFilters,
  type PriorityFilter,
} from "./state/filters.js";

interface DragPlacement {
  taskId: string;
  originColumn: ColumnId;
  targetColumn: ColumnId;
  targetIndex: number;
}

function sortTasks(list: readonly Task[]): Task[] {
  return [...list].sort(
    (a, b) => a.position - b.position || a.updatedAt.localeCompare(b.updatedAt)
  );
}

function syncUrl(filters: BoardFilters, taskId: string | null, mode: "push" | "replace"): void {
  const nextSearch = serializeUrlBoardState({ filters, taskId }, window.location.search);
  const nextUrl = `${window.location.pathname}${nextSearch}${window.location.hash}`;
  if (mode === "replace") {
    window.history.replaceState({}, "", nextUrl);
  } else {
    window.history.pushState({}, "", nextUrl);
  }
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
    updateTask,
    flushBufferedEventsForDrop,
  } = useBoardStore();

  const initialUrlState = useMemo(() => parseUrlBoardState(window.location.search), []);

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(initialUrlState.taskId);
  const [filters, setFilters] = useState<BoardFilters>(initialUrlState.filters);
  const [searchInput, setSearchInput] = useState<string>(initialUrlState.filters.q);
  const [dragPlacement, setDragPlacement] = useState<DragPlacement | null>(null);
  const [dndResetKey, setDndResetKey] = useState(0);

  // Debounce title search (~250ms) and sync with history.replaceState
  useEffect(() => {
    if (searchInput === filters.q) return;
    const timer = window.setTimeout(() => {
      const nextFilters: BoardFilters = { ...filters, q: searchInput };
      setFilters(nextFilters);
      syncUrl(nextFilters, selectedTaskId, "replace");
    }, 250);
    return () => window.clearTimeout(timer);
  }, [filters, searchInput, selectedTaskId]);

  // Restore filter + drawer state on browser back/forward
  useEffect(() => {
    const onPopState = () => {
      const parsed = parseUrlBoardState(window.location.search);
      setFilters(parsed.filters);
      setSearchInput(parsed.filters.q);
      setSelectedTaskId(parsed.taskId);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const handleSelectTask = useCallback(
    (taskId: string) => {
      setSelectedTaskId(taskId);
      syncUrl(filters, taskId, "push");
    },
    [filters]
  );

  const handleCloseDrawer = useCallback(() => {
    setSelectedTaskId(null);
    syncUrl(filters, null, "push");
  }, [filters]);

  const activeDragColumns = useMemo(() => {
    const set = new Set<ColumnId>();
    if (dragPlacement) {
      set.add(dragPlacement.originColumn);
      set.add(dragPlacement.targetColumn);
    }
    return set;
  }, [dragPlacement]);

  const handleCancelDragFromRemote = useCallback(() => {
    setDragPlacement(null);
    setDndResetKey((k) => k + 1);
    flushBufferedEventsForDrop({
      activeDrawerTaskId: selectedTaskId,
      onCloseDrawerForDeleted: handleCloseDrawer,
    });
  }, [flushBufferedEventsForDrop, handleCloseDrawer, selectedTaskId]);

  useBoardSSE({
    activeDragTaskId: dragPlacement?.taskId ?? null,
    activeDragColumns,
    activeDrawerTaskId: selectedTaskId,
    onCancelDrag: handleCancelDragFromRemote,
    onCloseDrawerForDeleted: handleCloseDrawer,
  });

  const handlePriorityChange = useCallback(
    (priority: PriorityFilter) => {
      const nextFilters: BoardFilters = { ...filters, priority };
      setFilters(nextFilters);
      syncUrl(nextFilters, selectedTaskId, "push");
    },
    [filters, selectedTaskId]
  );

  const handleAssigneeChange = useCallback(
    (assignee: string) => {
      const nextFilters: BoardFilters = { ...filters, assignee };
      setFilters(nextFilters);
      syncUrl(nextFilters, selectedTaskId, "push");
    },
    [filters, selectedTaskId]
  );

  const handleClearFilters = useCallback(() => {
    setSearchInput("");
    setFilters(DEFAULT_FILTERS);
    syncUrl(DEFAULT_FILTERS, selectedTaskId, "push");
  }, [selectedTaskId]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const allTasks = board?.tasks ?? [];
  const assignees = useMemo(() => deriveAssignees(allTasks), [allTasks]);
  const filteringActive = isFilterActive(filters);
  const filteredTasks = useMemo(() => filterTasks(allTasks, filters), [allTasks, filters]);

  // Unfiltered counts per column + sorted base tasks for DnD
  const baseTasksByColumn = useMemo(() => {
    const map = new Map<ColumnId, Task[]>();
    for (const col of COLUMNS) {
      map.set(col.id, []);
    }
    for (const task of allTasks) {
      const list = map.get(task.status);
      if (list) {
        list.push(task);
      }
    }
    for (const [colId, list] of map.entries()) {
      map.set(colId, sortTasks(list));
    }
    return map;
  }, [allTasks]);

  const filteredTasksByColumn = useMemo(() => {
    if (!filteringActive) {
      return baseTasksByColumn;
    }
    const map = new Map<ColumnId, Task[]>();
    for (const col of COLUMNS) {
      map.set(col.id, []);
    }
    for (const task of filteredTasks) {
      const list = map.get(task.status);
      if (list) {
        list.push(task);
      }
    }
    for (const [colId, list] of map.entries()) {
      map.set(colId, sortTasks(list));
    }
    return map;
  }, [baseTasksByColumn, filteredTasks, filteringActive]);

  // Apply temporary cross-column preview placement during an active drag (unfiltered)
  const displayTasksByColumn = useMemo(() => {
    if (!dragPlacement || filteringActive) {
      return filteredTasksByColumn;
    }
    const map = new Map<ColumnId, Task[]>();
    let draggedTask: Task | undefined;

    for (const [colId, list] of baseTasksByColumn.entries()) {
      const filtered = list.filter((t) => {
        if (t.id === dragPlacement.taskId) {
          draggedTask = t;
          return false;
        }
        return true;
      });
      map.set(colId, filtered);
    }

    if (draggedTask) {
      const targetList = [...(map.get(dragPlacement.targetColumn) ?? [])];
      const clampedIndex = Math.min(Math.max(0, dragPlacement.targetIndex), targetList.length);
      targetList.splice(clampedIndex, 0, {
        ...draggedTask,
        status: dragPlacement.targetColumn,
      });
      map.set(dragPlacement.targetColumn, targetList);
    }

    return map;
  }, [baseTasksByColumn, dragPlacement, filteredTasksByColumn, filteringActive]);

  const activeDragTask = useMemo(() => {
    if (!dragPlacement || !board) return null;
    return board.tasks.find((t) => t.id === dragPlacement.taskId) ?? null;
  }, [board, dragPlacement]);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      if (filteringActive) return;
      const id = String(event.active.id);
      const task = board?.tasks.find((t) => t.id === id);
      if (!task) return;
      const colList = baseTasksByColumn.get(task.status) ?? [];
      const index = colList.findIndex((t) => t.id === id);
      setDragPlacement({
        taskId: id,
        originColumn: task.status,
        targetColumn: task.status,
        targetIndex: Math.max(0, index),
      });
    },
    [baseTasksByColumn, board?.tasks, filteringActive]
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const { active, over } = event;
      if (!over || !dragPlacement) return;

      const activeId = String(active.id);
      const overId = String(over.id);
      if (activeId === overId) return;

      let nextCol: ColumnId | null = null;
      let nextIndex = 0;

      if (overId.startsWith("column:")) {
        nextCol = overId.slice("column:".length) as ColumnId;
        const listWithoutActive = (baseTasksByColumn.get(nextCol) ?? []).filter(
          (t) => t.id !== activeId
        );
        nextIndex = listWithoutActive.length;
      } else {
        const overTask = board?.tasks.find((t) => t.id === overId);
        if (!overTask) return;
        nextCol = overTask.status;
        const listWithoutActive = (baseTasksByColumn.get(nextCol) ?? []).filter(
          (t) => t.id !== activeId
        );
        const overIndex = listWithoutActive.findIndex((t) => t.id === overId);
        if (overIndex === -1) return;

        const activeRect = active.rect.current.translated;
        const isBelow =
          activeRect !== null && activeRect.top > over.rect.top + over.rect.height / 2;
        nextIndex = overIndex + (isBelow ? 1 : 0);
      }

      if (nextCol !== dragPlacement.targetColumn || nextIndex !== dragPlacement.targetIndex) {
        setDragPlacement((prev) =>
          prev
            ? {
                ...prev,
                targetColumn: nextCol,
                targetIndex: nextIndex,
              }
            : null
        );
      }
    },
    [baseTasksByColumn, board?.tasks, dragPlacement]
  );

  const finalizeDrag = useCallback(() => {
    setDragPlacement(null);
    flushBufferedEventsForDrop({
      activeDrawerTaskId: selectedTaskId,
      onCloseDrawerForDeleted: handleCloseDrawer,
    });
  }, [flushBufferedEventsForDrop, handleCloseDrawer, selectedTaskId]);

  const handleDragCancel = useCallback(() => {
    finalizeDrag();
  }, [finalizeDrag]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      const placement = dragPlacement;

      if (!over || !placement || !board) {
        finalizeDrag();
        return;
      }

      const activeId = String(active.id);
      const activeTask = board.tasks.find((t) => t.id === activeId);
      if (!activeTask) {
        finalizeDrag();
        return;
      }

      const overId = String(over.id);
      const targetColumn = placement.targetColumn;

      if (targetColumn === activeTask.status) {
        const colTasks = baseTasksByColumn.get(targetColumn) ?? [];
        const oldIndex = colTasks.findIndex((t) => t.id === activeId);
        if (oldIndex === -1) {
          finalizeDrag();
          return;
        }

        let newIndex = placement.targetIndex;
        if (!overId.startsWith("column:")) {
          const overIdx = colTasks.findIndex((t) => t.id === overId);
          if (overIdx !== -1) {
            newIndex = overIdx;
          }
        }
        const clampedNewIndex = Math.min(Math.max(0, newIndex), colTasks.length - 1);
        if (clampedNewIndex !== oldIndex) {
          const reordered = arrayMove(colTasks, oldIndex, clampedNewIndex);
          const prevPos = reordered[clampedNewIndex - 1]?.position ?? null;
          const nextPos = reordered[clampedNewIndex + 1]?.position ?? null;
          const { position } = computeInsertPosition(prevPos, nextPos);
          updateTask(activeId, { position });
        }
      } else {
        const targetList = (baseTasksByColumn.get(targetColumn) ?? []).filter(
          (t) => t.id !== activeId
        );
        const insertAt = Math.min(Math.max(0, placement.targetIndex), targetList.length);
        const prevPos = targetList[insertAt - 1]?.position ?? null;
        const nextPos = targetList[insertAt]?.position ?? null;
        const { position } = computeInsertPosition(prevPos, nextPos);
        updateTask(activeId, { status: targetColumn, position });
      }

      finalizeDrag();
    },
    [baseTasksByColumn, board, dragPlacement, finalizeDrag, updateTask]
  );

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
        <FilterBar
          searchInput={searchInput}
          filters={filters}
          assignees={assignees}
          onSearchInputChange={setSearchInput}
          onPriorityChange={handlePriorityChange}
          onAssigneeChange={handleAssigneeChange}
          onClearFilters={handleClearFilters}
        />

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
          <DndContext
            key={dndResetKey}
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <div className="board-grid">
              {board.columns.map((col) => {
                const colTasks = displayTasksByColumn.get(col.id) ?? [];
                const totalCount = (baseTasksByColumn.get(col.id) ?? []).length;
                return (
                  <Column
                    key={col.id}
                    column={col}
                    tasks={colTasks}
                    totalCount={totalCount}
                    isFiltered={filteringActive}
                    onSelectTask={handleSelectTask}
                  />
                );
              })}
            </div>

            <DragOverlay>
              {activeDragTask ? (
                <TaskCard task={activeDragTask} isOverlay onSelect={() => {}} />
              ) : null}
            </DragOverlay>
          </DndContext>
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
