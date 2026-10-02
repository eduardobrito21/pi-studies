# M1.1 walkthrough: one durable loop, no live inference

## Why the correction matters

A coding-agent session already contains an agent loop. Wrapping it inside
pi-durable would give us two owners of a conversation's execution. This project
needs pi-durable to own the run, transcript, and checkpoints. Coding-agent is
used only for its existing credential/configuration runtime, not its session,
tools, settings discovery, or extensions.

## The pieces

| Piece                     | What it does here                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| pi-ai                     | Supplies the provider/model contract and a scripted faux provider                                   |
| pi-durable                | Owns the Harness, root conversation, submission, generation task, and committed entries             |
| Chord                     | Supplies the cancellation context; durable also uses its document/state machinery internally        |
| coding-agent ModelRuntime | Bridges the user's existing pi credential store and model configuration to pi-ai's Models interface |
| Effect                    | Describes our operations, sequences them, exposes safe failures, and runs them at the CLI boundary  |
| Zod                       | Validates explicit application model selection                                                      |

Chord is not a second LLM loop or a replacement for Effect's business operations.
A Chord Context and Effect's dependency-injection Context are different APIs.

## Follow `server/pi-smoke.ts`

1. `fauxProvider()` creates a provider that consumes scripted responses. It does
   not ask a real model to invent an answer. `fauxAssistantMessage()` supplies
   the expected answer, so this tests integration, not model intelligence.
2. `createModels()` creates a pi-ai provider collection. We register only faux.
3. `Harness.open(storage, options, context)` opens pi-durable over MemoryStorage,
   with an empty extension registry. No implicit CLI resources are loaded.
4. `harness.root(...)` creates one root conversation. Its agent has an explicit
   model reference, no tools or extensions, and one connection-test instruction.
5. `root.submit(...)` admits the input and creates the durable work needed to
   answer it. The returned Submission is a handle, not the model's answer.
6. `submission.wait(...)` waits for that work to settle. A failed/unanswered
   submission is not a successful response.
7. `tx.entry(AssistantEntry, settled.answer)` reads the committed assistant
   entry. Its `model` array contains the pi-ai AssistantMessage: content blocks,
   stop reason, model identity, and usage. We require normal completion and the
   exact expected text.
8. `root.entries(...)` scans the transcript newest-first; reversing the page
   makes the displayed kinds chronological: user → system → assistant. The
   positional system entry records the instructions used for the request.
9. `harness.close(...)` runs in `finally`, even after failure. The default
   MemoryStorage is disposable: closing/reopening it does not preserve this run.

With PostgreSQL later, commits will include immutable transcript entries,
execution tasks/checkpoints, documents/revisions, and submissions—not merely
an array of chat messages. A pi execution task is distinct from a Kanban task.

## Follow `server/pi-models.ts`

`pi:models` lists available chat models for providers with stored pi credentials.
It returns only provider/model identifiers and credential type. It never prints
a full Model object, which could carry sensitive custom headers.

`pi:check` first validates both explicit environment variables. There is no
fallback to saved defaults or the model running this coding session. It then
loads ModelRuntime, verifies a stored login and catalog model, and checks Pi's
authentication availability. That is not a live request and cannot prove that
an expired/revoked credential will work when inference is eventually attempted.

ModelRuntime implements pi-ai's `Models` interface, so a future live durable
run can pass it directly as `Harness.open(..., { models: runtime, ... })`.
The Harness stays the only agent loop; auth resolution and OAuth refresh remain
inside Pi's credential machinery. No tokens belong in durable transcript state.

## What Effect adds

`Effect.tryPromise` adapts Pi's Promise-based calls into a lazy operation with a
failure channel. Constructing the smoke Effect does not start a model request.

`Effect.gen` sequences operations with `yield*`; the CLI's `Effect.runPromise`
executes the program. `Effect.match` handles the result and sets a nonzero exit
code on failure. `PiSetupError` is a tagged error with a safe application
message; raw provider errors are intentionally not printed.

`Effect.tryPromise` also provides an AbortSignal. We translate it with Chord's
`withAbortSignal()` so interrupted host waits observe cancellation. The CLI uses
a 15-second Effect timeout. **Cancelling a wait does not cancel durable work.**
For this disposable test, `finally` closes the Harness using BACKGROUND_CONTEXT
so cleanup is not itself cancelled. Later explicit Stop must use the durable
conversation's abort API, and cannot undo already committed database changes.

This is deliberately a small Effect boundary around async code, not a full
Effect service/Layer or resource-scope implementation. The board operations
remain the existing Effects in `server/tasks.ts`.

## Try it without credentials or a database

```sh
bun run pi:smoke
bun test tests/pi-smoke.test.ts
```

Tests also script a failed response and an unexpected answer, verify no retries,
check that storage closes on success/failure, inspect what the provider received,
and prove metadata/error output excludes test secret sentinels. No real provider
requests or real credentials are used by the test suite.

## Release references

- [Durable chat example at npm's 1.0.0 gitHead](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/test/examples/14-chat.ts)
- Installed contracts: `pi-durable/dist/harness/types.d.ts`,
  `pi-durable/dist/types.d.ts`, and `pi-ai/dist/providers/faux.d.ts` under
  `node_modules/@earendil-works/`.
- Installed coding-agent credential example:
  `examples/sdk/09-api-keys-and-oauth.ts` in the pi distribution.

The durable API is experimental. The pinned release, not mutable main, is the
contract for the upcoming PostgreSQL schema and adapter.
