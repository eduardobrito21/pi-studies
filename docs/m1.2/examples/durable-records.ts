import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  MemoryStorage,
  ROOT_CONVERSATION_ID,
  type DocumentId,
  type EntryId,
  type SubmissionId,
  type TaskId,
  type TaskRecord,
} from "@earendil-works/pi-durable";
import { z } from "zod";

const inputSchema = z.object({ text: z.string().min(1), requestId: z.string().min(1) });

/** Offline Storage-level lesson, not a Harness, model call, or PostgreSQL adapter. */
export async function demonstrateRecords() {
  const input = inputSchema.parse({ text: "Explain durable records", requestId: "study-001" });
  const storage = new MemoryStorage();
  const context = BACKGROUND_CONTEXT;
  const conversationId = ROOT_CONVERSATION_ID;

  try {
    // The SQL migration reserves ID 1 but does not insert a root conversation.
    // Here we explicitly create it. The next minted candidate is 2.
    const rootSeq = await storage.commit(
      [{ type: "conversation", value: { id: conversationId } }],
      context,
    );

    const submissionId = await storage.mintId<SubmissionId>();
    const entryId = await storage.mintId<EntryId>();
    const taskId = await storage.mintId<TaskId<{ text: string }>>();
    const documentId = await storage.mintId<DocumentId>();

    // Admission receipt != transcript entry. A queued receipt has no entry yet.
    const admittedSeq = await storage.commit(
      [
        {
          type: "submission",
          value: {
            id: submissionId,
            conversationId,
            requestId: input.requestId,
            type: "input",
            status: "queued",
          },
        },
      ],
      context,
    );

    const task = {
      id: taskId,
      conversationId,
      kind: "study.explain",
      version: 1,
      input: { text: input.text },
      background: false,
      abortRequested: false,
      state: { status: "running", checkpoint: { phase: "explain" } },
    } satisfies TaskRecord<{ text: string }, { phase: string }, { text: string }>;

    // One commit, four related writes. Either all become visible or none do.
    const placedSeq = await storage.commit(
      [
        {
          type: "entry",
          value: {
            id: entryId,
            conversationId,
            kind: "study.user",
            data: { text: input.text },
            model: [{ role: "user", content: input.text, timestamp: 0 }],
          },
        },
        {
          type: "submission",
          value: {
            id: submissionId,
            conversationId,
            requestId: input.requestId,
            type: "input",
            status: "placed",
            entry: entryId,
          },
        },
        { type: "task", value: task },
        {
          type: "document.create",
          record: {
            id: documentId,
            kind: "study.progress",
            scope: { kind: "conversation", conversationId },
            history: "rewindable",
            fork: "asOf",
          },
          content: { kind: "base", version: 1, value: { explained: 0 } },
        },
      ],
      context,
    );

    const answerId = await storage.mintId<EntryId>();

    const doneSeq = await storage.commit(
      [
        {
          type: "entry",
          value: {
            id: answerId,
            conversationId,
            kind: "study.answer",
            byTaskId: taskId,
            data: { text: "A record is a stored typed fact about the agent." },
            // No model field: this particular entry is application-facing only.
          },
        },
        {
          type: "task",
          value: {
            ...task,
            state: {
              status: "terminal",
              outcome: {
                status: "completed",
                result: { text: "Explanation saved" },
              },
            },
          },
        },
        {
          type: "submission",
          value: {
            id: submissionId,
            conversationId,
            requestId: input.requestId,
            type: "input",
            status: "done",
            entry: entryId,
            answer: answerId,
          },
        },
        {
          type: "document.change",
          id: documentId,
          content: {
            kind: "delta",
            version: 1,
            ops: [["s", ["explained"], 1]],
          },
        },
      ],
      context,
    );

    // Rewindable state: base at placement, then base + delta at completion.
    const before = await storage.document(documentId, placedSeq, context);
    const after = await storage.document(documentId, "current", context);
    const receipt = await storage.submissionByRequest(conversationId, input.requestId, context);
    const transcript = await storage.scanEntries({ conversationId }, 10, undefined, context);

    return {
      sequences: { rootSeq, admittedSeq, placedSeq, doneSeq },
      ids: { conversationId, submissionId, entryId, taskId, documentId, answerId },
      before,
      after,
      receipt,
      transcript,
      task: await storage.task(taskId, context),
    };
  } finally {
    await storage.close(context);
  }
}

if (import.meta.main) {
  console.log(JSON.stringify(await demonstrateRecords(), null, 2));
}
