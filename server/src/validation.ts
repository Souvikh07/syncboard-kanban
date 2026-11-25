import { z } from "zod";
import { COLUMN_IDS, PRIORITIES, type ColumnId, type Priority } from "@kanban/shared";

const columnIdSchema = z.enum(COLUMN_IDS as [ColumnId, ...ColumnId[]]);
const prioritySchema = z.enum(PRIORITIES as [Priority, ...Priority[]]);

export const createTaskSchema = z
  .object({
    title: z.string().trim().min(1, "Title is required").max(200, "Title must be <= 200 chars"),
    description: z.string().max(5000, "Description must be <= 5000 chars").optional().default(""),
    priority: prioritySchema.optional().default("medium"),
    assignee: z.string().trim().max(100, "Assignee must be <= 100 chars").optional().default(""),
    status: columnIdSchema.optional().default("backlog"),
    position: z.number().finite().optional(),
  })
  .strict();

export const updateTaskSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, "Title cannot be empty")
      .max(200, "Title must be <= 200 chars")
      .optional(),
    description: z.string().max(5000, "Description must be <= 5000 chars").optional(),
    priority: prioritySchema.optional(),
    assignee: z.string().trim().max(100, "Assignee must be <= 100 chars").optional(),
    status: columnIdSchema.optional(),
    position: z.number().finite().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided for update",
  });
