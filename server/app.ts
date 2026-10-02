import express, { type ErrorRequestHandler, type Response } from "express";
import { Effect, Match } from "effect";
import { z } from "zod";
import type { TaskError, TaskService } from "./tasks";

// The HTTP boundary runs effects and translates typed failures into responses.
// Effect.match handles expected failures; defects reach Express's error handler.
function reply<A>(program: Effect.Effect<A, TaskError>, res: Response, status = 200) {
  return Effect.runPromise(
    Effect.match(program, {
      onSuccess: (data) => (status === 204 ? res.status(204).end() : res.status(status).json(data)),
      onFailure: (error) =>
        Match.value(error).pipe(
          Match.tag("InvalidTaskInput", (error) => res.status(400).json({ error: error.message })),
          Match.tag("TaskNotFound", (error) => res.status(404).json({ error: error.message })),
          Match.tag("TaskStorageError", (error) => {
            console.error(error.cause);

            return res
              .status(500)
              .json({ error: "Could not complete the request. Check the API and database." });
          }),
          Match.exhaustive,
        ),
    }),
  );
}

export function createApp(tasks: TaskService) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.get("/api/tasks", async (_req, res) => {
    await reply(tasks.listTasks(), res);
  });
  app.get("/api/tasks/:id", async (req, res) => {
    await reply(tasks.getTask(req.params.id), res);
  });
  app.post("/api/tasks", async (req, res) => {
    await reply(tasks.createTask(req.body), res, 201);
  });
  app.patch("/api/tasks/:id", async (req, res) => {
    await reply(tasks.updateTask(req.params.id, req.body), res);
  });
  app.delete("/api/tasks/:id", async (req, res) => {
    await reply(tasks.deleteTask(req.params.id), res, 204);
  });
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));

  const bodyErrorSchema = z.object({ status: z.literal([400, 413]) });

  const handleError: ErrorRequestHandler = (cause, _req, res, _next) => {
    const result = bodyErrorSchema.safeParse(cause);

    if (result.success) {
      res
        .status(result.data.status)
        .json({ error: result.data.status === 413 ? "Request too large" : "Invalid JSON" });
    } else {
      console.error(cause);
      res.status(500).json({ error: "Unexpected API error" });
    }
  };

  app.use(handleError);

  return app;
}
