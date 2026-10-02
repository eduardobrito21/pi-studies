import { createApp } from "./app";
import { db } from "./db";
import { createTaskService } from "./tasks";

const port = Number(process.env.PORT ?? 3001);

const server = createApp(createTaskService(db)).listen(port, "127.0.0.1", () => {
  console.log(`Task API: http://127.0.0.1:${port}`);
});

async function shutdown() {
  server.close(async () => {
    await db.$disconnect();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);

process.on("SIGTERM", shutdown);
