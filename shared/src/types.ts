export type Priority = "low" | "medium" | "high";

export type ColumnId = "backlog" | "todo" | "in-progress" | "done";

export interface Column {
  id: ColumnId;
  title: string;
}

export const COLUMNS: readonly Column[] = [
  { id: "backlog", title: "Backlog" },
  { id: "todo", title: "Todo" },
  { id: "in-progress", title: "In Progress" },
  { id: "done", title: "Done" },
] as const;

export const COLUMN_IDS: readonly ColumnId[] = COLUMNS.map((c) => c.id);

export const PRIORITIES: readonly Priority[] = ["low", "medium", "high"] as const;

export interface Task {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  assignee: string;
  status: ColumnId;
  position: number;
  updatedAt: string;
}

export type EditableTaskField =
  | "title"
  | "description"
  | "priority"
  | "assignee"
  | "status"
  | "position";

export interface BoardResponse {
  columns: Column[];
  tasks: Task[];
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: Priority;
  assignee?: string;
  status?: ColumnId;
  position?: number;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  priority?: Priority;
  assignee?: string;
  status?: ColumnId;
  position?: number;
}

export interface TaskCreatedEvent {
  type: "task.created";
  task: Task;
  originClientId: string | null;
  mutationId: string | null;
  updatedAt: string;
}

export interface TaskUpdatedEvent {
  type: "task.updated";
  task: Task;
  originClientId: string | null;
  mutationId: string | null;
  updatedAt: string;
}

export interface TaskDeletedEvent {
  type: "task.deleted";
  id: string;
  originClientId: string | null;
  mutationId: string | null;
  updatedAt: string;
}

export type SSEEvent = TaskCreatedEvent | TaskUpdatedEvent | TaskDeletedEvent;
