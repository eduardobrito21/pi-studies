# Taskboard — agent-layer study

A deliberately small local task manager: React + Vite + TypeScript, shadcn/ui,
dnd-kit, Express, Effect, Zod, Prisma 7, and PostgreSQL. Bun runs the API and manages packages.

## Start locally

Install [Bun](https://bun.sh/docs/installation) and start Docker Desktop first.

```sh
cp .env.example .env
bun install
bun run db:generate
bun run db:up
bun run db:deploy
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
- No authentication, deployment setup, or agent framework.

## Commands

| Command                                 | Purpose                                                   |
| --------------------------------------- | --------------------------------------------------------- |
| `bun run dev`                           | Frontend and API, with reload                             |
| `bun run build`                         | Typecheck everything and build the frontend               |
| `bun test`                              | Validation, task service, and HTTP tests (no DB required) |
| `bun run db:up`                         | Start Postgres and wait for its healthcheck               |
| `bun run db:down`                       | Stop Postgres, keeping data                               |
| `bun run db:deploy`                     | Apply committed migrations                                |
| `bun run db:migrate --name your_change` | Create a migration after changing the schema              |
| `bun run db:generate`                   | Regenerate Prisma Client                                  |
| `bun run db:studio`                     | Browse data with Prisma Studio                            |

**Reset all data:** `docker compose down -v`, then `bun run db:up && bun run db:deploy`.
The frontend build is not a standalone production server; use Vite for this local study.

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
