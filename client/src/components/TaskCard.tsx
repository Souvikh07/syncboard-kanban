import React from "react";
import type { Task } from "@kanban/shared";
import { GripIcon } from "./Icons.js";

interface TaskCardProps {
  task: Task;
  isSaving?: boolean;
  isPending?: boolean;
  isOverlay?: boolean;
  dragDisabled?: boolean;
  onSelect: (taskId: string) => void;
  dragHandleProps?: Record<string, unknown>;
}

const AVATAR_COLORS = [
  "#0284c7",
  "#7c3aed",
  "#db2777",
  "#059669",
  "#d97706",
  "#4f46e5",
];

function getInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return parts[0]!.slice(0, 2).toUpperCase();
  }
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
}

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length] ?? "#4f46e5";
}

export function TaskCard({
  task,
  isSaving = false,
  isPending = false,
  isOverlay = false,
  dragDisabled = false,
  onSelect,
  dragHandleProps,
}: TaskCardProps): React.JSX.Element {
  return (
    <article
      className={[
        "task-card",
        isSaving ? "task-card--saving" : "",
        isPending ? "task-card--pending" : "",
        isOverlay ? "task-card--overlay" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-task-id={task.id}
    >
      <div className="task-card__top">
        {!dragDisabled && (
          <button
            type="button"
            className="task-card__drag-handle"
            aria-label={`Drag task ${task.title}`}
            disabled={isSaving}
            {...dragHandleProps}
          >
            <GripIcon />
          </button>
        )}
        <button
          type="button"
          className="task-card__open"
          onClick={() => {
            if (!isSaving) {
              onSelect(task.id);
            }
          }}
          disabled={isSaving}
          aria-label={`Open task ${task.title}`}
        >
          <span className="task-card__title">{task.title}</span>
        </button>
      </div>

      {task.description && (
        <p className="task-card__desc">{task.description}</p>
      )}

      <div className="task-card__footer">
        <span className={`priority-badge priority-badge--${task.priority}`}>
          {task.priority}
        </span>

        <div className="task-card__right">
          {isSaving && <span className="task-card__status-tag">Saving…</span>}
          {!isSaving && isPending && <span className="task-card__status-tag">Syncing…</span>}
          {task.assignee ? (
            <span className="assignee-chip" title={`Assigned to ${task.assignee}`}>
              <span
                className="assignee-chip__avatar"
                style={{ backgroundColor: getAvatarColor(task.assignee) }}
              >
                {getInitials(task.assignee)}
              </span>
              <span className="assignee-chip__name">{task.assignee}</span>
            </span>
          ) : (
            <span className="assignee-chip assignee-chip--unassigned">Unassigned</span>
          )}
        </div>
      </div>
    </article>
  );
}
