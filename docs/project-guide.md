# Project guide — local development and agent-layer study

A deliberately small local task manager: React + Vite + TypeScript, shadcn/ui,
dnd-kit, Express, Effect, Zod, Prisma 7, and PostgreSQL. Bun runs the API and manages packages.

## Start locally

Install [Bun](https://bun.sh/docs/installation) and start Docker Desktop first.

```sh
cp .env.example .env
bun install
bun run db:generate
bun run db:up
bun run dev
```

Open **http://127.0.0.1:5173**. The API listens on **127.0.0.1:3001**.
Vite proxies `/api` to it; there is no CORS configuration to maintain.

If Bun isn't installed yet, `npx --yes bun` can replace `bun` for individual
commands. For the combined dev command, use:
`npm exec --yes --package=bun -- bun run dev` (puts Bun on PATH for subprocesses).

Postgres binds to **127.0.0.1:5433** to avoid colliding with another local database.
Credentials in `.env.example` are throwaway local credentials, not production secrets.
Prisma is pinned to **7.10.0**, using the PostgreSQL driver adapter and `prisma.config.ts`.
Keep the Prisma CLI, client, and adapter versions aligned.

## Scope

- One board: Triage → Backlog → Todo → In progress → Done.
- Create, read, edit, delete, and drag tasks between columns.
- Title required; description and free-text assignee optional. No user accounts.
- Drop changes status; there is **no within-column reordering**. Tasks retain creation order.
- The editor's status selector provides a non-drag alternative.
- Postgres volume survives restarts. No sample tasks are inserted automatically.
- No taskboard authentication or deployment setup. The pi SDK is installed for a
  local connection study; there are no agent routes or task tools yet.

## Commands

| Command                                 | Purpose                                                   |
| --------------------------------------- | --------------------------------------------------------- |
| `bun run dev`                           | Frontend and API, with reload                             |
| `bun run build`                         | Typecheck everything and build the frontend               |
| `bun test`                              | Validation, task service, and HTTP tests (no DB required) |
| `bun run db:up`                         | Wait for Postgres, then run migrations in Compose         |
| `bun run db:down`                       | Stop Postgres, keeping data                               |
| `bun run db:deploy`                     | Apply committed migrations                                |
| `bun run db:migrate --name your_change` | Create a migration after changing the schema              |
| `bun run db:generate`                   | Regenerate Prisma Client                                  |
| `bun run db:studio`                     | Browse data with Prisma Studio                            |

`compose.yaml` includes a one-shot `migrate` service that depends on Postgres
being healthy. `bun run db:up` waits for Postgres, rebuilds the slim migration
image when needed, runs it, and returns its exit code. The image contains only
Node/Bun, OpenSSL, Prisma CLI and dotenv, plus `prisma/` and `prisma.config.ts`—
not the application dependencies, host `node_modules`, or `.env`.
Inside Compose the database address is `postgres:5432`; the host uses port 5433.
`bun run db:deploy` remains available for a manual host-side deploy.

**Reset all data:** `docker compose down -v`, then `bun run db:up`.
The frontend build is not a standalone production server; use Vite for this local study.

## M1.1 — pi packages and existing-login integration

`@earendil-works/pi-durable`, `@earendil-works/pi-ai`, and
`@earendil-works/chord` are pinned together to **1.0.0**.
`@earendil-works/pi-coding-agent` **1.0.0** supplies only `ModelRuntime` and the
credential-directory helper: no coding-agent session or second agent loop.
The published durable package declares `^1.0.0` compatibility with both ai and
chord. `bun.lock` resolves these packages to 1.0.0; use
`bun install --frozen-lockfile`. Bun is the sole package manager/lockfile.
The durable API is experimental: check installed release declarations and
implementation, not just upstream main, before extending the integration.

### Three separate checks

```sh
bun run pi:smoke   # Scripted faux provider → pi-durable → committed transcript
bun run pi:models  # Available model identifiers for existing stored pi logins
```

`pi:smoke` makes **no network inference request**, needs no credentials, and
expects `PI_DURABLE_OK`. It opens one pi-durable Harness, creates one root
conversation, submits one input, waits for its answer, reads committed entries,
and closes the Harness. The output shows `pi.user`, `pi.system`, and
`pi.assistant`, with empty tool/extension lists and one faux-provider call.
Retries and automatic compaction are disabled. Storage is disposable
`MemoryStorage` **only for this M1.1 compatibility test**, not application
persistence or a claim of restart recovery.

**Model/provider selection is still unresolved. Ask the user which listed model
to use before any live inference.** Neither the current coding session nor pi's
saved defaults choose the taskboard's model. After an explicit choice:

```sh
TASKBOARD_PI_PROVIDER='<chosen-provider>' TASKBOARD_PI_MODEL='<chosen-model>' bun run pi:check
```

This validates the pair with Zod, checks the local catalog/config and stored
credential metadata, then asks Pi whether authentication is configured. It does
not submit a prompt or prove that a provider will accept a future live request.
Missing/blank selection, absent credentials, unavailable models, and timeout
exit nonzero. There is deliberately no live-inference CLI command yet.

Authenticate using the pi CLI's `/login`. Credentials stay in
`~/.pi/agent/auth.json`, or the directory selected by `PI_CODING_AGENT_DIR`.
`ModelRuntime` can resolve/refresh OAuth for future durable requests, without
copying credentials into history, Postgres, `.env`, or browser payloads.
Enumeration prints only provider/model identifiers and credential type, never
model definitions, headers, tokens, or raw provider errors. Catalog-network
refresh is disabled; model configuration comes from pi's `models.json` and the
installed catalog. Availability checks do not perform inference, but custom
API-key resolution may execute configured secret commands. Extensions and
project instructions are never discovered or loaded.

### Agreed architecture and next steps

One backend process, one pi-durable Harness, and one board conversation.
PostgreSQL will hold both board data and **all durable agent state**:
M1.2 adds a separate schema, M1.3 implements the pinned `Storage` contract using
`pg`, and M1.4 gates agent integration on storage conformance. Prisma remains
responsible for board data; Effect remains the business-operation layer and Zod
remains authoritative application validation. M1.5 adds read-only board tools
that reuse `server/tasks.ts`. No chat UI in M1.1.

No approvals/permissions layer, subagents, MCP, shell/filesystem tools, raw-SQL
agent tools, or autonomous work. The agent manages tasks, **never executes task
descriptions**. Only explicitly registered task tools will be installed.

The previous coding-agent/live-default-model smoke check was a mistaken
implementation and has been replaced. Its live success is not evidence that
the intended durable integration is complete.

Release reference: npm reports durable 1.0.0 gitHead
`a13d35a742c6ef8462812a28fbe1d8c8b7431c32` (different from the earlier research
commit `9fba660cf1caca0ade5bea72269352416e595a19`). Implementation is checked against
`node_modules/@earendil-works/pi-durable/dist` and the release's
[14-chat example](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/test/examples/14-chat.ts).
See [the M1.1 walkthrough](m1.1/pi-m1.1.md) for the Pi/Chord/Effect boundaries.

## M1.2 — PostgreSQL durable-state schema

**Prisma Migrate owns the migrations for both schemas.** The existing
`bun run db:deploy` now also creates the separate `agent` namespace; there is
no second migration runner or migration history. `prisma/schema.prisma` describes
**both board and agent tables**, using `@@schema` and readable `Agent...` model
names. Prisma Client still handles board operations; agent models are excluded
from Client with `@@ignore`, and the upcoming durable adapter will use `pg`.

`prisma/migrations/20261002220000_agent_state/migration.sql` creates conversations,
immutable transcript entries, execution tasks/checkpoints, submissions,
documents/revisions, global ID claims and allocation/commit metadata. It does
not alter `public.\"Task\"`, and no agent is wired to it yet. Its native PostgreSQL
DDL is explicitly transactional and uses lossless JSON-encoded TEXT rather
than JSONB for Pi records and arbitrary string identities.

Run schema acceptance against real local PostgreSQL:

```sh
AGENT_SCHEMA_TEST_URL='postgresql://kanban:kanban@127.0.0.1:5433/kanban' bun run test:agent-schema
```

Tests deploy with the actual Prisma CLI into disposable scratch databases,
including an existing-board case. They preserve the user's board. The normal
`bun test` skips database tests unless the variable is supplied.

See [the M1.2 walkthrough](m1.2/pi-m1.2.md) for table purposes, encoding/index
choices, schema/version ownership, migration authoring and remaining adapter
responsibilities.

## M1.3 — PostgreSQL durable storage adapter

`server/postgres-storage.ts` now implements the installed pi-durable 1.0.0
`Storage` contract directly with `pg`. One owned connection holds a database-scoped
advisory lock and serializes operations; commits atomically persist records and
document revisions. Close/reopen preserves state and numeric allocation.
The adapter is not wired into a Harness or HTTP routes yet.

```sh
POSTGRES_STORAGE_TEST_URL='postgresql://kanban:kanban@127.0.0.1:5433/kanban' bun run test:postgres-storage
```

These opt-in tests deploy migrations into disposable databases without resetting
the user's board. They include seven installed-release conformance samples and
six PostgreSQL-specific cases. Full conformance and abrupt-process-exit coverage
remain M1.4. See [the M1.3 walkthrough](m1.3/pi-m1.3.md) for the ownership,
transaction, encoding, document-history and cleanup design.

## Where the future agent layer goes

```text
React → Express routes ─┐
                       ├→ Effect task service → Prisma 7 → Postgres
Future agent tools ────┘
```

- `shared/tasks.ts`: status definitions, input types, and Zod validation.
- `server/tasks.ts`: list/get/create/update/delete operations. Validation happens
  **here**, so a future tool caller cannot bypass it by skipping the HTTP routes.
- `server/app.ts`: HTTP transport and error responses.
- `prisma/schema.prisma`: database schema.
- `src/components/Board.tsx`: drag-and-drop view.
- `src/components/TaskDialog.tsx`: task editor.

For step 2, instantiate `createTaskService(db)` and wrap its methods in agent
tools such as `list_tasks`, `create_task`, and `update_task`. A status change is
an effect returned by `updateTask(id, { status: "DONE" })`. Start by letting the agent manage
tasks, **not execute their descriptions**, and keep tool results explicit.
The agent should not receive raw SQL access.

## Learning Effect

Start with `server/tasks.ts`:

- `Effect.tryPromise` wraps Prisma's Promise API with typed failure mapping.
- `Effect.gen` sequences Zod validation and a database operation with `yield*`.
- `Data.TaggedError` defines invalid-input, missing-task, and storage failures.
- Operations are lazy; constructing an effect does not execute a query.

Then read `server/app.ts`: `Effect.match` handles success/failure, `Match.tag`
exhaustively maps domain errors to HTTP responses, and `Effect.runPromise`
executes the program at the transport boundary. The task service uses simple
constructor injection for now; Context/Layer and a managed runtime can be a
separate learning step rather than more scaffolding in v1.

Zod validates task inputs in the service and API responses in the frontend.
There are no duplicate Effect Schema contracts.

## Lint and formatting

- `bun run lint`: Oxlint plus all generic anti-slop rules and the Effect rules.
- `bun run lint:fix`: safe lint fixes, including readable spacing.
- `bun run format` / `bun run format:check`: Oxfmt.
- `bun run check`: lint, format check, tests, and build.

anti-slop is vendored in `tools/oxlint/anti-slop`; its exact upstream revision
and licenses are preserved there. Oxlint and `@oxlint/plugins` are pinned together.

`@shadcn/lint` is registered in `oxlint.config.ts`. Following its setup guide,
**no shadcn rule policies are enabled yet**. Choose design constraints there:
[available rules](https://github.com/shadcn-ui/lint#rules).
This registration verifies compatibility; it does not yet enforce a design system.

## API

| Method | Path             | Result                 |
| ------ | ---------------- | ---------------------- |
| GET    | `/api/tasks`     | All tasks              |
| GET    | `/api/tasks/:id` | One task               |
| POST   | `/api/tasks`     | Create task (201)      |
| PATCH  | `/api/tasks/:id` | Update supplied fields |
| DELETE | `/api/tasks/:id` | Delete task (204)      |

```sh
curl http://127.0.0.1:3001/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"Learn agent tools","assignee":"Me","status":"TRIAGE"}'
```

Statuses: `TRIAGE`, `BACKLOG`, `TODO`, `IN_PROGRESS`, `DONE`.
Unknown fields, invalid statuses, blank titles, and empty updates are rejected.
