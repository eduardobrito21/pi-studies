# Taskboard — agent-layer study

A local-only, single-board task manager and study project for a durable agent
layer. Built with Bun, React, Express, Effect, Zod, Prisma, and PostgreSQL.

## Start locally

Install [Bun](https://bun.sh/docs/installation) and start Docker Desktop, then:

```sh
cp .env.example .env
bun install
bun run db:generate
bun run db:up
bun run dev
```

Open **http://127.0.0.1:5173**. The API runs on **127.0.0.1:3001** and
PostgreSQL on **127.0.0.1:5433**. Database startup applies migrations automatically.

## Documentation

| Guide                                                     | Topics                                                          |
| --------------------------------------------------------- | --------------------------------------------------------------- |
| [Project guide](docs/project-guide.md)                    | Local setup, commands, API, Effect, linting, and agent roadmap  |
| [M1.1 — Pi integration](docs/m1.1/pi-m1.1.md)             | Scripted durable loop and Pi/Chord/Effect boundaries            |
| [M1.2 — Durable-state schema](docs/m1.2/pi-m1.2.md)       | PostgreSQL tables, encoding, indexes, and migrations            |
| [M1.2 — Study guide](docs/m1.2/pi-m1.2-study.md)          | Table-by-table explanations and a runnable offline example      |
| [M1.2 — Visual walkthrough](docs/m1.2/pi-m1.2-study.html) | Interactive commit animation; open directly in a browser        |
| [M1.3 — Storage adapter](docs/m1.3/pi-m1.3.md)            | Ownership, atomic commits, document history, and database tests |

## Key commands

```sh
bun run dev         # Frontend and API with reload
bun run check       # Lint, formatting, tests, and build
bun run db:up       # Start Postgres and apply migrations
bun run db:down     # Stop Postgres, keeping data
bun run pi:smoke    # Offline scripted Pi compatibility check
```

PostgreSQL integration tests are opt-in; see the M1.2 and M1.3 guides.
For migration authoring, model availability checks, and other commands, see the
[project guide](docs/project-guide.md).

## Scope and current status

- One board: Triage → Backlog → Todo → In progress → Done.
- Create, edit, delete, and drag cards between columns; no within-column reordering.
- No accounts, authentication, or deployment setup.
- Durable schema and PostgreSQL storage adapter exist, but the adapter is not
  wired into a Harness or HTTP routes. Full storage conformance remains M1.4.
- No live-inference command or agent task tools yet. A model must be explicitly
  chosen before live inference; credentials stay in Pi's credential store.
- Future agent tools must reuse `server/tasks.ts`, not raw SQL. The agent will
  manage cards, **not execute their descriptions**.
