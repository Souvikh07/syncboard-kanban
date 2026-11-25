import { useEffect, useRef } from "react";
import type { ColumnId, SSEEvent } from "@kanban/shared";
import { useBoardStore } from "../state/boardStore.js";

interface UseBoardSSEOptions {
  activeDragTaskId: string | null;
  activeDragColumns: ReadonlySet<ColumnId>;
  activeDrawerTaskId: string | null;
  onCancelDrag: () => void;
  onCloseDrawerForDeleted: () => void;
}

/**
 * Subscribes to `/api/events` via native EventSource, tracks connection status,
 * routes incoming SSE events through the board store's merge/buffering logic,
 * and triggers board reconciliation upon reconnect.
 */
export function useBoardSSE(options: UseBoardSSEOptions): void {
  const {
    handleSSEEvent,
    setConnectionStatus,
    reconcileOnReconnect,
  } = useBoardStore();

  const latestOptionsRef = useRef(options);
  latestOptionsRef.current = options;

  const hasOpenedOnceRef = useRef(false);

  useEffect(() => {
    if (typeof EventSource === "undefined") {
      return;
    }

    const es = new EventSource("/api/events");

    const onOpen = () => {
      setConnectionStatus("live");
      if (hasOpenedOnceRef.current) {
        void reconcileOnReconnect();
      }
      hasOpenedOnceRef.current = true;
    };

    const onError = () => {
      setConnectionStatus("reconnecting");
    };

    const onTaskEvent = (e: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(e.data) as SSEEvent;
        const cur = latestOptionsRef.current;
        handleSSEEvent(parsed, {
          activeDragTaskId: cur.activeDragTaskId,
          activeDragColumns: cur.activeDragColumns,
          activeDrawerTaskId: cur.activeDrawerTaskId,
          onCancelDrag: cur.onCancelDrag,
          onCloseDrawerForDeleted: cur.onCloseDrawerForDeleted,
        });
      } catch {
        // Ignore malformed SSE frames
      }
    };

    es.addEventListener("open", onOpen);
    es.addEventListener("error", onError);
    es.addEventListener("task.created", onTaskEvent as EventListener);
    es.addEventListener("task.updated", onTaskEvent as EventListener);
    es.addEventListener("task.deleted", onTaskEvent as EventListener);

    return () => {
      es.removeEventListener("open", onOpen);
      es.removeEventListener("error", onError);
      es.removeEventListener("task.created", onTaskEvent as EventListener);
      es.removeEventListener("task.updated", onTaskEvent as EventListener);
      es.removeEventListener("task.deleted", onTaskEvent as EventListener);
      es.close();
    };
  }, [handleSSEEvent, reconcileOnReconnect, setConnectionStatus]);
}
