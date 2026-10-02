# Project instructions

Use Bun. Keep this a local-only, single-board study project.
Use Zod for boundary validation and Effect for backend task operations.
Future agent tools must reuse server/tasks.ts, not raw SQL.
After changes run `bun run lint`, `bun run format:check`, `bun test`, and `bun run build`.
anti-slop is vendored under tools/oxlint/anti-slop; preserve its provenance and licenses.
shadcn/lint is registered; design rule policy belongs in oxlint.config.ts.
