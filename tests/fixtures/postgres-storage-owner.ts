// Subprocess-only storage fixture. It never starts a Harness or requests a model.
import { z } from "zod";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
  type EntryId,
  type TaskId,
  type SubmissionId,
  type DocumentId,
} from "@earendil-works/pi-durable";
import { PostgresStorage } from "../../server/postgres-storage";

const url = z
  .url()
  .refine((value) => {
    const parsed = new URL(value);

    return (
      ["postgres:", "postgresql:"].includes(parsed.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) &&
      /^\/pi_storage_[a-f0-9]{32}$/.test(parsed.pathname)
    );
  }, "Child fixture only accepts a local disposable storage database")
  .parse(process.env.STORAGE_CHILD_URL);

const mode = z.enum(["idle", "write"]).parse(process.env.STORAGE_CHILD_MODE);

const context = BACKGROUND_CONTEXT;

const storage = await PostgresStorage.open(url);

const root = ROOT_CONVERSATION_ID;

await storage.commit([{ type: "conversation", value: { id: root } }], context);

const entryId = await storage.mintId<EntryId>();

const taskId = await storage.mintId<TaskId<JsonValue>>();

const submissionId = await storage.mintId<SubmissionId>();

const documentId = await storage.mintId<DocumentId>();

const transientEntryId = await storage.mintId<EntryId>();

const task = {
  id: taskId,
  conversationId: root,
  kind: "crash.task",
  version: 1,
  input: { text: "persist" },
  background: false,
  abortRequested: false,
  state: { status: "running", checkpoint: { phase: "effect", attempt: 1 } } as const,
};

const createdAt = await storage.commit(
  [
    {
      type: "entry",
      value: {
        id: entryId,
        conversationId: root,
        kind: "marker",
        head: entryId,
        data: { text: "persist" },
      },
    },
    { type: "task", value: task },
    {
      type: "submission",
      value: {
        id: submissionId,
        conversationId: root,
        requestId: "crash-request",
        type: "input",
        status: "placed",
        entry: entryId,
      },
    },
    {
      type: "document.create",
      record: {
        id: documentId,
        kind: "crash.doc",
        scope: { kind: "conversation", conversationId: root },
        history: "rewindable",
        fork: "asOf",
      },
      content: { kind: "base", version: 1, value: { count: 1 } },
    },
  ],
  context,
);

const changedAt = await storage.commit(
  [
    {
      type: "document.change",
      id: documentId,
      content: { kind: "delta", version: 1, ops: [["s", ["count"], 2]] },
    },
  ],
  context,
);

// Install the command receiver before signalling readiness; the parent cannot outrun it.
const command = new Promise<void>((resolve, reject) => {
  process.once("message", (message) => {
    const parsed = z.literal("write").safeParse(message);

    if (parsed.success) resolve();
    else reject(parsed.error);
  });
});

if (!process.send) throw new Error("Storage owner fixture requires IPC");

process.send({ entryId, taskId, submissionId, documentId, transientEntryId, createdAt, changedAt });

if (mode === "write") {
  await command;
  // Parent installs a revision trigger which blocks at the last write. SIGKILL must roll back all of this batch.
  await storage.commit(
    [
      {
        type: "task",
        value: {
          ...task,
          kind: "uncommitted.task",
          state: { status: "running", checkpoint: { phase: "uncommitted", attempt: 2 } },
        },
      },
      {
        type: "submission",
        value: {
          id: submissionId,
          conversationId: root,
          requestId: "uncommitted-request",
          type: "input",
          status: "unanswered",
          reason: "failed",
        },
      },
      { type: "entry", value: { id: transientEntryId, conversationId: root, kind: "uncommitted" } },
      {
        type: "document.change",
        id: documentId,
        content: { kind: "delta", version: 1, ops: [["s", ["count"], 999]] },
      },
    ],
    context,
  );
  process.send("unexpected-commit");
}

// Intentionally no close or signal handler: tests terminate the actual owning process.
await new Promise<void>(() => {});
