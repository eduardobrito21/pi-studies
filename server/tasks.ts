import { Data, Effect } from "effect";
import { Prisma, type Task as TaskRow } from "./generated/prisma/client";
import {
  createTaskSchema,
  updateTaskSchema,
  type CreateTaskInput,
  type UpdateTaskInput,
} from "../shared/tasks";

export class InvalidTaskInput extends Data.TaggedError("InvalidTaskInput")<{ message: string }> {}

export class TaskNotFound extends Data.TaggedError("TaskNotFound")<{ message: string }> {}

export class TaskStorageError extends Data.TaggedError("TaskStorageError")<{ cause: unknown }> {}

export type TaskError = InvalidTaskInput | TaskNotFound | TaskStorageError;

// A narrow query seam: Prisma implements it; tests use plain functions, not its proxy.
export interface TaskQueries {
  findMany(args: Pick<Prisma.TaskFindManyArgs, "orderBy">): PromiseLike<TaskRow[]>;
  findUniqueOrThrow(args: { where: { id: string } }): PromiseLike<TaskRow>;
  create(args: { data: Prisma.TaskCreateInput }): PromiseLike<TaskRow>;
  update(args: { where: { id: string }; data: Prisma.TaskUpdateInput }): PromiseLike<TaskRow>;
  delete(args: { where: { id: string } }): PromiseLike<TaskRow>;
}

// Promise-based Prisma lives at the boundary. Its failures become typed effects.
function query<A>(run: () => PromiseLike<A>) {
  return Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) =>
      cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2025"
        ? new TaskNotFound({ message: "Task not found" })
        : new TaskStorageError({ cause }),
  });
}

// Effects are lazy: constructing an operation does not touch the database.
// Both HTTP routes and future agent tools must run the same validated operations.
export function createTaskService(db: { task: TaskQueries }) {
  return {
    listTasks() {
      return query(() => db.task.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] }));
    },
    getTask(id: string) {
      return query(() => db.task.findUniqueOrThrow({ where: { id } }));
    },
    createTask(input: CreateTaskInput) {
      return Effect.gen(function* () {
        const result = createTaskSchema.safeParse(input);

        if (!result.success) {
          return yield* new InvalidTaskInput({
            message: result.error.issues.map((issue) => issue.message).join("; "),
          });
        }

        return yield* query(() => db.task.create({ data: result.data }));
      });
    },
    updateTask(id: string, input: UpdateTaskInput) {
      return Effect.gen(function* () {
        const result = updateTaskSchema.safeParse(input);

        if (!result.success) {
          return yield* new InvalidTaskInput({
            message: result.error.issues.map((issue) => issue.message).join("; "),
          });
        }

        return yield* query(() => db.task.update({ where: { id }, data: result.data }));
      });
    },
    deleteTask(id: string) {
      return query(() => db.task.delete({ where: { id } }));
    },
  };
}

export type TaskService = ReturnType<typeof createTaskService>;
