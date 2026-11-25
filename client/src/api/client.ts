import type { BoardResponse, CreateTaskInput, Task, UpdateTaskInput } from "@kanban/shared";

export const CLIENT_ID: string =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `client-${Math.random().toString(36).slice(2, 12)}`;

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function withFailQuery(url: string, forceFail?: boolean): string {
  const urlFail =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("fail") === "1";
  if (forceFail || urlFail) {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}fail=1`;
  }
  return url;
}

async function parseErrorResponse(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim()) {
      return body.error;
    }
  } catch {
    // ignore JSON parse failure
  }
  return `Request failed with status ${res.status}`;
}

export async function fetchBoard(): Promise<BoardResponse> {
  const res = await fetch("/api/board", {
    headers: {
      "X-Client-Id": CLIENT_ID,
    },
  });
  if (!res.ok) {
    throw new ApiError(res.status, await parseErrorResponse(res));
  }
  return (await res.json()) as BoardResponse;
}

export async function createTaskRequest(
  input: CreateTaskInput,
  mutationId: string,
  options: { forceFail?: boolean } = {}
): Promise<Task> {
  const res = await fetch(withFailQuery("/api/tasks", options.forceFail), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Client-Id": CLIENT_ID,
      "X-Mutation-Id": mutationId,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new ApiError(res.status, await parseErrorResponse(res));
  }
  return (await res.json()) as Task;
}

export async function updateTaskRequest(
  id: string,
  patch: UpdateTaskInput,
  mutationId: string,
  options: { forceFail?: boolean } = {}
): Promise<Task> {
  const res = await fetch(
    withFailQuery(`/api/tasks/${encodeURIComponent(id)}`, options.forceFail),
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Id": CLIENT_ID,
        "X-Mutation-Id": mutationId,
      },
      body: JSON.stringify(patch),
    }
  );
  if (!res.ok) {
    throw new ApiError(res.status, await parseErrorResponse(res));
  }
  return (await res.json()) as Task;
}

export async function deleteTaskRequest(
  id: string,
  mutationId: string,
  options: { forceFail?: boolean } = {}
): Promise<void> {
  const res = await fetch(
    withFailQuery(`/api/tasks/${encodeURIComponent(id)}`, options.forceFail),
    {
      method: "DELETE",
      headers: {
        "X-Client-Id": CLIENT_ID,
        "X-Mutation-Id": mutationId,
      },
    }
  );
  if (!res.ok) {
    throw new ApiError(res.status, await parseErrorResponse(res));
  }
}
