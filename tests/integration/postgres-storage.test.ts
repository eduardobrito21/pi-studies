import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { z } from "zod";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
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

// A deliberately bounded sample of the INSTALLED release, not the M1.4 full gate.
const sampleNames = new Set([
  "detaches retained writes and every returned record",
  "scans deep fork history newest-first through every ancestor cap",
  "replaces complete task records and pages filtered task scans",
  "indexes request IDs per conversation and replaces complete submission records",
  "reconstructs rewindable documents and preserves half-open incarnations",
  "copies stored document bases independently and rejects ambiguous sources",
  "uses bases for version transitions and rejects historical reads of current-only documents",
]);

const samples = createStorageConformance({
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

describe.skipIf(!testUrl)("PostgresStorage M1.3 (disposable databases)", () => {
  for (const sample of samples) {
    if (sampleNames.has(sample.name)) test(sample.name, sample.run, 30_000);
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
            [{ type: "entry", value: { id: entryId, conversationId: root, kind: "replacement" } }],
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
          expect((await storage.document(docId, "current", context))?.value).toEqual({ identity });
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

  test("unsupported format initialization releases its connection and lock", async () => {
    await withDatabase(async (url, pool) => {
      await pool.query("UPDATE agent.durable_metadata SET storage_format_version = 2");
      await expect(PostgresStorage.open(url)).rejects.toThrow("Unsupported");
      await pool.query("UPDATE agent.durable_metadata SET storage_format_version = 1");
      const storage = await PostgresStorage.open(url);
      await storage.close(context);
    });
  }, 30_000);
});
