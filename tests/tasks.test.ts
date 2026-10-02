import { describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";
import request from "supertest";
import { Prisma } from "../server/generated/prisma/client";
import { createApp } from "../server/app";
import {
  createTaskService,
  InvalidTaskInput,
  TaskNotFound,
  TaskStorageError,
  type TaskQueries,
} from "../server/tasks";
import { createTaskSchema, taskSchema, updateTaskSchema } from "../shared/tasks";

const row = {
  id: "task-1",
  title: "Learn tools",
  description: "",
  assignee: "",
  status: "TRIAGE",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
} satisfies Prisma.TaskGetPayload<{}>;

// Test the real Effect service and HTTP routes through a typed query seam.
// No module mocking and no database connection.
function fixture() {
  const list = mock<TaskQueries["findMany"]>(async () => [row]);
  const get = mock<TaskQueries["findUniqueOrThrow"]>(async () => row);
  const create = mock<TaskQueries["create"]>(async () => row);
  const update = mock<TaskQueries["update"]>(async () => row);
  const remove = mock<TaskQueries["delete"]>(async () => row);

  const tasks = createTaskService({
    task: {
      findMany: list,
      findUniqueOrThrow: get,
      create,
      update,
      delete: remove,
    },
  });

  return { tasks, app: createApp(tasks), list, get, create, update, remove };
}

describe("Zod task contracts", () => {
  test("defaults to triage and trims title/assignee", () => {
    expect(createTaskSchema.parse({ title: "  Learn tools  ", assignee: "  Me  " })).toEqual({
      title: "Learn tools",
      description: "",
      assignee: "Me",
      status: "TRIAGE",
    });
  });

  test("rejects blank titles, unknown fields, and invalid statuses", () => {
    expect(createTaskSchema.safeParse({ title: "  " }).success).toBe(false);
    expect(createTaskSchema.safeParse({ title: "Task", priority: 1 }).success).toBe(false);
    expect(createTaskSchema.safeParse({ title: "Task", status: "SHIPPED" }).success).toBe(false);
  });

  test("rejects oversized fields and empty updates", () => {
    expect(createTaskSchema.safeParse({ title: "x".repeat(201) }).success).toBe(false);
    expect(
      createTaskSchema.safeParse({ title: "Task", description: "x".repeat(10001) }).success,
    ).toBe(false);
    expect(createTaskSchema.safeParse({ title: "Task", assignee: "x".repeat(101) }).success).toBe(
      false,
    );
    expect(updateTaskSchema.safeParse({}).success).toBe(false);
  });

  test("accepts status-only moves and clearing optional fields", () => {
    expect(updateTaskSchema.parse({ status: "DONE" })).toEqual({ status: "DONE" });
    expect(updateTaskSchema.parse({ description: "", assignee: "" })).toEqual({
      description: "",
      assignee: "",
    });
  });

  test("validates serialized task responses", () => {
    expect(
      taskSchema.safeParse({
        ...row,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }).success,
    ).toBe(true);
    expect(taskSchema.safeParse({ ...row, createdAt: "bad date" }).success).toBe(false);
  });
});

describe("Effect task operations", () => {
  test("construction is lazy; execution applies Zod defaults", async () => {
    const { tasks, create } = fixture();
    const operation = tasks.createTask({ title: "  Learn tools  " });

    expect(create).not.toHaveBeenCalled();
    expect(await Effect.runPromise(operation)).toEqual(row);
    expect(create).toHaveBeenCalledWith({
      data: { title: "Learn tools", description: "", assignee: "", status: "TRIAGE" },
    });
  });

  test("invalid input fails before querying the database", async () => {
    const { tasks, create } = fixture();
    const result = await Effect.runPromise(Effect.flip(tasks.createTask({ title: " " })));

    expect(result).toBeInstanceOf(InvalidTaskInput);
    expect(create).not.toHaveBeenCalled();
  });

  test("status-only updates do not replace other fields", async () => {
    const { tasks, update } = fixture();

    await Effect.runPromise(tasks.updateTask(row.id, { status: "DONE" }));
    expect(update).toHaveBeenCalledWith({ where: { id: row.id }, data: { status: "DONE" } });
  });

  test("empty updates fail before querying", async () => {
    const { tasks, update } = fixture();

    expect(await Effect.runPromise(Effect.flip(tasks.updateTask(row.id, {})))).toBeInstanceOf(
      InvalidTaskInput,
    );
    expect(update).not.toHaveBeenCalled();
  });

  test("maps Prisma missing-record failures to TaskNotFound", async () => {
    const { tasks, get } = fixture();
    get.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Missing", {
        code: "P2025",
        clientVersion: "7.10.0",
      }),
    );

    expect(await Effect.runPromise(Effect.flip(tasks.getTask("missing")))).toBeInstanceOf(
      TaskNotFound,
    );
  });

  test("maps database failures to TaskStorageError", async () => {
    const { tasks, list } = fixture();
    list.mockRejectedValue(new Error("Connection refused"));

    expect(await Effect.runPromise(Effect.flip(tasks.listTasks()))).toBeInstanceOf(
      TaskStorageError,
    );
  });
});

describe("HTTP task API", () => {
  test("lists serialized tasks", async () => {
    const { app } = fixture();
    const response = await request(app).get("/api/tasks").expect(200);

    expect(taskSchema.parse(response.body[0]).id).toBe(row.id);
  });

  test("gets one task", async () => {
    const { app, get } = fixture();

    await request(app).get("/api/tasks/task-1").expect(200);
    expect(get).toHaveBeenCalledWith({ where: { id: "task-1" } });
  });

  test("creates a task", async () => {
    const { app, create } = fixture();

    await request(app).post("/api/tasks").send({ title: "Learn tools" }).expect(201);
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("rejects invalid status and unknown fields at the real service boundary", async () => {
    const { app, update } = fixture();

    await request(app).patch("/api/tasks/task-1").send({ status: "OTHER" }).expect(400);
    await request(app).patch("/api/tasks/task-1").send({ priority: 1 }).expect(400);
    expect(update).not.toHaveBeenCalled();
  });

  test("moves a task with PATCH", async () => {
    const { app, update } = fixture();

    await request(app).patch("/api/tasks/task-1").send({ status: "BACKLOG" }).expect(200);
    expect(update).toHaveBeenCalledWith({ where: { id: "task-1" }, data: { status: "BACKLOG" } });
  });

  test("deletes a task with no response body", async () => {
    const { app, remove } = fixture();
    const response = await request(app).delete("/api/tasks/task-1").expect(204);

    expect(response.text).toBe("");
    expect(remove).toHaveBeenCalledWith({ where: { id: "task-1" } });
  });

  test("returns 404 for missing records", async () => {
    const { app, remove } = fixture();
    remove.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Missing", {
        code: "P2025",
        clientVersion: "7.10.0",
      }),
    );

    await request(app).delete("/api/tasks/missing").expect(404, { error: "Task not found" });
  });

  test("handles malformed JSON and oversized requests", async () => {
    const { app } = fixture();

    await request(app)
      .post("/api/tasks")
      .set("Content-Type", "application/json")
      .send("{")
      .expect(400);
    await request(app)
      .post("/api/tasks")
      .send({ title: "x".repeat(70000) })
      .expect(413);
  });

  test("returns JSON for unknown routes", async () => {
    const { app } = fixture();

    await request(app).get("/api/missing").expect(404, { error: "Not found" });
  });
});
