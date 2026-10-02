# M1.3 — Native PostgreSQL durable storage

`server/postgres-storage.ts` implements the **installed pi-durable 1.0.0**
`Storage` interface. It is not wired into the server or a Harness yet. No model
selection, credentials, provider calls, routes, tools or second agent loop are
introduced.

Behavioral references inspected locally:

- `node_modules/@earendil-works/pi-durable/dist/types.d.ts`
- `dist/storage/sqlite/storage.js`, `storage.d.ts`, `migrations.js`, and `node.js`
- `dist/testing/storage-conformance.js` and its runner-independent declarations

All these paths after the first are relative to the installed pi-durable package,
not mutable upstream main. The PostgreSQL layout remains the application-owned
format v1 described in [M1.2](../m1.2/pi-m1.2.md). No schema changes were needed; Prisma
Migrate remains the sole DDL owner.

## Ownership and operation ordering

```text
Future one Harness / Session
  → PostgresStorage (Promise interface required by pi)
    → one serialized admission queue
      → one owned, non-reconnecting pg.Client
        ├── session advisory lock (1885955190, 1)
        └── agent.* parameterized PostgreSQL queries

Board operations remain Effect → server/tasks.ts → Prisma → public."Task"
```

`PostgresStorage.open(connectionString)` acquires a nonblocking, database-scoped
session advisory lock before reading metadata. A second adapter cannot open the
same database concurrently. The lock uses a fixed application namespace, not a
host name, connection-string spelling, or hash of credentials. This implementation
supports exactly one agent storage namespace per database.

The owned client is also the query connection. It is dedicated to this adapter,
never returned to a pool, and **never reconnects**. This ties every SQL operation
to the backend that actually holds ownership, avoiding a separate lock/data
connection's ownership-loss race. Connection `error`/`end` events and connection
failure responses poison the adapter; already queued and new operations then
reject. Ordinary statement/contract errors do not poison it. Recovery requires
explicit close and a new open; there is no hidden retry of a possibly committed
transaction. A failed network response to COMMIT can still have an ambiguous
outcome, as with any PostgreSQL client: reopen and read persisted state, do not
blindly replay a commit.

The queue serializes **all operations**, including ID minting and reads. This
intentionally favors simple correctness over parallel read throughput in this
local single-Harness project. Reads admitted after a commit see its result;
multi-query ancestry reads cannot interleave with this adapter's writes.
Document materialization also uses a repeatable-read transaction so metadata,
base and tail share a database snapshot.

Close seals admission immediately, drains admitted work, then ends the backend,
releasing its advisory lock. Repeated close calls return the same promise. Every
other operation after close rejects. Unexpected connection loss does not silently
move work to a new backend. An advisory lock is cooperative ownership, not an
access-control boundary: unsupported external SQL writers can still modify data.

## Atomic persistence and numeric safety

Each commit snapshots the caller's JSON writes at admission, then opens a native
PostgreSQL transaction. It locks metadata, checks ID ownership and document batch
consistency, claims global IDs, applies table/document writes, advances counters,
and commits. Rollback includes ID claims, mirrored lookup fields, revisions,
records, and metadata. No SQLite SQL rewriting is used.

Conversations, entries and document IDs are create-only; tasks and submissions
replace complete records but cannot take another record type's ID. Repeated
same-type task/submission writes adopt the final complete record. The database's
append-only triggers and deferred ownership constraints are additional safeguards.

`pg`'s bigint parser is not changed globally. Counter strings are parsed as
`bigint`, checked against the JavaScript safe range, and only then converted to
branded numbers. MAX_SAFE_INTEGER + 1 is permitted solely as an exhausted metadata
sentinel. ID minting reserves 1 for the root, starts at 2, and persists even unused
candidates immediately; gaps are legal and candidates are not reused on reopen.
Explicit committed IDs also advance allocation. Sequence exhaustion rejects
before any write; it cannot wrap or round to an unsafe JavaScript number.

Zod validates the connection-string boundary, counters, numeric allocation,
versions and pagination input. Storage trusts Session's semantic record shapes,
ancestry and references, as required by the pinned contract; it is not an arbitrary
HTTP record ingestion API. The adapter uses pi's required Promise API rather than
introducing an unnecessary Effect-to-Promise layer. Backend board/task business
operations continue to use Effect unchanged.

## Reads, identity and document history

- Records and revision content use `JSON.stringify` → PostgreSQL TEXT →
  `JSON.parse`, giving detached reads and lossless NUL/lone-surrogate values.
- Indexed arbitrary string identities are JSON-encoded strings, not raw text.
  Every hash-index lookup uses **both** `md5(column) = md5(parameter)` and exact
  `column = parameter`. The hash is only a candidate filter, never identity.
- Conversations/tasks/submissions/documents scan ascending IDs; entries scan
  newest-first through each fork ancestor's inclusive cap. Cursors continue
  strictly past the last returned ID. Head markers return the marker record,
  not the entry named by its `head`.
- Request lookup is conversation-scoped. Storage does not add uniqueness absent
  from the pinned contract: Session owns serialized admission/deduplication.
- Singleton addresses remain distinct from family members with an empty key.
- Document actions are grouped per incarnation. Final current-address counts
  allow retirement/recreation in either write order within the same commit.
  Creation plus retirement has an empty lifetime.
- Historical membership is half-open: `createdAt <= point < retiredAt`.
  Materialization chooses the newest base at/before the point, then applies the
  ordered Chord deltas after that base. Version changes require a new base.
- Current-only documents reject historical content reads and prune older
  revisions when adopting a base or retiring. Rewindable documents retain them.
- Definition-free copies materialize and store an independent base, verify
  compatible conversation document identity/semantics, and reject a source
  changed anywhere in the same batch with pi's `StorageRejected` error.

## PostgreSQL tests

With local Compose Postgres running:

```sh
POSTGRES_STORAGE_TEST_URL='postgresql://kanban:kanban@127.0.0.1:5433/kanban' \
  bun run test:postgres-storage
```

The role needs CREATE DATABASE and permission to terminate its own backend.
The supplied URL must be local and is used only for administrative scratch
creation/drop. Each test creates a random `pi_storage_<uuid>` database, deploys
the **actual Prisma migration history**, and drops only that scratch database.
The user's board/agent tables are never cleared or reset. Explicit invocation
without the environment variable fails; ordinary `bun test` skips opt-in tests.

M1.3 includes a deliberately bounded sample of seven unchanged installed-release
conformance cases: detached records, deep forks/head markers/pagination, task and
submission scans, rewindable incarnations, independent copies, and current-only
version transitions. Six adapter-specific tests cover:

- persisted records/checkpoints and unused candidates after close/reopen,
  admission-time snapshots, concurrent ID allocation, and close draining;
- a real late SQL failure after table mutations, with complete rollback and
  successful subsequent writes, immutable entries and cross-type ID rejection;
- NUL, distinct lone surrogates, literal escape strings, empty and long indexed
  identities in all three hash-indexed record families;
- safe maximum ID/sequence allocation and persistent exhaustion sentinels;
- second-owner rejection, forced backend loss, explicit reopen and lock cleanup;
- initialization failure cleanup for an unsupported format version.

## Remaining M1.4 gate

These tests are implementation evidence, **not a claim of full storage
conformance**. M1.4 still needs to register/run every upstream case, broaden
adapter-specific coverage (all post-close methods, more concurrent/failed mixed
batches, address/hash collision checks and historical pagination), and verify
ownership/resource cleanup after a real abrupt process exit, not just forced
backend termination or graceful close. Storage correctness must pass that gate
before wiring a Harness or making any real agent run.
