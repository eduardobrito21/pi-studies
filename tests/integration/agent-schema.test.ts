import { describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { Effect } from "effect";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../server/generated/prisma/client";
import { createTaskService } from "../../server/tasks";
import { z } from "zod";

const agentMigration = "20261002220000_agent_state";

if (
  !process.env.AGENT_SCHEMA_TEST_URL &&
  process.argv.some((arg) => arg.endsWith("/agent-schema.test.ts"))
) {
  throw new Error("Set AGENT_SCHEMA_TEST_URL to local Postgres before running test:agent-schema.");
}

const localDatabaseUrlSchema = z.url().refine((value) => {
  const url = new URL(value);

  return (
    ["postgres:", "postgresql:"].includes(url.protocol) &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  );
}, "Integration tests require local PostgreSQL");

async function runPrisma(url: string, args: string[]) {
  const child = Bun.spawn([process.execPath, "node_modules/prisma/build/index.js", ...args], {
    env: { ...process.env, DATABASE_URL: url },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { output: stdout + stderr, exitCode };
}

async function deploy(url: string) {
  const result = await runPrisma(url, ["migrate", "deploy"]);

  expect(result.exitCode).toBe(0);

  return result.output;
}

// Opt-in real PostgreSQL tests. Never reset the user's board or agent schema.
// The supplied local URL is used only to create/drop randomly named scratch databases.
async function withScratchDatabase(run: (pool: Pool, url: string) => Promise<void>) {
  const connectionString = localDatabaseUrlSchema.parse(process.env.AGENT_SCHEMA_TEST_URL);
  const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  const name = `pi_agent_schema_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(connectionString);

  url.pathname = `/${name}`;
  url.searchParams.delete("schema");

  const pool = new Pool({
    connectionString: url.toString(),
    max: 3,
    connectionTimeoutMillis: 5000,
  });

  let created = false;

  try {
    // Identifiers cannot use $1. This name contains only our fixed prefix and UUID hex.
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    created = true;
    await run(pool, url.toString());
  } finally {
    await pool.end();

    try {
      if (created) {
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      }
    } finally {
      await admin.end();
    }
  }
}

async function claim(pool: Pool, id: number, type: string) {
  await pool.query("INSERT INTO agent.record_ids (id, record_type) VALUES ($1, $2)", [id, type]);
}

describe.skipIf(!process.env.AGENT_SCHEMA_TEST_URL)(
  "agent schema via Prisma Migrate on PostgreSQL",
  () => {
    test("empty database deployment applies both migrations and repeated deploy preserves state", async () => {
      await withScratchDatabase(async (pool, url) => {
        expect(await deploy(url)).toContain(agentMigration);
        expect(await deploy(url)).toContain("No pending migrations");

        const tables = await pool.query<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'agent' ORDER BY table_name",
        );

        const metadata = await pool.query<{
          next_id: string;
          next_seq: string;
          storage_format_version: number;
        }>(
          "SELECT next_id, next_seq, storage_format_version FROM agent.durable_metadata WHERE singleton = 1",
        );

        const indexes = await pool.query<{ indexname: string }>(
          "SELECT indexname FROM pg_indexes WHERE schemaname = 'agent'",
        );

        const history = await pool.query<{ migration_name: string }>(
          "SELECT migration_name FROM public._prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name",
        );

        expect(tables.rows.map((row) => row.table_name)).toEqual([
          "conversations",
          "document_revisions",
          "documents",
          "durable_metadata",
          "entries",
          "record_ids",
          "submissions",
          "tasks",
        ]);
        expect(metadata.rows).toEqual([{ next_id: "2", next_seq: "1", storage_format_version: 1 }]);
        expect(history.rows.map((row) => row.migration_name)).toEqual([
          "20261002190000_init",
          agentMigration,
        ]);
        expect(indexes.rows.map((row) => row.indexname)).toContain("entry_heads_by_conversation");
        expect(indexes.rows.map((row) => row.indexname)).toContain("submissions_by_request");
        expect(indexes.rows.map((row) => row.indexname)).toContain("documents_by_address");
        expect(indexes.rows.map((row) => row.indexname)).toContain("document_revisions_by_kind");
        await pool.query("UPDATE agent.durable_metadata SET next_id = 42, next_seq = 9");
        await deploy(url);
        expect(
          (await pool.query("SELECT next_id, next_seq FROM agent.durable_metadata")).rows,
        ).toEqual([{ next_id: "42", next_seq: "9" }]);

        // Both schemas are represented, while native-only features stay in SQL.
        // A generated diff must not drop agent tables or alter the declared layout.
        const diff = await runPrisma(url, [
          "migrate",
          "diff",
          "--from-config-datasource",
          "--to-schema",
          "prisma/schema.prisma",
          "--exit-code",
        ]);

        expect(diff.exitCode).toBe(0);

        expect(
          (await pool.query("SELECT next_id, next_seq FROM agent.durable_metadata")).rows,
        ).toEqual([{ next_id: "42", next_seq: "9" }]);
      });
    }, 30_000);

    test("deployment leaves an existing Prisma board schema and its records unchanged", async () => {
      await withScratchDatabase(async (pool, url) => {
        const sql = await Bun.file(
          new URL("../../prisma/migrations/20261002190000_init/migration.sql", import.meta.url),
        ).text();

        await pool.query(sql);

        // Reproduce the pre-M1.2 board and its Prisma migration baseline.
        const baseline = await runPrisma(url, [
          "migrate",
          "resolve",
          "--applied",
          "20261002190000_init",
        ]);

        expect(baseline.exitCode).toBe(0);

        const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
        const tasks = createTaskService(prisma);

        try {
          await Effect.runPromise(
            tasks.createTask({
              title: "Preserve this board task",
              description: "Existing board content",
              status: "TODO",
            }),
          );

          const before = await Effect.runPromise(tasks.listTasks());

          const publicBefore = await pool.query(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
          );

          expect(await deploy(url)).toContain(agentMigration);
          expect(await Effect.runPromise(tasks.listTasks())).toEqual(before);
          expect(
            (
              await pool.query(
                "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
              )
            ).rows,
          ).toEqual(publicBefore.rows);
        } finally {
          await prisma.$disconnect();
        }
      });
    }, 30_000);

    test("encoding preserves unusual and long identities, full records, and document revisions", async () => {
      await withScratchDatabase(async (pool, url) => {
        await deploy(url);
        await claim(pool, 1, "conversation");
        await pool.query("INSERT INTO agent.conversations (id, record) VALUES (1, $1)", [
          '{"id":1}',
        ]);

        const identities = [
          "\ud800",
          "\ud801",
          "\u0000",
          "",
          "é",
          "e\u0301",
          randomBytes(4096).toString("hex"),
        ];

        let id = 2;

        for (const identity of identities) {
          const encoded = JSON.stringify(identity);
          const taskId = id++;
          const submissionId = id++;
          const documentId = id++;

          const record = JSON.stringify({
            id: taskId,
            conversationId: 1,
            kind: identity,
            version: 1,
            input: {},
            background: false,
            abortRequested: false,
            state: { status: "pending", checkpoint: { phase: "start", text: identity } },
          });

          await claim(pool, taskId, "task");
          await pool.query(
            `INSERT INTO agent.tasks
          (id, conversation_id, kind, status, abort_requested, background, record)
          VALUES ($1, 1, $2, 'pending', false, false, $3)`,
            [taskId, encoded, record],
          );
          await claim(pool, submissionId, "submission");
          await pool.query(
            `INSERT INTO agent.submissions (id, conversation_id, request_id, status, record)
          VALUES ($1, 1, $2, 'queued', $3)`,
            [
              submissionId,
              encoded,
              JSON.stringify({
                id: submissionId,
                conversationId: 1,
                requestId: identity,
                type: "input",
                status: "queued",
              }),
            ],
          );
          await claim(pool, documentId, "document");
          await pool.query(
            `INSERT INTO agent.documents
          (id, kind, family, key_value, scope_kind, owner_id, created_at, record)
          VALUES ($1, $2, true, $2, 'session', 0, 1, $3)`,
            [
              documentId,
              encoded,
              JSON.stringify({
                id: documentId,
                kind: identity,
                key: identity,
                scope: { kind: "session" },
                createdAt: 1,
              }),
            ],
          );
          await pool.query(
            `INSERT INTO agent.document_revisions (document_id, seq, kind, version, content)
          VALUES ($1, 1, 'base', 1, $2), ($1, 2, 'delta', 1, $3)`,
            [
              documentId,
              JSON.stringify({ text: identity }),
              JSON.stringify([["s", ["text"], identity]]),
            ],
          );

          const tasks = await pool.query<{ record: string }>(
            "SELECT record FROM agent.tasks WHERE md5(kind) = md5($1) AND kind = $1",
            [encoded],
          );

          const requests = await pool.query<{ id: string }>(
            `SELECT id FROM agent.submissions
          WHERE conversation_id = 1 AND md5(request_id) = md5($1) AND request_id = $1`,
            [encoded],
          );

          const documents = await pool.query<{ id: string }>(
            `SELECT id FROM agent.documents
          WHERE scope_kind = 'session' AND owner_id = 0 AND family = true
          AND md5(kind) = md5($1) AND kind = $1 AND md5(key_value) = md5($1) AND key_value = $1`,
            [encoded],
          );

          const revisions = await pool.query<{ content: string }>(
            "SELECT content FROM agent.document_revisions WHERE document_id = $1 ORDER BY seq",
            [documentId],
          );

          expect(tasks.rows).toEqual([{ record }]);
          expect(requests.rows).toEqual([{ id: String(submissionId) }]);
          expect(documents.rows).toEqual([{ id: String(documentId) }]);
          expect(JSON.parse(revisions.rows[0].content)).toEqual({ text: identity });
          expect(JSON.parse(revisions.rows[1].content)).toEqual([["s", ["text"], identity]]);
        }

        // Demonstrate why JSONB is not the serialization format for this contract.
        await expect(
          pool.query("SELECT $1::jsonb", [JSON.stringify({ value: "\ud800" })]),
        ).rejects.toThrow();
        await expect(
          pool.query("SELECT $1::jsonb", [JSON.stringify({ value: "\u0000" })]),
        ).rejects.toThrow();
      });
    }, 30_000);

    test("schema enforces global ID type ownership, immutability, valid JSON and numeric limits", async () => {
      await withScratchDatabase(async (pool, url) => {
        await deploy(url);
        await claim(pool, 1, "conversation");
        await pool.query("INSERT INTO agent.conversations (id, record) VALUES (1, $1)", [
          '{"id":1}',
        ]);
        await claim(pool, 2, "entry");
        await pool.query(
          `INSERT INTO agent.entries (id, conversation_id, commit_seq, record)
        VALUES (2, 1, 1, $1)`,
          [JSON.stringify({ id: 2, conversationId: 1, kind: "app.note" })],
        );

        await expect(
          pool.query("UPDATE agent.entries SET record = '{}' WHERE id = 2"),
        ).rejects.toThrow();
        await expect(pool.query("DELETE FROM agent.entries WHERE id = 2")).rejects.toThrow();
        await expect(
          pool.query("UPDATE agent.conversations SET record = '{}' WHERE id = 1"),
        ).rejects.toThrow();
        await expect(
          pool.query("UPDATE agent.record_ids SET record_type = 'task' WHERE id = 2"),
        ).rejects.toThrow();
        await expect(
          pool.query(`INSERT INTO agent.tasks
        (id, conversation_id, kind, status, abort_requested, background, record)
        VALUES (2, 1, '"kind"', 'pending', false, false, '{}')`),
        ).rejects.toThrow();
        await claim(pool, 3, "entry");
        await expect(
          pool.query(`INSERT INTO agent.entries (id, conversation_id, commit_seq, record)
        VALUES (3, 1, 1, 'not-json')`),
        ).rejects.toThrow();
        await expect(
          pool.query("INSERT INTO agent.record_ids VALUES (9007199254740992, 'task')"),
        ).rejects.toThrow();
        await pool.query("INSERT INTO agent.record_ids VALUES (9007199254740991, 'task')");
        await pool.query("UPDATE agent.durable_metadata SET next_id = 9007199254740992");
        await expect(
          pool.query("UPDATE agent.durable_metadata SET next_seq = 9007199254740993"),
        ).rejects.toThrow();
      });
    }, 30_000);

    test("failed mid-migration DDL rolls back and can be retried through Prisma resolve", async () => {
      await withScratchDatabase(async (pool, url) => {
        const sql = await Bun.file(
          new URL("../../prisma/migrations/20261002190000_init/migration.sql", import.meta.url),
        ).text();

        await pool.query(sql);
        expect(
          (await runPrisma(url, ["migrate", "resolve", "--applied", "20261002190000_init"]))
            .exitCode,
        ).toBe(0);
        // Fail after several agent tables have been created, not at the first statement.
        // This event trigger exists only inside this randomly named scratch database.
        await pool.query(`CREATE FUNCTION public.fail_agent_ddl() RETURNS event_trigger
          LANGUAGE plpgsql AS $$ BEGIN
            IF EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands()
              WHERE object_identity = 'agent.tasks') THEN
              RAISE EXCEPTION 'Injected migration failure';
            END IF;
          END $$;
          CREATE EVENT TRIGGER fail_agent_ddl ON ddl_command_end
            WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION public.fail_agent_ddl()`);

        const result = await runPrisma(url, ["migrate", "deploy"]);

        expect(result.exitCode).not.toBe(0);
        expect((await pool.query("SELECT to_regnamespace('agent') AS schema")).rows).toEqual([
          { schema: null },
        ]);
        expect(
          (await pool.query('SELECT count(*)::integer AS count FROM public."Task"')).rows,
        ).toEqual([{ count: 0 }]);

        await pool.query(
          "DROP EVENT TRIGGER fail_agent_ddl; DROP FUNCTION public.fail_agent_ddl()",
        );
        expect(
          (await runPrisma(url, ["migrate", "resolve", "--rolled-back", agentMigration])).exitCode,
        ).toBe(0);
        expect(await deploy(url)).toContain(agentMigration);
      });
    }, 30_000);
  },
);
