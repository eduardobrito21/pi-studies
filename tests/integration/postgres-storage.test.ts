import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { z } from "zod";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
  createSession,
  type ConversationId,
  type SubmissionId,
  type StorageWrite,
  type Seq,
  type EntryId,
  type TaskId as PiTaskId,
  type DocumentId,
} from "@earendil-works/pi-durable";
import {
  createExpectAssertions,
  createStorageConformance,
} from "@earendil-works/pi-durable/testing";
import { PostgresStorage } from "../../server/postgres-storage";

type TaskId = PiTaskId<import("@earendil-works/chord").JsonValue>;

const context = BACKGROUND_CONTEXT;

const root = ROOT_CONVERSATION_ID;

const testUrl = process.env.POSTGRES_STORAGE_TEST_URL;

if (!testUrl && process.argv.some((arg) => arg.endsWith("/postgres-storage.test.ts"))) {
  throw new Error(
    "Set POSTGRES_STORAGE_TEST_URL to local Postgres before running test:postgres-storage.",
  );
}

const localUrlSchema = z.url().refine((value) => {
  const url = new URL(value);

  return (
    ["postgres:", "postgresql:"].includes(url.protocol) &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  );
}, "Storage tests require local PostgreSQL");

async function withDatabase(run: (url: string, pool: Pool) => Promise<void>) {
  const connectionString = localUrlSchema.parse(testUrl);
  const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  const name = `pi_storage_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  url.searchParams.delete("schema");

  const pool = new Pool({
    connectionString: url.toString(),
    max: 2,
    connectionTimeoutMillis: 5000,
  });

  let created = false;

  try {
    // Identifier is exclusively our fixed prefix and UUID hex, never an input database name.
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    created = true;

    const child = Bun.spawn(
      [process.execPath, "node_modules/prisma/build/index.js", "migrate", "deploy"],
      {
        env: { ...process.env, DATABASE_URL: url.toString() },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    if (exit !== 0) throw new Error(`Scratch migration failed: ${stdout}${stderr}`);
    await run(url.toString(), pool);
  } finally {
    await pool.end();

    try {
      if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;

  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for PostgreSQL backend state");

    await Bun.sleep(20);
  }
}

function brandedNumber<I extends number>() {
  return z
    .number()
    .int()
    .safe()
    .positive()
    .transform((value) => {
      // SAFETY: fixture sends validated positive safe numbers; callers select the erased pi brand.
      return value as I;
    });
}

const childStateSchema = z.object({
  entryId: brandedNumber<EntryId>(),
  taskId: brandedNumber<TaskId>(),
  submissionId: brandedNumber<SubmissionId>(),
  documentId: brandedNumber<DocumentId>(),
  transientEntryId: brandedNumber<EntryId>(),
  createdAt: brandedNumber<Seq>(),
  changedAt: brandedNumber<Seq>(),
});

type ChildState = z.infer<typeof childStateSchema>;

async function withOwnerProcess(
  url: string,
  mode: "idle" | "write",
  run: (child: Bun.Subprocess<"ignore", "ignore", "pipe">, state: ChildState) => Promise<void>,
) {
  const ready = Promise.withResolvers<ChildState>();

  const timeout = setTimeout(
    () => ready.reject(new Error("Owner subprocess did not become ready")),
    5000,
  );

  const child = Bun.spawn([process.execPath, "tests/fixtures/postgres-storage-owner.ts"], {
    env: { ...process.env, STORAGE_CHILD_URL: url, STORAGE_CHILD_MODE: mode },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    ipc(message) {
      const parsed = childStateSchema.safeParse(message);

      if (parsed.success) ready.resolve(parsed.data);
      else ready.reject(parsed.error);
    },
  });

  const stderr = new Response(child.stderr).text();

  void child.exited.then(async (code) => {
    ready.reject(new Error(`Owner subprocess exited (${code}): ${await stderr}`));
  });

  try {
    const state = await ready.promise;

    clearTimeout(timeout);
    await run(child, state);
  } finally {
    clearTimeout(timeout);
    child.kill("SIGKILL");
    await child.exited;
    await stderr;
  }
}

// Register every case from the installed, pinned release without filtering or altering assertions.
const conformanceCases = createStorageConformance({
  assertions: createExpectAssertions(expect),
  withStorage: (use) =>
    withDatabase(async (url) => {
      const storage = await PostgresStorage.open(url);

      try {
        await use(storage);
      } finally {
        await storage.close(context);
      }
    }),
});

describe.skipIf(!testUrl)("PostgresStorage on PostgreSQL", () => {
  for (const conformance of conformanceCases) {
    test(conformance.name, conformance.run, 30_000);
  }

  test("persists records and unused allocations across close/reopen; serializes admissions and drains close", async () => {
    await withDatabase(async (url) => {
      const storage = await PostgresStorage.open(url);
      let reopened: PostgresStorage | undefined;

      try {
        await storage.commit([{ type: "conversation", value: { id: root } }], context);

        const [id, taskId, unused] = await Promise.all([
          storage.mintId<EntryId>(),
          storage.mintId<TaskId>(),
          storage.mintId<EntryId>(),
        ]);

        expect([Number(id), Number(taskId), Number(unused)]).toEqual([2, 3, 4]);
        const unusedDocId = await storage.mintId<DocumentId>();
        const entry = { id, conversationId: root, kind: "note", data: { value: "admitted" } };

        const commit = storage.commit(
          [
            { type: "entry", value: entry },
            {
              type: "task",
              value: {
                id: taskId,
                conversationId: root,
                kind: "task",
                version: 1,
                input: {},
                state: { status: "running", checkpoint: { phase: "effect" } },
                background: false,
                abortRequested: false,
              },
            },
          ],
          context,
        );

        entry.data.value = "mutation before queue starts";
        const read = storage.entry(id, context);
        const closing = storage.close(context);
        expect(storage.close(context)).toBe(closing);
        const seq = await commit;
        expect((await read)?.entry.data).toEqual({ value: "admitted" });
        await closing;
        await expect(storage.mintId()).rejects.toThrow("closed");
        await expect(storage.document(unusedDocId, "current", context)).rejects.toThrow("closed");
        await expect(
          storage.scanEntries({ conversationId: root }, 1, undefined, context),
        ).rejects.toThrow("closed");
        reopened = await PostgresStorage.open(url);
        expect((await reopened.entry(id, context))?.commitSeq).toBe(seq);
        expect((await reopened.task(taskId, context))?.state).toEqual({
          status: "running",
          checkpoint: { phase: "effect" },
        });
        expect(Number(await reopened.mintId())).toBe(6);
      } finally {
        await storage.close(context);
        await reopened?.close(context);
      }
    });
  }, 30_000);

  test("rolls back SQL failures after table mutations, ID claims, and sequence allocation", async () => {
    await withDatabase(async (url, pool) => {
      const storage = await PostgresStorage.open(url);

      try {
        const seq = await storage.commit([{ type: "conversation", value: { id: root } }], context);

        const taskId = await storage.mintId<TaskId>();
        const entryId = await storage.mintId<EntryId>();
        const docId = await storage.mintId<DocumentId>();

        const task = {
          id: taskId,
          conversationId: root,
          kind: "original",
          version: 1,
          input: {},
          state: { status: "pending", checkpoint: { phase: "ready" } } as const,
          background: false,
          abortRequested: false,
        };

        await storage.commit([{ type: "task", value: task }], context);
        // Fails during document SQL, after the preceding task and entry have been written.
        await pool.query(
          `CREATE FUNCTION agent.reject_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected revision failure'; END $$; CREATE TRIGGER reject_revision BEFORE INSERT ON agent.document_revisions FOR EACH ROW EXECUTE FUNCTION agent.reject_revision()`,
        );

        const before = (await pool.query("SELECT next_id, next_seq FROM agent.durable_metadata"))
          .rows;

        await expect(
          storage.commit(
            [
              { type: "task", value: { ...task, kind: "transient" } },
              { type: "entry", value: { id: entryId, conversationId: root, kind: "transient" } },
              {
                type: "document.create",
                record: { id: docId, kind: "doc", scope: { kind: "session" } },
                content: { kind: "base", version: 1, value: {} },
              },
            ],
            context,
          ),
        ).rejects.toThrow("Injected revision failure");
        expect(await storage.task(taskId, context)).toEqual(task);
        expect(await storage.entry(entryId, context)).toBeUndefined();
        expect(await storage.document(docId, "current", context)).toBeUndefined();
        expect(
          (await pool.query("SELECT next_id, next_seq FROM agent.durable_metadata")).rows,
        ).toEqual(before);
        expect(
          (
            await pool.query("SELECT id FROM agent.record_ids WHERE id IN ($1, $2)", [
              entryId,
              docId,
            ])
          ).rows,
        ).toEqual([]);
        await pool.query(
          "DROP TRIGGER reject_revision ON agent.document_revisions; DROP FUNCTION agent.reject_revision()",
        );

        const recovered = await storage.commit(
          [{ type: "entry", value: { id: entryId, conversationId: root, kind: "recovered" } }],
          context,
        );

        expect(Number(recovered)).toBe(seq + 2);
        await expect(
          storage.commit(
            [
              {
                type: "entry",
                value: { id: entryId, conversationId: root, kind: "replacement" },
              },
            ],
            context,
          ),
        ).rejects.toThrow("already belongs to entry");
        const numericCollision = z.number().int().safe().positive().parse(entryId);
        // SAFETY: deliberately rebrand a valid numeric ID to test cross-type ownership rejection.
        const collisionId = numericCollision as TaskId;
        await expect(
          storage.commit(
            [
              { type: "task", value: { ...task, kind: "valid" } },
              { type: "task", value: { ...task, id: collisionId } },
            ],
            context,
          ),
        ).rejects.toThrow("already belongs to entry");
        expect(await storage.task(taskId, context)).toEqual(task);
      } finally {
        await storage.close(context);
      }
    });
  }, 30_000);

  test("preserves NUL, lone surrogates, escape literals, empty and long indexed identities", async () => {
    await withDatabase(async (url) => {
      const storage = await PostgresStorage.open(url);

      try {
        await storage.commit([{ type: "conversation", value: { id: root } }], context);

        for (const identity of [
          "\u0000",
          "\ud800",
          "\ud801",
          "\\ud800",
          "",
          randomUUID().repeat(512),
        ]) {
          const taskId = await storage.mintId<TaskId>();

          const requestId =
            await storage.mintId<import("@earendil-works/pi-durable").SubmissionId>();

          const docId = await storage.mintId<DocumentId>();
          const address = { kind: identity, key: identity, scope: { kind: "session" } as const };
          await storage.commit(
            [
              {
                type: "task",
                value: {
                  id: taskId,
                  conversationId: root,
                  kind: identity,
                  version: 1,
                  input: {},
                  state: { status: "pending", checkpoint: { phase: "ready" } },
                  background: false,
                  abortRequested: false,
                },
              },
              {
                type: "submission",
                value: {
                  id: requestId,
                  conversationId: root,
                  requestId: identity,
                  type: "input",
                  status: "queued",
                },
              },
              {
                type: "document.create",
                record: { id: docId, ...address },
                content: { kind: "base", version: 1, value: { identity } },
              },
            ],
            context,
          );
          expect(
            (await storage.scanTasks({ kind: identity }, 10, undefined, context)).items.map(
              (item) => item.id,
            ),
          ).toEqual([taskId]);
          expect((await storage.submissionByRequest(root, identity, context))?.id).toBe(requestId);
          expect((await storage.findDocument(address, "current", context))?.id).toBe(docId);
          expect(
            (
              await storage.scanDocuments(
                { scope: address.scope, at: "current", kind: identity },
                10,
                undefined,
                context,
              )
            ).items.map((item) => item.id),
          ).toEqual([docId]);
          expect((await storage.document(docId, "current", context))?.value).toEqual({
            identity,
          });
        }
      } finally {
        await storage.close(context);
      }
    });
  }, 30_000);

  test("checks bigint limits before conversion and persists exhausted ID/sequence sentinels", async () => {
    await withDatabase(async (url, pool) => {
      await pool.query(
        "UPDATE agent.durable_metadata SET next_id = 9007199254740991, next_seq = 9007199254740991",
      );
      const storage = await PostgresStorage.open(url);

      try {
        expect(Number(await storage.mintId())).toBe(Number.MAX_SAFE_INTEGER);
        await expect(storage.mintId()).rejects.toThrow("ID space is exhausted");
        expect(Number(await storage.commit([], context))).toBe(Number.MAX_SAFE_INTEGER);
        await expect(storage.commit([], context)).rejects.toThrow("Unsafe PostgreSQL counter");
        expect(
          (await pool.query("SELECT next_id, next_seq FROM agent.durable_metadata")).rows,
        ).toEqual([{ next_id: "9007199254740992", next_seq: "9007199254740992" }]);
      } finally {
        await storage.close(context);
      }

      const reopened = await PostgresStorage.open(url);

      try {
        await expect(reopened.mintId()).rejects.toThrow("ID space is exhausted");
      } finally {
        await reopened.close(context);
      }
    });
  }, 30_000);

  test("rejects a second owner, fails closed on backend loss, and permits explicit reopen", async () => {
    await withDatabase(async (url, pool) => {
      const storage = await PostgresStorage.open(url);
      let reopened: PostgresStorage | undefined;

      try {
        await storage.commit([{ type: "conversation", value: { id: root } }], context);
        await expect(PostgresStorage.open(url)).rejects.toThrow("active owner");
        await waitUntil(
          async () =>
            (
              await pool.query(
                "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()",
              )
            ).rowCount === 1,
        );

        const lock = await pool.query<{ pid: number }>(
          "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = 1885955190 AND objid = 1 AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
        );

        expect(lock.rows).toHaveLength(1);
        await pool.query("SELECT pg_terminate_backend($1)", [lock.rows[0].pid]);
        await expect(storage.commit([], context)).rejects.toThrow();
        await expect(storage.conversation(root, context)).rejects.toThrow("connection lost");
        await storage.close(context);
        reopened = await PostgresStorage.open(url);
        expect(await reopened.conversation(root, context)).toEqual({ id: root });
      } finally {
        await storage.close(context);
        await reopened?.close(context);
      }

      expect(
        (
          await pool.query(
            "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = 1885955190 AND objid = 1 AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
          )
        ).rows,
      ).toEqual([]);
    });
  }, 30_000);

  test("every Storage operation rejects after close, including both entry overloads", async () => {
    await withDatabase(async (url) => {
      const storage = await PostgresStorage.open(url);
      const entryId = await storage.mintId<EntryId>();
      const taskId = await storage.mintId<TaskId>();
      const submissionId = await storage.mintId<SubmissionId>();
      const documentId = await storage.mintId<DocumentId>();
      const scope = { kind: "session" } as const;

      await storage.close(context);

      const operations = [
        () => storage.commit([], context),
        () => storage.mintId(),
        () => storage.conversation(root, context),
        () => storage.scanConversations({}, 1, undefined, context),
        () => storage.entry(entryId, context),
        () => storage.entry(root, entryId, context),
        () => storage.findLatestHeadMarker(root, undefined, context),
        () => storage.scanEntries({ conversationId: root }, 1, undefined, context),
        () => storage.task(taskId, context),
        () => storage.scanTasks({}, 1, undefined, context),
        () => storage.submission(submissionId, context),
        () => storage.scanSubmissions({}, 1, undefined, context),
        () => storage.submissionByRequest(root, "request", context),
        () => storage.findDocument({ kind: "document", scope }, "current", context),
        () => storage.document(documentId, "current", context),
        () => storage.scanDocuments({ scope, at: "current" }, 1, undefined, context),
      ];

      for (const operation of operations) await expect(operation()).rejects.toThrow("closed");

      await storage.close(context);
    });
  }, 30_000);

  test("concurrent admissions allocate unique IDs/sequences and recover the queue after a failed batch", async () => {
    await withDatabase(async (url) => {
      const storage = await PostgresStorage.open(url);

      try {
        await storage.commit([{ type: "conversation", value: { id: root } }], context);

        const ids = await Promise.all(Array.from({ length: 32 }, () => storage.mintId<EntryId>()));

        expect(new Set(ids).size).toBe(ids.length);

        const writes: StorageWrite[][] = ids.map((id) => [
          { type: "entry", value: { id, conversationId: root, kind: "concurrent" } },
        ]);

        const commits = writes.map((batch) => storage.commit(batch, context));
        const failed = storage.commit([{ type: "conversation", value: { id: root } }], context);
        const failureCheck = expect(failed).rejects.toThrow("already belongs");
        const afterFailure = storage.commit([], context);
        const sequences = await Promise.all(commits);

        await failureCheck;
        expect(new Set(sequences).size).toBe(sequences.length);
        expect(sequences.map(Number)).toEqual(Array.from({ length: 32 }, (_, index) => index + 2));
        expect(Number(await afterFailure)).toBe(34);

        for (let index = 0; index < ids.length; index++) {
          expect((await storage.entry(ids[index], context))?.commitSeq).toBe(sequences[index]);
        }
      } finally {
        await storage.close(context);
      }
    });
  }, 30_000);

  test("Session serializes request lookup/admission per conversation and reacquires requests after restart", async () => {
    await withDatabase(async (url) => {
      const storage = await PostgresStorage.open(url);
      let session = createSession(storage);

      try {
        await storage.commit([{ type: "conversation", value: { id: root } }], context);

        const other = await session.commit(
          (tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
          context,
        );

        const admit = (conversationId: ConversationId, requestId: string) =>
          session.commit(async (tx) => {
            const existing = await tx.submissionByRequest(conversationId, requestId);

            return (
              existing ??
              (await tx.createSubmission({
                conversationId,
                requestId,
                type: "input",
                status: "queued",
              }))
            );
          }, context);

        const requests = await Promise.all(
          Array.from({ length: 16 }, () => admit(root, "same\u0000\ud800")),
        );

        expect(new Set(requests.map((item) => item.id)).size).toBe(1);
        const otherRequest = await admit(other.id, "same\u0000\ud800");

        expect(otherRequest.id).not.toBe(requests[0].id);
        expect((await storage.scanSubmissions({}, 10, undefined, context)).items).toHaveLength(2);
        await session.close(context);
        const reopened = await PostgresStorage.open(url);

        session = createSession(reopened);
        expect(await admit(root, "same\u0000\ud800")).toEqual(requests[0]);
        expect(await admit(other.id, "same\u0000\ud800")).toEqual(otherRequest);
        expect((await reopened.scanSubmissions({}, 10, undefined, context)).items).toHaveLength(2);
      } finally {
        await session.close(context);
      }
    });
  }, 30_000);

  test("exact text distinguishes forced hash-bucket collisions in every indexed identity", async () => {
    await withDatabase(async (url, pool) => {
      // Scratch-only collision injection: all encoded strings share a bucket. Rebuild
      // scratch hash indexes with that function and resolve query md5 through the same search path.
      // Production migration and pg_catalog.md5 remain unchanged.
      await pool.query(`CREATE FUNCTION agent.md5(text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT repeat('0', 32) $$;
        DROP INDEX agent.tasks_by_kind;
        CREATE INDEX tasks_by_kind ON agent.tasks ((agent.md5(kind) COLLATE "C"), id);
        DROP INDEX agent.submissions_by_request;
        CREATE INDEX submissions_by_request ON agent.submissions (conversation_id, (agent.md5(request_id) COLLATE "C")) WHERE request_id IS NOT NULL;
        DROP INDEX agent.documents_by_address;
        CREATE INDEX documents_by_address ON agent.documents ((agent.md5(kind) COLLATE "C"), scope_kind, owner_id, family, (agent.md5(key_value) COLLATE "C"), created_at DESC, retired_at);
        DROP INDEX agent.documents_by_scope_kind;
        CREATE INDEX documents_by_scope_kind ON agent.documents (scope_kind, owner_id, (agent.md5(kind) COLLATE "C"), id)`);
      const collisionUrl = new URL(url);

      collisionUrl.searchParams.set("options", "-c search_path=agent,pg_catalog");
      const storage = await PostgresStorage.open(collisionUrl.toString());

      try {
        await storage.commit([{ type: "conversation", value: { id: root } }], context);
        const identities = ["first", "second\u0000\ud800"];
        const scope = { kind: "session" } as const;
        const created = [];

        for (const identity of identities) {
          const taskId = await storage.mintId<TaskId>();
          const submissionId = await storage.mintId<SubmissionId>();
          const kindDocId = await storage.mintId<DocumentId>();
          const keyDocId = await storage.mintId<DocumentId>();
          const singletonId = await storage.mintId<DocumentId>();
          const emptyFamilyId = await storage.mintId<DocumentId>();

          await storage.commit(
            [
              {
                type: "task",
                value: {
                  id: taskId,
                  conversationId: root,
                  kind: identity,
                  version: 1,
                  input: {},
                  state: { status: "pending", checkpoint: { phase: "ready" } },
                  background: false,
                  abortRequested: false,
                },
              },
              {
                type: "submission",
                value: {
                  id: submissionId,
                  conversationId: root,
                  requestId: identity,
                  type: "input",
                  status: "queued",
                },
              },
              {
                type: "document.create",
                record: { id: kindDocId, kind: identity, scope },
                content: { kind: "base", version: 1, value: { identity } },
              },
              {
                type: "document.create",
                record: { id: keyDocId, kind: "family", key: identity, scope },
                content: { kind: "base", version: 1, value: { identity } },
              },
              {
                type: "document.create",
                record: { id: singletonId, kind: `empty:${identity}`, scope },
                content: { kind: "base", version: 1, value: { singleton: true } },
              },
              {
                type: "document.create",
                record: { id: emptyFamilyId, kind: `empty:${identity}`, key: "", scope },
                content: { kind: "base", version: 1, value: { singleton: false } },
              },
            ],
            context,
          );
          created.push({
            identity,
            taskId,
            submissionId,
            kindDocId,
            keyDocId,
            singletonId,
            emptyFamilyId,
          });
        }

        expect(
          (
            await pool.query(
              "SELECT agent.md5($1) = agent.md5($2) AS collision",
              identities.map((identity) => JSON.stringify(identity)),
            )
          ).rows,
        ).toEqual([{ collision: true }]);

        for (const item of created) {
          expect(
            (await storage.scanTasks({ kind: item.identity }, 10, undefined, context)).items.map(
              (record) => record.id,
            ),
          ).toEqual([item.taskId]);
          expect((await storage.submissionByRequest(root, item.identity, context))?.id).toBe(
            item.submissionId,
          );
          expect(
            (await storage.findDocument({ kind: item.identity, scope }, "current", context))?.id,
          ).toBe(item.kindDocId);
          expect(
            (
              await storage.findDocument(
                { kind: "family", key: item.identity, scope },
                "current",
                context,
              )
            )?.id,
          ).toBe(item.keyDocId);
          expect(
            (
              await storage.findDocument(
                { kind: `empty:${item.identity}`, scope },
                "current",
                context,
              )
            )?.id,
          ).toBe(item.singletonId);
          expect(
            (
              await storage.findDocument(
                { kind: `empty:${item.identity}`, key: "", scope },
                "current",
                context,
              )
            )?.id,
          ).toBe(item.emptyFamilyId);
          expect(
            (
              await storage.scanDocuments(
                { scope, at: "current", kind: item.identity },
                10,
                undefined,
                context,
              )
            ).items.map((record) => record.id),
          ).toEqual([item.kindDocId]);
        }

        expect(await storage.submissionByRequest(root, "missing", context)).toBeUndefined();
        expect(
          await storage.findDocument({ kind: "missing", scope }, "current", context),
        ).toBeUndefined();
      } finally {
        await storage.close(context);
      }
    });
  }, 30_000);

  test("SIGKILL releases owner backend/lock and preserves all committed records and revisions", async () => {
    await withDatabase(async (url, pool) => {
      await withOwnerProcess(url, "idle", async (child, state) => {
        const owner = await pool.query<{ pid: number }>(
          "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = 1885955190 AND objid = 1 AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
        );

        expect(owner.rows).toHaveLength(1);
        await expect(PostgresStorage.open(url)).rejects.toThrow("active owner");
        child.kill("SIGKILL");
        await child.exited;
        expect(child.signalCode).toBe("SIGKILL");
        await waitUntil(
          async () =>
            (
              await pool.query("SELECT pid FROM pg_stat_activity WHERE pid = $1", [
                owner.rows[0].pid,
              ])
            ).rowCount === 0,
        );
        expect(
          (await pool.query("SELECT pid FROM pg_locks WHERE pid = $1", [owner.rows[0].pid])).rows,
        ).toEqual([]);
        const storage = await PostgresStorage.open(url);

        try {
          expect(await storage.conversation(root, context)).toEqual({ id: root });
          expect((await storage.entry(root, state.entryId, context))?.commitSeq).toBe(
            state.createdAt,
          );
          expect((await storage.findLatestHeadMarker(root, undefined, context))?.head).toBe(
            state.entryId,
          );
          expect((await storage.task(state.taskId, context))?.state).toEqual({
            status: "running",
            checkpoint: { phase: "effect", attempt: 1 },
          });
          expect((await storage.submissionByRequest(root, "crash-request", context))?.id).toBe(
            state.submissionId,
          );
          expect(
            (await storage.document(state.documentId, state.createdAt, context))?.value,
          ).toEqual({ count: 1 });
          expect((await storage.document(state.documentId, "current", context))?.value).toEqual({
            count: 2,
          });
          expect(Number(await storage.mintId())).toBe(state.transientEntryId + 1);
          expect(Number(await storage.commit([], context))).toBe(state.changedAt + 1);
        } finally {
          await storage.close(context);
        }
      });
    });
  }, 30_000);

  test("SIGKILL during a late mixed transaction rolls back records, indexes, claims and sequence", async () => {
    await withDatabase(async (url, pool) => {
      const blocker = await pool.connect();

      try {
        await blocker.query("SELECT pg_advisory_lock(1885955191, 1)");
        await withOwnerProcess(url, "write", async (child, state) => {
          const owner = await pool.query<{ pid: number }>(
            "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = 1885955190 AND objid = 1 AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
          );

          const before = (await pool.query("SELECT next_id, next_seq FROM agent.durable_metadata"))
            .rows;

          await pool.query(`CREATE FUNCTION agent.block_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(1885955191, 1); RETURN NEW; END $$;
            CREATE TRIGGER block_revision BEFORE INSERT ON agent.document_revisions FOR EACH ROW EXECUTE FUNCTION agent.block_revision()`);
          child.send("write");
          // Waiting on this trigger proves the preceding task/submission/entry SQL actually ran.
          await waitUntil(
            async () =>
              (
                await pool.query(
                  "SELECT pid FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND classid = 1885955191 AND objid = 1 AND NOT granted",
                  [owner.rows[0].pid],
                )
              ).rowCount === 1,
          );
          child.kill("SIGKILL");
          await child.exited;
          expect(child.signalCode).toBe("SIGKILL");
          // PostgreSQL is waiting inside the trigger; release it so it can detect the dead socket.
          await blocker.query("SELECT pg_advisory_unlock(1885955191, 1)");
          await waitUntil(
            async () =>
              (
                await pool.query("SELECT pid FROM pg_stat_activity WHERE pid = $1", [
                  owner.rows[0].pid,
                ])
              ).rowCount === 0,
          );
          expect(
            (await pool.query("SELECT pid FROM pg_locks WHERE pid = $1", [owner.rows[0].pid])).rows,
          ).toEqual([]);
          expect(
            (await pool.query("SELECT next_id, next_seq FROM agent.durable_metadata")).rows,
          ).toEqual(before);
          expect(
            (
              await pool.query("SELECT id FROM agent.record_ids WHERE id = $1", [
                state.transientEntryId,
              ])
            ).rows,
          ).toEqual([]);
          await pool.query(
            "DROP TRIGGER block_revision ON agent.document_revisions; DROP FUNCTION agent.block_revision()",
          );
          const storage = await PostgresStorage.open(url);

          try {
            expect((await storage.task(state.taskId, context))?.state).toEqual({
              status: "running",
              checkpoint: { phase: "effect", attempt: 1 },
            });
            expect(
              (await storage.scanTasks({ kind: "uncommitted.task" }, 10, undefined, context)).items,
            ).toEqual([]);
            expect(
              (await storage.submissionByRequest(root, "crash-request", context))?.status,
            ).toBe("placed");
            expect(
              await storage.submissionByRequest(root, "uncommitted-request", context),
            ).toBeUndefined();
            expect(await storage.entry(state.transientEntryId, context)).toBeUndefined();
            expect((await storage.document(state.documentId, "current", context))?.value).toEqual({
              count: 2,
            });
            expect(Number(await storage.commit([], context))).toBe(state.changedAt + 1);
          } finally {
            await storage.close(context);
          }
        });
      } finally {
        await blocker.query("SELECT pg_advisory_unlock_all()");
        blocker.release();
      }
    });
  }, 30_000);

  test("historical document pagination survives replacement/reopen and returns detached records", async () => {
    await withDatabase(async (url, pool) => {
      let storage = await PostgresStorage.open(url);

      try {
        await storage.commit([{ type: "conversation", value: { id: root } }], context);
        const scope = { kind: "conversation", conversationId: root } as const;

        const ids = await Promise.all(
          Array.from({ length: 3 }, () => storage.mintId<DocumentId>()),
        );

        const records = ids.map(
          (id, index) =>
            ({
              id,
              kind: "history",
              key: String(index),
              scope,
              history: "rewindable",
              fork: "asOf",
            }) as const,
        );

        const createdAt = await storage.commit(
          records.map((record, index) => ({
            type: "document.create",
            record,
            content: { kind: "base", version: 1, value: { count: index } },
          })),
          context,
        );

        const first = await storage.scanDocuments(
          { scope, at: createdAt, kind: "history" },
          1,
          undefined,
          context,
        );

        expect(first.items.map((record) => record.id)).toEqual([ids[0]]);
        expect(first.next).toBeDefined();
        Object.assign(first.items[0].scope, { conversationId: -1 });
        const replacementId = await storage.mintId<DocumentId>();

        const replacedAt = await storage.commit(
          [
            { type: "document.retire", id: ids[0] },
            {
              type: "document.create",
              record: { ...records[0], id: replacementId },
              content: { kind: "base", version: 2, value: { count: 100 } },
            },
          ],
          context,
        );

        await storage.close(context);
        storage = await PostgresStorage.open(url);

        const next = await storage.scanDocuments(
          { scope, at: createdAt, kind: "history" },
          1,
          JSON.parse(JSON.stringify(first.next)),
          context,
        );

        const last = await storage.scanDocuments(
          { scope, at: createdAt, kind: "history" },
          1,
          next.next,
          context,
        );

        expect(next.items.map((record) => record.id)).toEqual([ids[1]]);
        expect(last.items.map((record) => record.id)).toEqual([ids[2]]);
        expect(last.next).toBeUndefined();
        expect((await storage.findDocument(records[0], createdAt, context))?.scope).toEqual(scope);
        expect((await storage.findDocument(records[0], replacedAt, context))?.id).toBe(
          replacementId,
        );
        expect((await storage.document(ids[0], createdAt, context))?.value).toEqual({ count: 0 });
        expect(await storage.document(ids[0], replacedAt, context)).toBeUndefined();
        expect(
          (
            await storage.scanDocuments(
              { scope, at: replacedAt, kind: "history" },
              10,
              undefined,
              context,
            )
          ).items.map((record) => record.id),
        ).toEqual([ids[1], ids[2], replacementId]);
        const read = await storage.document(replacementId, "current", context);

        if (!read) throw new Error("Expected replacement document");

        read.value.count = 999;
        Object.assign(read.record.scope, { conversationId: -1 });
        expect((await storage.document(replacementId, "current", context))?.value).toEqual({
          count: 100,
        });
        expect((await storage.document(replacementId, "current", context))?.record.scope).toEqual(
          scope,
        );
        // Current-only pruning is a PostgreSQL row-level property, not just a materialized read.
        const latestId = await storage.mintId<DocumentId>();

        await storage.commit(
          [
            {
              type: "document.create",
              record: { id: latestId, kind: "latest", scope: { kind: "session" } },
              content: { kind: "base", version: 1, value: { count: 1 } },
            },
          ],
          context,
        );
        await storage.commit(
          [
            {
              type: "document.change",
              id: latestId,
              content: { kind: "delta", version: 1, ops: [["s", ["count"], 2]] },
            },
          ],
          context,
        );
        await storage.commit(
          [
            {
              type: "document.change",
              id: latestId,
              content: { kind: "base", version: 2, value: { count: 3 } },
            },
          ],
          context,
        );
        expect(
          (
            await pool.query(
              "SELECT kind, version FROM agent.document_revisions WHERE document_id = $1",
              [latestId],
            )
          ).rows,
        ).toEqual([{ kind: "base", version: "2" }]);
        await storage.commit([{ type: "document.retire", id: latestId }], context);
        expect(
          (
            await pool.query("SELECT seq FROM agent.document_revisions WHERE document_id = $1", [
              latestId,
            ])
          ).rows,
        ).toEqual([]);
      } finally {
        await storage.close(context);
      }
    });
  }, 30_000);

  test("owner loss rejects an in-flight transaction and queued reads/writes while close drains", async () => {
    await withDatabase(async (url, pool) => {
      const storage = await PostgresStorage.open(url);
      const blocker = await pool.connect();

      try {
        await blocker.query("BEGIN");
        await blocker.query(
          "SELECT next_seq FROM agent.durable_metadata WHERE singleton = 1 FOR UPDATE",
        );

        const owner = await pool.query<{ pid: number }>(
          "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = 1885955190 AND objid = 1 AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
        );

        const results = Promise.allSettled([
          storage.commit([{ type: "conversation", value: { id: root } }], context),
          storage.conversation(root, context),
          storage.mintId(),
          storage.commit([], context),
        ]);

        const closing = storage.close(context);

        await waitUntil(
          async () =>
            (
              await pool.query(
                "SELECT pid FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'",
                [owner.rows[0].pid],
              )
            ).rowCount === 1,
        );
        await pool.query("SELECT pg_terminate_backend($1)", [owner.rows[0].pid]);
        const settled = await results;

        expect(settled.map((result) => result.status)).toEqual([
          "rejected",
          "rejected",
          "rejected",
          "rejected",
        ]);
        await closing;
        await blocker.query("ROLLBACK");
        const reopened = await PostgresStorage.open(url);

        try {
          expect(await reopened.conversation(root, context)).toBeUndefined();
          expect(Number(await reopened.mintId())).toBe(2);
          expect(Number(await reopened.commit([], context))).toBe(1);
        } finally {
          await reopened.close(context);
        }
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        await storage.close(context);
      }
    });
  }, 30_000);

  test("unsupported format initialization releases its connection and lock", async () => {
    await withDatabase(async (url, pool) => {
      await pool.query("UPDATE agent.durable_metadata SET storage_format_version = 2");
      await expect(PostgresStorage.open(url)).rejects.toThrow("Unsupported");
      await waitUntil(
        async () =>
          (
            await pool.query(
              "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()",
            )
          ).rowCount === 0,
      );
      await pool.query("UPDATE agent.durable_metadata SET storage_format_version = 1");
      const storage = await PostgresStorage.open(url);
      await storage.close(context);
    });
  }, 30_000);
});
