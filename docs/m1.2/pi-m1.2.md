# M1.2 — PostgreSQL layout for durable agent state

Studying the vocabulary? See the [table-by-table study guide](pi-m1.2-study.md),
[interactive commit walkthrough](pi-m1.2-study.html), and
[runnable offline example](examples/durable-records.ts).

## One migration history, two runtime APIs

```text
Prisma Migrate → public._prisma_migrations
                   ├── public: existing Kanban board
                   └── agent: durable storage tables

Runtime, once the adapter is implemented:
  Board operations   → Effect task service → Prisma Client → public."Task"
  Durable execution  → pi-durable Storage implementation → pg → agent.*
```

Prisma **Migrate** executes SQL and tracks which migrations were applied. Prisma
**Client** is the generated API for our board model. `prisma/schema.prisma`
now describes **both public and agent tables** in one place, using readable
`Agent...` model names mapped to the actual table/column names. Using Migrate
for both schemas does not require using Client for every table.

The agent models use `@@ignore`: Prisma Migrate still includes them in its
schema model, but Client does not expose a second durable-state CRUD API. The
future `pg` adapter will own those operations. Keys, relationships, ordinary
indexes and the transcript's partial head index are visible in the Prisma
schema; the latter uses the pinned Prisma 7.10 `partialIndexes` preview feature.

The new migration is
`prisma/migrations/20261002220000_agent_state/migration.sql`.
It is handwritten, native PostgreSQL DDL; no SQLite SQL rewriting or second
migration runner. Normal startup now deploys migrations automatically:

```sh
bun run db:up
```

The `migrate` Compose service waits for Postgres's healthcheck before executing
`prisma migrate deploy`, then exits. Its slim Node/Bun image installs only the
pinned Prisma CLI and dotenv (plus OpenSSL), and copies just the Prisma schema,
migrations and config. It does not install the application's dependency tree
or copy host credentials. Keep its Prisma version aligned with `package.json`.

The startup script waits only for the long-running Postgres service, then runs
the one-shot service with `docker compose run --build --rm migrate`, propagating
migration failure. It rebuilds against updated migrations using Docker's cache.
This avoids treating an intentionally exited migration container as an unhealthy
long-running service under Compose's `up --wait`.

For a manual host-side deploy, `bun run db:deploy` still runs the same Prisma
command. Container connections use `postgres:5432`, not host `localhost:5433`.

The SQL explicitly uses `BEGIN`/`COMMIT`, so a failure rolls back agent DDL.
Prisma records the failed attempt in its migration history; investigate and use
`prisma migrate resolve --rolled-back <migration>` before retrying a genuinely
rolled-back attempt. Do not mark partially applied changes successful blindly.
The transaction has a 5-second lock timeout and 30-second statement timeout.

## What each table represents

| Table                      | Purpose                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `agent.durable_metadata`   | Storage format version, next global ID candidate and next atomic commit sequence                                                   |
| `agent.record_ids`         | The single ID namespace shared by every durable record type                                                                        |
| `agent.conversations`      | Immutable conversation identity, fork ancestry and ownership                                                                       |
| `agent.entries`            | Immutable transcript events, head markers and the commit sequence that stored each entry                                           |
| `agent.tasks`              | Replaceable execution records: model/tool work, input, definition version, checkpoints, ownership, abort marks, memos and outcomes |
| `agent.submissions`        | Admitted user input/passive writes and their queued/placed/done/unanswered lifecycle, plus request-ID lookup                       |
| `agent.documents`          | Typed state document incarnations, addresses, scope and creation/retirement sequences                                              |
| `agent.document_revisions` | Complete bases and ordered Chord delta batches used to materialize document state                                                  |

A row in `public."Task"` is something you see on the Kanban board.
A row in `agent.tasks` is a piece of the agent's execution. They are unrelated
models with different lifecycles and different ID types.

We retain each complete Pi record in `record`, rather than trying to flatten
and recreate all the current/future fields of the experimental API. Separate
columns mirror the pinned reference's lookup and scan fields. Document bases
and deltas are retained in `content`; they are not just saved chat messages.

## Why serialized TEXT rather than JSONB?

The pinned contract allows JavaScript strings that are awkward for PostgreSQL:
NUL (`\u0000`) and lone UTF-16 surrogates (`\ud800`, `\ud801`). `JSONB` rejects
these escaped values; decoding them to ordinary PostgreSQL TEXT is also lossy
or invalid. JavaScript `JSON.stringify` keeps them as safe escaped sequences.

Records and revision content are therefore **JSON-encoded TEXT**. PostgreSQL's
`IS JSON` checks validate syntax without decoding string contents into JSONB.
The future adapter must use `JSON.stringify` on writes and `JSON.parse` on reads.
That also returns detached values instead of handing out mutable cached records.

Arbitrary indexed identities (`tasks.kind`, `submissions.request_id`, document
`kind` and `key_value`) use **`JSON.stringify(string)`**, not raw string values.
The literal string `"\\ud800"` and a lone surrogate remain different identities.
C collation avoids locale-sensitive identity comparisons. Request-ID SQL NULL
means _absent_, not the JSON-encoded empty string `""`.

Document addresses distinguish singleton documents from keyed family members:
`family = false` plus `key_value = '""'` denotes a singleton; `family = true`
with the same encoded empty key denotes a real family member. Session scope
uses owner ID 0; conversation/task scope uses the owning positive ID.

## Indexes and collision-safe lookups

Numeric scan indexes preserve ascending record scans, newest-first transcript
scans and newest base-revision lookup. Head markers have a partial index.
Status, conversation, abort/background and document-scope filters are indexed.

PostgreSQL B-tree indexes cannot hold arbitrary-length text keys. For arbitrary
string identities, indexes use fixed-size `md5(encoded_text)` buckets. This is
not cryptographic authentication and the hash is **not** the identity.
The future adapter must include both predicates:

```sql
SELECT record
FROM agent.tasks
WHERE md5(kind) = md5($1) AND kind = $1
ORDER BY id;
```

`$1` is the JSON-encoded string. The hash narrows candidates; the exact C-collated
comparison distinguishes any collisions. Expression indexes retain the numeric
cursor/scope fields needed by the Storage contract. Never look up a record by
hash alone or put a uniqueness constraint on a hash of an arbitrary identity.

The request lookup index is intentionally nonunique, like the pinned reference.
Pi's Session serializes request admission and deduplication. The adapter must
also serialize commits and enforce one active Harness owner (M1.3). Similarly,
current document-address uniqueness is checked against exact identities and
final batch state by the adapter, allowing retirement/recreation in one atomic
commit independent of write order. This DDL does not implement those protocols.

## IDs, sequences and database constraints

Every durable ID is a branded JavaScript number, globally unique within one
storage namespace. Root conversation ID 1 is reserved; allocation starts at 2.
Commit sequences start at 1. They are not wall-clock timestamps or independently
auto-incremented IDs on every table.

PostgreSQL stores IDs/sequences as `bigint`. Valid records are bounded by
`Number.MAX_SAFE_INTEGER` (`9007199254740991`). Allocation metadata may reach
MAX_SAFE_INTEGER + 1 to represent exhaustion. The adapter must validate bigint
strings before conversion and reject further allocation; do not globally change
pg's bigint parser to an unchecked JavaScript Number.

Each table's generated `record_type` and deferred composite foreign key require
an ID claim of the matching type in `record_ids`. Entries, conversations and ID
claims also have triggers rejecting UPDATE/DELETE. Task/submission state and
document lifecycle records remain mutable. Latest-only document revisions may
be pruned, so revisions intentionally have no append-only trigger.

Semantic references/ancestry, record-versus-index consistency, document revision
version transitions and atomic sequence stamping still belong to the owning
Session/Storage implementation, as in the pinned contract. JSON syntax checks
are not full Pi record validation. No credentials should be placed in records.

## Schema/version ownership and development

- `public._prisma_migrations` is the **only DDL migration history**, including
  migration names/checksums and failed attempts. Never edit a deployed migration;
  append a new timestamped migration instead.
- `storage_format_version = 1` in durable metadata identifies our application's
  storage encoding/layout contract. It is not a second migration history and is
  distinct from individual Pi document/task definition versions. M1.3 must reject
  formats it cannot understand.
- The behavioral reference is **pi-durable 1.0.0**, SQLite schema version 1,
  specifically the installed `dist/types.d.ts`, `dist/storage/sqlite/migrations.js`
  and `dist/storage/sqlite/storage.js`. Our format is application-owned; it is not
  an upstream PostgreSQL backend or a promise of compatibility with future Pi.
- `prisma/schema.prisma` declares `schemas = ["public", "agent"]`, the existing
  board model and all eight agent models. Database-to-datamodel diffs are tested
  to be empty, rather than proposing drops or changes to the agent layout.
- Both board and agent model changes can be generated with `db:migrate
--create-only --name your_change`. Review/customize the new SQL before applying
  it; native CHECKs, collation, deferred constraints, generated columns, triggers
  and hash-expression indexes require SQL supplements. Prisma introspects the
  generated discriminator fields as nullable fields with defaults, not a full
  representation of PostgreSQL GENERATED ALWAYS semantics. Never replace those
  generated columns with ordinary defaults accidentally.
- Keep the schema and SQL migration synchronized. `db:deploy` executes the one
  shared history. `@@ignore` on agent models controls Client generation, not
  schema ownership by Migrate.
- Avoid `db push` as a substitute for migration deployment. For a complete local
  reset, use the documented Docker volume reset; it removes **both** schemas and
  all their data. Never reset the user's database as part of integration tests.

## Real PostgreSQL tests

Start the local Docker database, then run:

```sh
AGENT_SCHEMA_TEST_URL='postgresql://kanban:kanban@127.0.0.1:5433/kanban' bun run test:agent-schema
```

This URL must be local. The role needs database-create permission and, for the
DDL failure-injection test, event-trigger permission. The supplied Docker role
has both. Tests create randomly named empty databases, run the **actual Prisma
CLI**, and drop only those scratch databases afterward. The original board and
agent schemas are never cleared.

Coverage includes empty/full deployment and repeat deploy; an existing board
with an existing migration baseline and a task created through `server/tasks.ts`;
Prisma database-to-datamodel compatibility; lossless NUL/surrogate/long-key
round trips; document bases/deltas; native constraints and immutability; and
mid-migration DDL failure/rollback followed by Prisma resolve/retry.

`bun test` skips these tests when AGENT_SCHEMA_TEST_URL is absent; explicitly
running `test:agent-schema` without that variable fails instead of reporting a
misleading success. Unit/HTTP tests still require no database.

This is schema acceptance only. Full Storage conformance, pagination,
materialization, restart recovery, close behavior and ownership locking are
still M1.3/M1.4 work. No agent is wired to these tables yet.
