import { z } from "zod";

export const columns = [
  { status: "TRIAGE", label: "Triage" },
  { status: "BACKLOG", label: "Backlog" },
  { status: "TODO", label: "Todo" },
  { status: "IN_PROGRESS", label: "In progress" },
  { status: "DONE", label: "Done" },
] as const;

export const taskStatusSchema = z.enum(["TRIAGE", "BACKLOG", "TODO", "IN_PROGRESS", "DONE"]);

export type TaskStatus = z.infer<typeof taskStatusSchema>;

const taskFields = z.object({
  title: z.string().trim().min(1, "A title is required").max(200),
  description: z.string().max(10000),
  assignee: z.string().trim().max(100),
  status: taskStatusSchema,
});

export const createTaskSchema = taskFields
  .extend({
    description: taskFields.shape.description.default(""),
    assignee: taskFields.shape.assignee.default(""),
    status: taskStatusSchema.default("TRIAGE"),
  })
  .strict();

export const updateTaskSchema = taskFields
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Provide at least one field to update");

export type CreateTaskInput = z.input<typeof createTaskSchema>;

export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const taskSchema = taskFields.extend({
  id: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const taskListSchema = z.array(taskSchema);

export type Task = z.infer<typeof taskSchema>;
