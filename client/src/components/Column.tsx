import React, { useState } from "react";
import { PRIORITIES, type Column as ColumnType, type Priority, type Task } from "@kanban/shared";
import { useBoardStore } from "../state/boardStore.js";
import { PlusIcon } from "./Icons.js";
import { TaskCard } from "./TaskCard.js";

interface ColumnProps {
  column: ColumnType;
  tasks: readonly Task[];
  totalCount: number;
  isFiltered: boolean;
  onSelectTask: (taskId: string) => void;
}

export function Column({
  column,
  tasks,
  totalCount,
  isFiltered,
  onSelectTask,
}: ColumnProps): React.JSX.Element {
  const { createTask, savingTaskIds, pendingTaskIds } = useBoardStore();
  const [isAdding, setIsAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;

    createTask({
      title: trimmed,
      assignee: assignee.trim(),
      priority,
      status: column.id,
    });
    setTitle("");
    setAssignee("");
    setPriority("medium");
    setIsAdding(false);
  };

  return (
    <section className="column" aria-label={`${column.title} column`}>
      <header className="column__header">
        <div className="column__title-group">
          <span className={`column__dot column__dot--${column.id}`} aria-hidden="true" />
          <h2 className="column__title">{column.title}</h2>
          <span className="column__count" aria-label={`${tasks.length} tasks`}>
            {isFiltered && tasks.length !== totalCount
              ? `${tasks.length} / ${totalCount}`
              : tasks.length}
          </span>
        </div>
        <button
          type="button"
          className="column__add-btn"
          onClick={() => setIsAdding((v) => !v)}
          aria-label={`Add task to ${column.title}`}
          aria-expanded={isAdding}
        >
          <PlusIcon />
        </button>
      </header>

      {isAdding && (
        <form className="add-task-form" onSubmit={handleCreate}>
          <input
            type="text"
            className="input"
            placeholder="Task title..."
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="New task title"
            autoFocus
            required
          />
          <div className="add-task-form__row">
            <input
              type="text"
              className="input input--sm"
              placeholder="Assignee (optional)"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              aria-label="New task assignee"
            />
            <select
              className="select select--sm"
              value={priority}
              onChange={(e) => setPriority(e.target.value as Priority)}
              aria-label="New task priority"
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div className="add-task-form__actions">
            <button type="submit" className="btn btn--primary btn--sm">
              Add task
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setIsAdding(false);
                setTitle("");
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="column__list">
        {tasks.length === 0 ? (
          <div className="column__empty">
            {isFiltered ? "No matching tasks" : "No tasks in this column"}
          </div>
        ) : (
          tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              isSaving={savingTaskIds.has(task.id)}
              isPending={pendingTaskIds.has(task.id)}
              dragDisabled={true}
              onSelect={onSelectTask}
            />
          ))
        )}
      </div>
    </section>
  );
}
