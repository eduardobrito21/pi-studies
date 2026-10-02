import { z } from "zod";
import {
  taskSchema,
  taskListSchema,
  type CreateTaskInput,
  type UpdateTaskInput,
} from "../../shared/tasks";

const errorSchema = z.object({ error: z.string() });

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });

  if (!response.ok) {
    const result = errorSchema.safeParse(await response.json().catch(() => null));
    throw new Error(result.success ? result.data.error : `Request failed (${response.status})`);
  }

  return response;
}

export const api = {
  list: async () => taskListSchema.parse(await (await request("/tasks")).json()),
  create: async (data: CreateTaskInput) =>
    taskSchema.parse(
      await (
        await request("/tasks", {
          method: "POST",
          body: JSON.stringify(data),
        })
      ).json(),
    ),
  update: async (id: string, data: UpdateTaskInput) =>
    taskSchema.parse(
      await (
        await request(`/tasks/${id}`, {
          method: "PATCH",
          body: JSON.stringify(data),
        })
      ).json(),
    ),
  delete: async (id: string) => {
    await request(`/tasks/${id}`, { method: "DELETE" });
  },
};
