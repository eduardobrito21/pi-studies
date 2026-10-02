# M1.2 study guide: what are we actually storing?

Start with the [interactive HTML guide](pi-m1.2-study.html). Open that file directly
in your browser; no server, database, network access, or API key is needed.

Run the [complete TypeScript example](examples/durable-records.ts):

```sh
bun docs/m1.2/examples/durable-records.ts
```

It uses the installed **pi-durable 1.0.0 MemoryStorage**, not an invented API.
It creates records, commits related changes atomically, replays a real Chord delta,
reads historical state, and looks up a submission by request ID. It writes nothing
to your PostgreSQL database and never calls a model. A test verifies its results.
This is a low-level Storage lesson: production admission, scheduling, semantic
validation and retries belong to Session/Harness, not to manual record construction.

## 1. Record, row, entry, document: four different words

A **record** is a typed persisted description of something in the agent's world.
For example, a `ConversationRecord` describes a conversation's identity and ancestry;
a `TaskRecord` describes one piece of execution work.

A **row** is how PostgreSQL stores that record. In most agent tables, the `record`
column contains the whole record encoded with `JSON.stringify`. Other columns
mirror selected fields for efficient filtering and ordering.

An **entry** is one particular kind of record: an immutable transcript event.
Not every record is a message; not every entry contributes a message to the model.

A **document** is structured state with an identity and lifecycle. Its content
lives separately, in bases and deltas. Its `record` describes the incarnation,
not the complete current document value.

```text
TaskRecord (JavaScript)
  id: 4
  conversationId: 1
  kind: "study.explain"
  state: { status: "running", checkpoint: { phase: "explain" } }
  ...
       ↓ JSON.stringify + mirror scan fields
agent.tasks row (PostgreSQL)
  id = 4
  conversation_id = 1
  kind = '"study.explain"'          ← encoded string, including quotes
  status = 'running'                ← fixed protocol enum, ordinary text
  record = '{"id":4,...}'           ← full JSON encoded as TEXT
```

This is **not** a purely event-sourced database: entries are append-only, but task
and submission rows hold their latest replacement records.

## 2. Every table, in plain language

### `agent.durable_metadata` — the storage's counters and format label

One singleton row holds `storage_format_version`, `next_id`, and `next_seq`.
It answers: “What encoding is this? What ID candidate and commit sequence come next?”

Initial values: singleton 1, format 1, next ID 2, next sequence 1. Conversation
ID 1 is reserved for the root, but the migration does **not** insert its record.
The owning runtime initializes it. There is no automatic per-table ID sequence.

IDs identify objects; sequences identify atomic commits. One commit may create
several IDs, replace old records, and write several document revisions. These
counters are not timestamps. Gaps are permitted; don't infer a count of objects
or commits from their maximum value.

### `agent.record_ids` — the global ID claims ledger

Each durable object claims one number and one type:

```text
1 → conversation
2 → submission
3 → entry
4 → task
5 → document
6 → entry
```

This stops entry 4 and task 4 from being different objects in the same namespace.
The deferred `(id, record_type)` foreign keys require a matching claim at commit.
The generated discriminator in each record table prevents claiming the wrong
kind. Claims are immutable. Allocation returns candidates; claiming happens
when records are committed. Revisions use `(document_id, seq)` rather than a new
global record ID. The ledger is infrastructure, not a second copy of the payload.

### `agent.conversations` — a transcript scope, not a chat message

A conversation groups transcript history and execution. Its immutable record has
an `id`, optional `parent` fork ancestry, and optional `owner` attribution.

```ts
// Conceptual unbranded JSON shapes; real IDs have TypeScript brands.
const root = { id: 1 };
const fork = {
  id: 7,
  parent: { conversationId: 1, at: 3 },
  owner: { conversationId: 1, taskId: 4 },
};
```

The fork inherits source history **through entry 3 inclusive**, then gets its own
entries. It does not require copying all ancestor entries into its table rows.
Fork-aware transcript reads follow ancestry, so a simple SQL query filtering
`entries.conversation_id = 7` is not a complete visible-history implementation.

**Parent and owner are different edges.** Parent answers “whose history do I
inherit, and through what point?” Owner answers “which task created/owns me?”
An owned conversation need not be a fork. An ownerless fork can have a parent.
Owner scan columns are mirrored; parent ancestry stays inside `record`.

### `agent.entries` — immutable things that happened in the transcript

Each entry has an ID, conversation ID, application-defined `kind`, optional
`model` messages, optional application-facing `data`, optional `byTaskId`, and
optional context controls. The database adds its `commit_seq` separately.

```ts
const entry = {
  id: 3,
  conversationId: 1,
  kind: "study.user",
  model: [{ role: "user", content: "Explain records", timestamp: 0 }],
  data: { text: "Explain records" },
};
```

`model` supplies model-facing context. `data` can supply UI or bookkeeping
information. An entry can have only `data`, with no model messages at all.
Kinds are application discriminators, not a fixed SQL list of chat roles.

Entries cannot be updated or deleted. Corrections to model context can be
represented by a new entry's `edits`: omit or replace the model contribution of
an earlier entry without rewriting history.

`head` is **not** “the latest message ID.” It selects the first entry in active
context. The newest visible entry carrying a head is the marker; its head value
is the actual lower bound. A compaction/reset can therefore change context while
old transcript events remain stored. The partial index accelerates marker lookup.

### `agent.tasks` — resumable agent work, NOT board cards

An execution task is a durable state machine: original input, registered kind,
definition version, checkpoint/state, ownership, background flag, abort mark,
optional memos, and eventual outcome. A run, generation or tool invocation can
use execution tasks. Merely storing a task does not execute it; Harness schedules it.

```text
pending → running → waiting → running → terminal
                    ↘ completing → terminal
```

This is an illustrative path, not an exhaustive transition specification.
`waiting` represents durable waits on tasks. `completing` retains an outcome
while ordinary owned work is still live. `terminal` has an outcome instead of a
checkpoint. Success is `state.outcome.status = "completed"`, not SQL status
`"completed"`. Terminal outcomes can also be failed, aborted, orphaned or faulted.

Task rows are replaced at progress boundaries, not appended for every phase.
An abort mark is a request to the runtime's abort protocol, not immediate deletion.
Memos are small durable first-writer-wins values while the task can run; they
are not a general external-effect exactly-once guarantee.

`public."Task"`, by contrast, is an actual Kanban card: string ID, title,
description, assignee, board status, creation/update timestamps. A tool might
run as `agent.tasks` work and create a board card via `server/tasks.ts`, but those
are distinct records. Future board tools must use that validated Effect service,
not directly mutate board SQL.

### `agent.submissions` — the admission receipt for an input or passive write

A submission tracks “did the runtime accept, place, and answer this request?”
It is not the text of the message, and a queued input need not have an entry yet.
The Harness inbox document can carry queued payload; the submission record
tracks lifecycle and references.

```text
input: queued → placed (entry 3) → done (answer entry 6)
                           ↘ unanswered (reason)
write: queued → done (entry 3)
           ↘ unanswered (reason)
```

These are examples; input can also become unanswered before placement.
A passive `write` appends an entry without asking for an answer and does not
use the input-only `placed` state.

A host request ID is scoped to a conversation: retrying `study-001` lets Session
find the existing receipt. The request-ID index is deliberately **nonunique**.
Serialized admission/deduplication is a runtime protocol, not something this
DDL's index magically provides. SQL NULL means absent; `JSON.stringify("")`
means a present empty-string request ID.

### `agent.documents` — a state object's address and incarnation

Examples: conversation usage, inbox state, a structured plan, task-local progress.
A document address is kind + scope + optional family key. Scopes are session,
conversation, or task. SQL uses owner ID 0 for session scope and positive IDs for
conversation/task owners.

```ts
const address = {
  kind: "study.progress",
  scope: { kind: "conversation", conversationId: 1 },
};
```

The document record adds incarnation ID and creation/retirement **commit
sequences**, despite column names `created_at` and `retired_at`. These are not dates.
Retiring ID 5 and recreating the same address yields a **new** document ID.
Address lookup can find the replacement; ID lookup never silently follows it.

Singletons have no key. A family member with key `""` is different from a singleton:
SQL stores `key_value = '""'` in both cases but uses `family` to distinguish them.
Conversation documents declare `history` (`latest` or `rewindable`) and fork
behavior (`current`, `initial`, or, for rewindable, `asOf`). Latest-only history
can be pruned; rewindable history supports historical reads. Session/task
scopes do not declare those conversation-only policies.

### `agent.document_revisions` — values and how they changed

The primary key is `(document_id, seq)`. `kind` is `base` or `delta`; `version`
is the document definition's shape version, not the commit sequence or storage
format version. `content` stores the serialized base value or ordered op batch.

```text
(document 5, seq 3, base,  version 1): {"explained":0}
(document 5, seq 4, delta, version 1): [["s",["explained"],1]]
materialized value at seq 4:         {"explained":1}
```

That delta is **real Chord syntax**, not JSON Patch. `s` sets the value at a path.
To materialize: select the newest base at/before the desired point, then apply
later delta batches in sequence order through that point. Checkpoint bases
bound replay cost. The runnable example demonstrates both historical and
current reads. A document change is state; it is not automatically a chat event.

## 3. One story ties the tables together

The sample has these exact IDs and sequences:

| Commit | What becomes visible                                                                                           |
| ------ | -------------------------------------------------------------------------------------------------------------- |
| seq 1  | Root conversation 1 and its ID claim                                                                           |
| seq 2  | Submission 2, queued, request `study-001`, and its claim                                                       |
| seq 3  | User entry 3; task 4 running; document 5 with a base; submission 2 replaced with placed                        |
| seq 4  | Answer entry 6; task 4 replaced with terminal/completed; submission 2 replaced with done; delta for document 5 |

After completion the ledger contains six objects. There are two entries, one
conversation, one task, one submission, one document, and two revisions. There
are **not** four task rows or three submission rows: replacement preserves IDs.
One atomic commit can touch several tables; `seq` names that shared boundary.

The HTML animation shows those same commits without accessing storage. Its
highlighted cards represent tables touched by a commit; the snapshots are
teaching summaries rather than full PostgreSQL row dumps.

## 4. PostgreSQL details that protect the model

- **TEXT is intentional.** `record` and revision `content` are JSON-encoded text,
  not JSONB. Escaped NUL and lone UTF-16 surrogates round-trip through JavaScript
  stringify/parse without PostgreSQL JSONB decoding/rejection.
- **Some string columns are encoded too.** Arbitrary identities such as task kind,
  request ID and document key use `JSON.stringify(string)`. Fixed status/scope
  enums and record discriminators are ordinary text. Don't encode all columns.
- **Hash buckets are not identities.** Arbitrary-length strings use MD5 expression
  indexes. Always match both hash and exact encoded text:

  ```sql
  -- $1 = JSON.stringify("study.explain")
  SELECT record
  FROM agent.tasks
  WHERE md5(kind) = md5($1) AND kind = $1
  ORDER BY id;
  ```

  This is a read-only lookup illustration, not a replacement Storage API.

- **Bigint conversion must be checked.** IDs and sequences are JavaScript safe
  integers, stored in PostgreSQL bigint. Keep pg results as strings until bounds
  are validated; counters alone may reach MAX_SAFE_INTEGER + 1 as exhaustion.
- **Not every logical edge is a SQL foreign key.** The DDL checks global type
  claims and revision-to-document references; Session/Storage owns ancestry,
  semantic references, record/column consistency, lifecycle rules and sequence
  stamping. JSON syntax checks do not validate every Pi record field.
- **Immutable vs mutable is deliberate.** Conversations, entries and ID claims
  reject UPDATE/DELETE. Tasks/submissions are replaceable; document lifecycle
  records change; latest-only revisions can be pruned.

## 5. Repository map and implementation boundary

- `docs/m1.2/pi-m1.2.md`: schema milestone, constraints and acceptance scope.
- `prisma/schema.prisma`: board plus all eight agent models. Agent `@@ignore`
  means no Prisma Client CRUD API; Migrate still owns their schema.
- `prisma/migrations/20261002220000_agent_state/migration.sql`: native DDL,
  checks, deferred FKs, indexes and immutability triggers.
- `server/tasks.ts`: Zod-validated Effect operations for the **board**.
- Installed `@earendil-works/pi-durable/dist/types.d.ts`: exact record and
  Storage contracts used for these explanations and runnable example.
- `public._prisma_migrations`: Prisma's deployment history, not agent memory.

M1.2 itself accepts the schema, not a running durable agent. At the time this
lesson was written the working tree also contained an untracked
`server/postgres-storage.ts` and integration test; these in-progress files were
left untouched. The animation does not claim they are finished or wired up.

## Check your understanding

1. Is an assistant answer a conversation row? **No: it is a transcript entry.**
2. Does a running task mean a Kanban card is IN_PROGRESS? **No: different models.**
3. Does submission `done` always have an answer? **Input does; passive write doesn't.**
4. Is document revision version 1 the same as commit seq 1? **No: independent concepts.**
5. Does fork ownership determine its inherited history? **No: the parent edge does.**
6. Can two tables independently allocate ID 4? **No: one global namespace.**
7. Does a saved checkpoint guarantee an external HTTP side effect happened once?
   **No: durable progress and external-effect idempotency are separate concerns.**
