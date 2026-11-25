import React, { useEffect, useRef, useState } from "react";
import {
  COLUMNS,
  PRIORITIES,
  type ColumnId,
  type Priority,
  type Task,
} from "@kanban/shared";
import { useBoardStore } from "../state/boardStore.js";
import { CloseIcon, TrashIcon } from "./Icons.js";

interface TaskDrawerProps {
  task: Task | null;
  onClose: () => void;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function TaskDrawer({ task, onClose }: TaskDrawerProps): React.JSX.Element | null {
  const { updateTask, deleteTask } = useBoardStore();
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignee, setAssignee] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Sync local draft fields whenever the opened task or its server/remote fields change
  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setDescription(task.description);
      setAssignee(task.assignee);
      setConfirmDelete(false);
    }
  }, [task?.id, task?.title, task?.description, task?.assignee]);

  // Focus trap + Escape key + restore focus on close
  useEffect(() => {
    if (!task) return;

    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const drawerEl = drawerRef.current;

    const focusTimer = window.setTimeout(() => {
      const firstInput = drawerEl?.querySelector<HTMLElement>("input, textarea, button");
      firstInput?.focus();
    }, 0);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }

      if (e.key === "Tab" && drawerEl) {
        const focusables = Array.from(
          drawerEl.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
        );
        if (focusables.length === 0) return;

        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;

        if (e.shiftKey) {
          if (document.activeElement === first || !drawerEl.contains(document.activeElement)) {
            e.preventDefault();
            last.focus();
          }
        } else if (document.activeElement === last || !drawerEl.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [task?.id, onClose]);

  if (!task) {
    return null;
  }

  const commitTitle = () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setTitle(task.title);
      return;
    }
    if (trimmed !== task.title) {
      updateTask(task.id, { title: trimmed });
    }
  };

  const commitDescription = () => {
    if (description !== task.description) {
      updateTask(task.id, { description });
    }
  };

  const commitAssignee = () => {
    const trimmed = assignee.trim();
    if (trimmed !== task.assignee) {
      updateTask(task.id, { assignee: trimmed });
    }
  };

  return (
    <div
      className="drawer-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <aside
        ref={drawerRef}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-heading"
      >
        <header className="drawer__header">
          <div>
            <span className="drawer__eyebrow">Task Details</span>
            <h2 id="drawer-heading" className="sr-only">
              Edit task {task.title}
            </h2>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={onClose}
            aria-label="Close task drawer"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="drawer__body">
          <div className="field">
            <label htmlFor="drawer-title" className="field__label">
              Title
            </label>
            <input
              id="drawer-title"
              type="text"
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={commitTitle}
              aria-label="Task title"
            />
          </div>

          <div className="drawer__grid">
            <div className="field">
              <label htmlFor="drawer-status" className="field__label">
                Column
              </label>
              <select
                id="drawer-status"
                className="select"
                value={task.status}
                onChange={(e) =>
                  updateTask(task.id, { status: e.target.value as ColumnId })
                }
                aria-label="Task status"
              >
                {COLUMNS.map((col) => (
                  <option key={col.id} value={col.id}>
                    {col.title}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="drawer-priority" className="field__label">
                Priority
              </label>
              <select
                id="drawer-priority"
                className="select"
                value={task.priority}
                onChange={(e) =>
                  updateTask(task.id, { priority: e.target.value as Priority })
                }
                aria-label="Task priority"
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="field">
            <label htmlFor="drawer-assignee" className="field__label">
              Assignee
            </label>
            <input
              id="drawer-assignee"
              type="text"
              className="input"
              placeholder="Unassigned"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              onBlur={commitAssignee}
              aria-label="Task assignee"
            />
          </div>

          <div className="field">
            <label htmlFor="drawer-description" className="field__label">
              Description
            </label>
            <textarea
              id="drawer-description"
              className="textarea"
              rows={6}
              placeholder="Add context, acceptance criteria, or notes..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={commitDescription}
              aria-label="Task description"
            />
          </div>

          <div className="drawer__meta">
            <span>ID: {task.id.slice(0, 8)}</span>
            <span>Updated: {new Date(task.updatedAt).toLocaleString()}</span>
          </div>
        </div>

        <footer className="drawer__footer">
          {!confirmDelete ? (
            <button
              type="button"
              className="btn btn--danger-outline"
              onClick={() => setConfirmDelete(true)}
            >
              <TrashIcon />
              <span>Delete task</span>
            </button>
          ) : (
            <div className="drawer__confirm">
              <span className="drawer__confirm-text">Delete permanently?</span>
              <button
                type="button"
                className="btn btn--danger btn--sm"
                onClick={() => {
                  deleteTask(task.id);
                  onClose();
                }}
              >
                Confirm delete
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </button>
            </div>
          )}
        </footer>
      </aside>
    </div>
  );
}
