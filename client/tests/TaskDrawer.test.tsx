import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@kanban/shared";
import { TaskDrawer } from "../src/components/TaskDrawer.js";
import { BoardProvider } from "../src/state/boardStore.js";

function renderDrawer(task: Task | null, onClose = vi.fn()) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    onClose,
    ...render(
      <QueryClientProvider client={qc}>
        <BoardProvider>
          <TaskDrawer task={task} onClose={onClose} />
        </BoardProvider>
      </QueryClientProvider>
    ),
  };
}

const SAMPLE_TASK: Task = {
  id: "task-12345678",
  title: "Review SSE merge",
  description: "Ensure pending fields win",
  priority: "high",
  assignee: "Aria",
  status: "in-progress",
  position: 1024,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("TaskDrawer accessibility and interactions", () => {
  it("renders accessible dialog, closes on Escape, and requires delete confirmation", () => {
    const onClose = vi.fn();
    renderDrawer(SAMPLE_TASK, onClose);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByLabelText("Task title")).toHaveValue("Review SSE merge");

    // Delete requires confirmation step
    fireEvent.click(screen.getByRole("button", { name: /delete task/i }));
    expect(screen.getByRole("button", { name: /confirm delete/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.queryByRole("button", { name: /confirm delete/i })).not.toBeInTheDocument();

    // Pressing Escape closes the drawer
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
