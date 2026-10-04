# M1.4 — PostgreSQL storage conformance and crash tests

M1.3's `server/postgres-storage.ts` implements the installed **pi-durable 1.0.0**
`Storage` interface. M1.4 verifies that implementation against real PostgreSQL.
No adapter or migration change was needed to pass the full shared suite.

This milestone adds tests and documentation only: no Harness, model request,
agent routes, tools, permissions, distributed worker, or second agent loop.
The storage architecture remains [the M1.3 design](../m1.3/pi-m1.3.md).

## Run the gate

Start the local Docker database, then run:

```sh
bun run db:up
POSTGRES_STORAGE_TEST_URL='postgresql://kanban:kanban@127.0.0.1:5433/kanban' \
  bun run test:postgres-storage
```

Expected result for the pinned release: **37 passing tests** — **23 upstream
conformance cases** and **14 PostgreSQL-specific integration cases**.

The role needs CREATE DATABASE, permission to create functions/triggers/indexes
in its own scratch database, and permission to terminate its own PostgreSQL
backends. The supplied local Compose role has these permissions. Process tests
use Bun's IPC and `SIGKILL` on the local Unix host; they are not a portable Windows
process-kill recipe. No provider credentials or model configuration are needed.

Tests validate that the administrative URL is local. For **each case**, they
create a random `pi_storage_<uuid>` database using `template0`, run the actual
Prisma migration history with `prisma migrate deploy`, and finally drop only
that random database. The supplied board database is never reset, truncated,
modified, or dropped. The child fixture additionally validates the local host
and scratch database name before opening storage.

`bun test` skips these opt-in database tests when the variable is absent.
Explicit `bun run test:postgres-storage` without the variable fails instead of
pretending conformance passed. The normal project checks still apply:

```sh
bun run lint
bun run format:check
bun test
bun run build
```

For the separate schema/migration acceptance suite:

```sh
AGENT_SCHEMA_TEST_URL='postgresql://kanban:kanban@127.0.0.1:5433/kanban' \
  bun run test:agent-schema
```

## The upstream suite is unchanged

`tests/integration/postgres-storage.test.ts` imports
`createStorageConformance` and `createExpectAssertions` from the installed
`@earendil-works/pi-durable/testing` export. Each returned case is registered
with Bun's `test`. There is no case-name allowlist, copied test body, skipped
edge case, changed expectation, or PostgreSQL-specific relaxation of the contract.
The assertion adapter is the release's own Vitest/Jest-compatible facade, which
also works with Bun's `expect`.

The 23 cases cover root reservation/immutability; atomic mixed batches; detached
records and prototype-like JSON keys; out-of-order entry IDs; cursors;
conversation ownership; deep fork caps/head markers/visibility; task states and
filters; request-scoped submissions and passive writes; historical document
incarnations; long delta tails/root replacements; independent copies and rejected
copy sources; version transitions/current-only reads; exact document scope/address
identity; lifecycle errors/empty lifetimes; rollback of secondary indexes;
lossless string identities; global IDs/exhaustion; and post-close rejection.

Reference inspected: the installed package's `dist/types.d.ts`,
`dist/testing/storage-conformance.js`, `dist/testing/assertions.js`, and SQLite
storage implementation, not mutable upstream main.

## PostgreSQL-specific evidence

The 14 integration cases additionally verify:

1. Close/reopen persistence of complete records/checkpoints, unused allocations,
   admission-time detachment, concurrent minting, and close draining.
2. A trigger-injected late SQL failure after table mutations: task updates,
   entries, ID claims and metadata all roll back, and the adapter remains usable.
3. NUL, distinct lone surrogates, literal escapes, empty and long encoded strings
   across task kinds, requests and document addresses/scans.
4. Safe maximum bigint conversion and persistent exhausted ID/sequence sentinels.
5. Second-owner rejection and cleanup of its failed-open connection, forced owner
   backend termination, explicit reopen, and lock release.
6. **Every** Storage method after close, including both entry lookup overloads.
7. Thirty-two concurrent ID allocations and commits produce unique, ordered
   sequences. A failed batch does not poison later queued writes.
8. A plain pi Session serializes concurrent lookup/create callbacks: retries
   reacquire one request per conversation, including after reopen. This exercises
   the owning Session's mutation line; it does not invent a database uniqueness
   rule or implement the future HTTP submission boundary.
9. Forced hash-bucket collisions still preserve exact task/request/document
   identities, family keys, singleton/empty-family distinctions, and absent
   lookups. Collision injection creates a constant `agent.md5` function and
   matching indexes **only in the scratch database**, with the test adapter's
   search path selecting that function. `pg_catalog.md5`, deployed migrations,
   and production storage are unchanged. This makes missing exact-text predicates
   observable without needing to brute-force a real MD5 collision.
10. Real `SIGKILL` of an idle owning process releases the backend/lock while
    committed transcript, task checkpoint, submission, historical base/delta,
    ID allocation and commit sequence survive explicit reopen.
11. Real `SIGKILL` during a late mixed transaction rolls back the task/submission
    replacements, transcript insert, ID claim and document delta. Secondary
    lookups and metadata retain their prior committed values.
12. Historical document pagination continues through an address replacement and
    reopen. Document records/values are detached; half-open lifetime boundaries
    remain correct. PostgreSQL revision rows confirm current-only base compaction
    and retirement pruning.
13. Owner loss rejects the actual in-flight transaction and queued reads/mints/
    commits while close drains; reopening starts from the unchanged counters.
14. Unsupported-format initialization failure leaves no leaked backend/lock.

## How the process-crash test works

`tests/fixtures/postgres-storage-owner.ts` opens only PostgresStorage. It commits
an entry/head marker, running task checkpoint, placed submission, rewindable
base, and delta, then reports the numeric identities/sequences through IPC.
There is deliberately no close call, exit hook, or signal cleanup handler.

In the late-transaction case the parent holds a separate **test-only advisory
lock** `(1885955191, 1)` and creates a revision trigger that waits on it. After
sending the child a write command, the parent polls `pg_locks` until the child's
backend is demonstrably blocked in that trigger. At this point earlier task,
submission, entry and ID-claim statements have executed inside the transaction,
but COMMIT has not been sent. Killing the child is therefore a deterministic
pre-commit crash rather than a timing guess.

The parent releases the test blocker so PostgreSQL can detect the closed socket,
then waits for the original backend to disappear from `pg_stat_activity` and
`pg_locks` before reopening. A process dying does not imply an executing or
blocked server statement disappears instantaneously. The owning storage lock is
still session-level `(1885955190, 1)` and stays held until that backend ends.

The idle-crash case verifies persisted records survive without graceful shutdown.
The late-transaction case verifies PostgreSQL rolls back uncommitted work. Neither
case claims to prove the outcome of a network failure during COMMIT is unambiguous.

## What is now verified, and what is next

The M1.3 adapter compiles against the pinned interface, and M1.4's full upstream
suite plus PostgreSQL-specific acceptance tests pass. Storage correctness is now
verified to this gate's scope; no contract was weakened to obtain that result.

The next milestone remains M1.5: one backend Harness and read-only board tools
which reuse `server/tasks.ts`. Real task mutation receipts/exactly-once effect
boundaries, Harness recovery scheduling, HTTP input-mismatch rules, UI streaming,
and real-provider behavior are **not** demonstrated by these storage tests.
Model/provider selection is still unresolved; no live model request was made.
