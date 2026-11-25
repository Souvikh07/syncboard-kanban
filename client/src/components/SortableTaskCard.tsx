import React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Task } from "@kanban/shared";
import { TaskCard } from "./TaskCard.js";

interface SortableTaskCardProps {
  task: Task;
  isSaving: boolean;
  isPending: boolean;
  dragDisabled: boolean;
  onSelect: (taskId: string) => void;
}

export function SortableTaskCard({
  task,
  isSaving,
  isPending,
  dragDisabled,
  onSelect,
}: SortableTaskCardProps): React.JSX.Element {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: task.id,
    data: { type: "task", task },
    disabled: isSaving || dragDisabled,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={isDragging ? "task-card--dragging" : undefined}
    >
      <TaskCard
        task={task}
        isSaving={isSaving}
        isPending={isPending}
        dragDisabled={dragDisabled}
        onSelect={onSelect}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
}
