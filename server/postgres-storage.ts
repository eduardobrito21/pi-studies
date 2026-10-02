import { Client } from "pg";
import { z } from "zod";
import type { Context, JsonValue } from "@earendil-works/chord";
import { apply, type Op } from "@earendil-works/chord/delta";
import { StorageRejected } from "@earendil-works/pi-durable";
import type {
  Storage,
  StorageWrite,
  Id,
  Seq,
  ConversationId,
  ConversationRecord,
  ConversationQuery,
  EntryId,
  EntryRecord,
  EntryQuery,
  TaskId,
  TaskRecord,
  TaskQuery,
  SubmissionId,
  SubmissionRecord,
  SubmissionQuery,
  DocumentId,
  DocumentRecord,
  DocumentCreate,
  DocumentContent,
  DocumentCopySource,
  DocumentAddress,
  DocumentPoint,
  DocumentQuery,
  StoredDocument,
  JsonObject,
  Cursor,
  Page,
} from "@earendil-works/pi-durable";

const MAX = BigInt(Number.MAX_SAFE_INTEGER);

const counterSchema = z.string().regex(/^\d+$/).transform(BigInt);

const cursorSchema = z.object({ after: z.number().int().safe().positive().optional() });

const limitSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER - 1);

const connectionSchema = z
  .url()
  .refine((value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol));

/** pg bigint values remain strings. Only allocation counters may contain MAX+1. */
function counter(value: string, minimum: bigint, exhausted = false): bigint {
  const parsed = counterSchema.parse(value);

  if (parsed < minimum || parsed > MAX + (exhausted ? 1n : 0n))
    throw new Error("Unsafe PostgreSQL counter");

  return parsed;
}

function sequence(value: string): Seq {
  // SAFETY: bounds checked before number conversion; the brand is erased by pi.
  return Number(counter(value, 1n)) as Seq;
}

function identifier(value: number): number {
  return z.number().int().safe().positive().parse(value);
}

function decode<T>(value: string): T {
  // SAFETY: Storage trusts Session record shapes; JSON.parse detaches JSON-encoded TEXT.
  return JSON.parse(value) as T;
}

function page<T extends { readonly id: number }>(values: T[], limit: number): Page<T, Cursor> {
  const items = values.slice(0, limit);

  return values.length > limit ? { items, next: { after: items[items.length - 1].id } } : { items };
}

function scopeParts(scope: DocumentRecord["scope"]): [string, number] {
  switch (scope.kind) {
    case "session":
      return ["session", 0];
    case "conversation":
      return ["conversation", scope.conversationId];
    case "task":
      return ["task", scope.taskId];
  }
}

function addressParts(address: DocumentAddress): [string, string, number, boolean, string] {
  const [kind, owner] = scopeParts(address.scope);

  return [
    JSON.stringify(address.kind),
    kind,
    owner,
    address.key !== undefined,
    JSON.stringify(address.key ?? ""),
  ];
}

function currentOnly(record: DocumentRecord): boolean {
  return record.scope.kind !== "conversation" || record.history === "latest";
}

function alive(record: DocumentRecord, at: DocumentPoint): boolean {
  return at === "current"
    ? record.retiredAt === undefined
    : record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);
}

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

type DocumentAction = {
  create?: DocumentCreate;
  content?: DocumentContent;
  copy?: DocumentCopySource;
  retire: boolean;
};

type Table = "conversations" | "entries" | "tasks" | "submissions" | "documents";

/** Application-owned agent format v1; DDL belongs exclusively to Prisma Migrate. */
export class PostgresStorage implements Storage {
  private tail: Promise<void> = Promise.resolve();
  private closing?: Promise<void>;
  private closed = false;
  private lost?: Error;
  private constructor(private readonly client: Client) {
    // Never reconnect: this backend identity owns the database-scoped advisory lock.
    client.on("error", (error: Error) => {
      this.lost = error;
    });
    client.on("end", () => {
      this.lost ??= new Error("PostgresStorage owner connection lost");
    });
  }

  static async open(connectionString: string): Promise<PostgresStorage> {
    const client = new Client({
      connectionString: connectionSchema.parse(connectionString),
      connectionTimeoutMillis: 5000,
    });

    const storage = new PostgresStorage(client);

    try {
      await client.connect();

      // Fixed application namespace, database-scoped, session-level (not transaction-level).
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(1885955190, 1) AS acquired",
      );

      if (!lock.rows[0].acquired) throw new Error("PostgresStorage already has an active owner");

      const metadata = await client.query<{
        storage_format_version: number;
        next_id: string;
        next_seq: string;
      }>(
        "SELECT storage_format_version, next_id, next_seq FROM agent.durable_metadata WHERE singleton = 1",
      );

      const row = metadata.rows[0];

      if (!row || row.storage_format_version !== 1)
        throw new Error("Unsupported or missing durable storage format");
      counter(row.next_id, 2n, true);
      counter(row.next_seq, 1n, true);
      storage.assertOpen();

      return storage;
    } catch (error) {
      try {
        await client.end();
      } catch {
        /* Preserve initialization failure. */
      }

      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("PostgresStorage is closed");

    if (this.lost) throw new Error("PostgresStorage owner connection lost", { cause: this.lost });
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      this.assertOpen();
    } catch (error) {
      return Promise.reject(error);
    }

    const result = this.tail.then(() => {
      // Already-admitted operations may drain during close, but not after ownership loss.
      if (this.lost) throw new Error("PostgresStorage owner connection lost", { cause: this.lost });

      return operation();
    });

    const guarded = result.catch((error) => {
      // pg can reject an active query before emitting its connection error/end event.
      const failure = z
        .object({ code: z.string().optional(), message: z.string() })
        .safeParse(error);

      if (
        failure.success &&
        (/^(08|57P0[123]|ECONN|EPIPE|ETIMEDOUT)/.test(failure.data.code ?? "") ||
          /^(Connection terminated|Client has encountered a connection error)/.test(
            failure.data.message,
          ))
      ) {
        this.lost ??= new Error("Owner backend disconnected", { cause: error });
      }

      if (this.lost) throw new Error("PostgresStorage owner connection lost", { cause: error });

      throw error;
    });

    this.tail = guarded.then(
      () => {},
      () => {},
    );

    return guarded;
  }
  private async transaction<T>(operation: () => Promise<T>): Promise<T> {
    await this.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");

    try {
      const result = await operation();

      if (this.lost) throw new Error("PostgresStorage owner connection lost", { cause: this.lost });
      await this.client.query("COMMIT");

      return result;
    } catch (error) {
      try {
        await this.client.query("ROLLBACK");
      } catch {
        /* A dead connection cannot commit; retain original failure. */
      }

      throw error;
    }
  }
  close(_context: Context): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      // Ending this exact backend releases the session lock, including on failure.
      this.closing = this.tail.then(() => this.client.end());
    }

    return this.closing;
  }
  mintId<I extends Id<string>>(): Promise<I> {
    return this.run(() =>
      this.transaction(async () => {
        const result = await this.client.query<{ next_id: string }>(
          "SELECT next_id FROM agent.durable_metadata WHERE singleton = 1 FOR UPDATE",
        );

        const id = counter(result.rows[0].next_id, 2n, true);

        if (id > MAX) throw new Error("ID space is exhausted");
        await this.client.query(
          "UPDATE agent.durable_metadata SET next_id = $1 WHERE singleton = 1",
          [(id + 1n).toString()],
        );

        // SAFETY: allocation range validated above. Persist even unused candidates across restart.
        return Number(id) as I;
      }),
    );
  }
  commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
    // Capture at admission, not when the queue eventually starts.
    let detached: StorageWrite[];

    try {
      detached = decode<StorageWrite[]>(JSON.stringify(writes));
    } catch (error) {
      return Promise.reject(error);
    }

    return this.run(() =>
      this.transaction(async () => {
        const metadata = await this.client.query<{ next_id: string; next_seq: string }>(
          "SELECT next_id, next_seq FROM agent.durable_metadata WHERE singleton = 1 FOR UPDATE",
        );

        const seq = sequence(metadata.rows[0].next_seq);
        let nextId = counter(metadata.rows[0].next_id, 2n, true);
        const claims = new Map<number, string>();
        const actions = this.documentActions(detached);

        for (const write of detached) {
          if (write.type === "document.change" || write.type === "document.retire") {
            identifier(write.id);
            continue;
          }

          const documentWrite = write.type === "document.create" || write.type === "document.copy";
          const id = identifier(documentWrite ? write.record.id : write.value.id);
          const type = documentWrite ? "document" : write.type;

          const previous = await this.client.query<{ record_type: string }>(
            "SELECT record_type FROM agent.record_ids WHERE id = $1",
            [id],
          );

          const existing = previous.rows[0]?.record_type;
          const earlier = claims.get(id);

          if (
            existing !== undefined &&
            (existing !== type || ["conversation", "entry", "document"].includes(type))
          )
            throw new Error(`ID ${id} already belongs to ${existing}`);

          if (
            earlier !== undefined &&
            (earlier !== type || ["conversation", "entry", "document"].includes(type))
          )
            throw new Error(`ID ${id} is written more than once or as two record types`);
          claims.set(id, type);
          nextId = nextId > BigInt(id) ? nextId : BigInt(id) + 1n;
        }

        await this.checkDocuments(actions);

        for (const [id, type] of claims)
          await this.client.query(
            "INSERT INTO agent.record_ids (id, record_type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
            [id, type],
          );

        for (const write of detached) await this.writeTable(write, seq);
        await this.writeDocuments(actions, seq);
        await this.client.query(
          "UPDATE agent.durable_metadata SET next_id = $1, next_seq = $2 WHERE singleton = 1",
          [nextId.toString(), (BigInt(seq) + 1n).toString()],
        );

        return seq;
      }),
    );
  }
  private async record<T>(table: Table, id: number): Promise<T | undefined> {
    // Table is an internal closed union, never caller-supplied SQL.
    const rows = await this.client.query<{ record: string }>(
      `SELECT record FROM agent.${table} WHERE id = $1`,
      [id],
    );

    return rows.rows[0] ? decode<T>(rows.rows[0].record) : undefined;
  }
  conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
    return this.run(() => this.record("conversations", id));
  }
  task(id: TaskId, _context: Context): Promise<StoredTask | undefined> {
    return this.run(() => this.record("tasks", id));
  }
  submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
    return this.run(() => this.record("submissions", id));
  }

  private async scan<T extends { readonly id: number }>(
    table: Table,
    filters: [string, string | number | boolean][],
    limit: number,
    cursor?: Cursor,
  ): Promise<Page<T, Cursor>> {
    limitSchema.parse(limit);
    const params: (string | number | boolean)[] = [cursorSchema.parse(cursor ?? {}).after ?? 0];
    const clauses = ["id > $1"];

    for (const [column, value] of filters) {
      params.push(value);
      const param = `$${params.length}`;
      clauses.push(
        column === "kind"
          ? `md5(kind) = md5(${param}) AND kind = ${param}`
          : `${column} = ${param}`,
      );
    }

    params.push(limit + 1);

    const rows = await this.client.query<{ record: string }>(
      `SELECT record FROM agent.${table} WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT $${params.length}`,
      params,
    );

    return page(
      rows.rows.map((row) => decode<T>(row.record)),
      limit,
    );
  }
  scanConversations(
    query: ConversationQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<ConversationRecord, Cursor>> {
    return this.run(() => {
      const filters: [string, number][] = [];

      if (query.ownerConversationId !== undefined)
        filters.push(["owner_conversation_id", query.ownerConversationId]);

      if (query.ownerTaskId !== undefined) filters.push(["owner_task_id", query.ownerTaskId]);

      return this.scan("conversations", filters, limit, cursor);
    });
  }
  scanTasks(
    query: TaskQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<StoredTask, Cursor>> {
    return this.run(() => {
      const filters: [string, string | number | boolean][] = [];

      if (query.conversationId !== undefined)
        filters.push(["conversation_id", query.conversationId]);

      if (query.kind !== undefined) filters.push(["kind", JSON.stringify(query.kind)]);

      if (query.status !== undefined) filters.push(["status", query.status]);

      if (query.abortRequested !== undefined)
        filters.push(["abort_requested", query.abortRequested]);

      if (query.background !== undefined) filters.push(["background", query.background]);

      return this.scan("tasks", filters, limit, cursor);
    });
  }
  scanSubmissions(
    query: SubmissionQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<SubmissionRecord, Cursor>> {
    return this.run(() => {
      const filters: [string, string | number][] = [];

      if (query.conversationId !== undefined)
        filters.push(["conversation_id", query.conversationId]);

      if (query.status !== undefined) filters.push(["status", query.status]);

      return this.scan("submissions", filters, limit, cursor);
    });
  }
  submissionByRequest(
    conversationId: ConversationId,
    requestId: string,
    _context: Context,
  ): Promise<SubmissionRecord | undefined> {
    return this.run(async () => {
      const rows = await this.client.query<{ record: string }>(
        "SELECT record FROM agent.submissions WHERE conversation_id = $1 AND md5(request_id) = md5($2) AND request_id = $2 ORDER BY id LIMIT 1",
        [conversationId, JSON.stringify(requestId)],
      );

      return rows.rows[0] ? decode<SubmissionRecord>(rows.rows[0].record) : undefined;
    });
  }

  private async ancestry(id: ConversationId): Promise<{ id: ConversationId; upper: number }[]> {
    const chain: { id: ConversationId; upper: number }[] = [];
    const seen = new Set<ConversationId>();
    let upper = Number.MAX_SAFE_INTEGER;

    while (true) {
      if (seen.has(id)) throw new Error("Cyclic conversation ancestry");
      seen.add(id);
      const conversation = await this.record<ConversationRecord>("conversations", id);

      if (!conversation) throw new Error(`Unknown conversation: ${id}`);
      chain.push({ id, upper });

      if (!conversation.parent) return chain;
      upper = Math.min(upper, conversation.parent.at);
      id = conversation.parent.conversationId;
    }
  }
  entry(id: EntryId, context: Context): Promise<{ entry: EntryRecord; commitSeq: Seq } | undefined>;
  entry(
    conversationId: ConversationId,
    id: EntryId,
    context: Context,
  ): Promise<{ entry: EntryRecord; commitSeq: Seq } | undefined>;
  entry(
    idOrConversation: EntryId | ConversationId,
    idOrContext: EntryId | Context,
    context?: Context,
  ): Promise<{ entry: EntryRecord; commitSeq: Seq } | undefined> {
    return this.run(async () => {
      // Overload discrimination is by the third argument, not by runtime record shape.
      const id = context === undefined ? idOrConversation : idOrContext;
      const parsedId = z.number().int().safe().positive().parse(id);

      // SAFETY: third argument selects the conversation overload; both IDs are validated numeric brands.
      const chain =
        context === undefined ? undefined : await this.ancestry(idOrConversation as ConversationId);

      const rows = await this.client.query<{ record: string; commit_seq: string }>(
        "SELECT record, commit_seq FROM agent.entries WHERE id = $1",
        [parsedId],
      );

      if (!rows.rows[0]) return undefined;
      const entry = decode<EntryRecord>(rows.rows[0].record);

      if (
        chain &&
        !chain.some(
          (ancestor) => ancestor.id === entry.conversationId && entry.id <= ancestor.upper,
        )
      )
        return undefined;

      return { entry, commitSeq: sequence(rows.rows[0].commit_seq) };
    });
  }
  findLatestHeadMarker(
    conversationId: ConversationId,
    atOrBeforeEntryId: EntryId | undefined,
    _context: Context,
  ): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
    return this.run(async () => {
      for (const ancestor of await this.ancestry(conversationId)) {
        const rows = await this.client.query<{ record: string }>(
          "SELECT record FROM agent.entries WHERE conversation_id = $1 AND head IS NOT NULL AND id <= $2 ORDER BY id DESC LIMIT 1",
          [ancestor.id, Math.min(ancestor.upper, atOrBeforeEntryId ?? Number.MAX_SAFE_INTEGER)],
        );

        if (rows.rows[0])
          return decode<EntryRecord & { readonly head: EntryId }>(rows.rows[0].record);
      }

      return undefined;
    });
  }
  scanEntries(
    query: EntryQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<EntryRecord, Cursor>> {
    return this.run(async () => {
      limitSchema.parse(limit);
      const after = cursorSchema.parse(cursor ?? {}).after;

      const upper = Math.min(
        query.maxEntryId ?? Number.MAX_SAFE_INTEGER,
        after === undefined ? Number.MAX_SAFE_INTEGER : after - 1,
      );

      const values: EntryRecord[] = [];

      for (const ancestor of await this.ancestry(query.conversationId)) {
        const rows = await this.client.query<{ record: string }>(
          "SELECT record FROM agent.entries WHERE conversation_id = $1 AND id >= $2 AND id <= $3 ORDER BY id DESC LIMIT $4",
          [
            ancestor.id,
            query.minEntryId ?? 1,
            Math.min(upper, ancestor.upper),
            limit + 1 - values.length,
          ],
        );

        for (const row of rows.rows) values.push(decode<EntryRecord>(row.record));

        if (values.length > limit) break;
      }

      return page(values, limit);
    });
  }

  private async lookupDocument(
    address: DocumentAddress,
    at: DocumentPoint,
  ): Promise<DocumentRecord | undefined> {
    const params: (string | number | boolean)[] = addressParts(address);
    let lifetime = "retired_at IS NULL";

    if (at !== "current") {
      params.push(at);
      lifetime = "created_at <= $6 AND (retired_at IS NULL OR retired_at > $6)";
    }

    const rows = await this.client.query<{ record: string }>(
      `SELECT record FROM agent.documents WHERE md5(kind) = md5($1) AND kind = $1 AND scope_kind = $2 AND owner_id = $3 AND family = $4 AND md5(key_value) = md5($5) AND key_value = $5 AND ${lifetime} ORDER BY created_at DESC LIMIT 1`,
      params,
    );

    return rows.rows[0] ? decode<DocumentRecord>(rows.rows[0].record) : undefined;
  }
  findDocument(
    address: DocumentAddress,
    at: DocumentPoint,
    _context: Context,
  ): Promise<DocumentRecord | undefined> {
    return this.run(() => this.lookupDocument(address, at));
  }
  document(
    id: DocumentId,
    at: DocumentPoint,
    _context: Context,
  ): Promise<StoredDocument | undefined> {
    return this.run(() => this.transaction(() => this.materialize(id, at)));
  }
  scanDocuments(
    query: DocumentQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<DocumentRecord, Cursor>> {
    return this.run(async () => {
      limitSchema.parse(limit);
      const [scope, owner] = scopeParts(query.scope);

      const params: (string | number)[] = [
        scope,
        owner,
        cursorSchema.parse(cursor ?? {}).after ?? 0,
      ];

      const clauses = ["scope_kind = $1", "owner_id = $2", "id > $3"];

      if (query.kind !== undefined) {
        params.push(JSON.stringify(query.kind));
        clauses.push("md5(kind) = md5($4) AND kind = $4");
      }

      if (query.at === "current") clauses.push("retired_at IS NULL");
      else {
        params.push(query.at);
        clauses.push(
          `created_at <= $${params.length} AND (retired_at IS NULL OR retired_at > $${params.length})`,
        );
      }

      params.push(limit + 1);

      const rows = await this.client.query<{ record: string }>(
        `SELECT record FROM agent.documents WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT $${params.length}`,
        params,
      );

      return page(
        rows.rows.map((row) => decode<DocumentRecord>(row.record)),
        limit,
      );
    });
  }
  private async materialize(
    id: DocumentId,
    at: DocumentPoint,
  ): Promise<StoredDocument | undefined> {
    const record = await this.record<DocumentRecord>("documents", id);

    if (!record) return undefined;

    if (at !== "current" && currentOnly(record))
      throw new Error(`Document ${id} does not retain historical content`);

    if (!alive(record, at)) return undefined;
    const upper = at === "current" ? Number.MAX_SAFE_INTEGER : at;

    const bases = await this.client.query<{ seq: string; version: string; content: string }>(
      "SELECT seq, version, content FROM agent.document_revisions WHERE document_id = $1 AND kind = 'base' AND seq <= $2 ORDER BY seq DESC LIMIT 1",
      [id, upper],
    );

    const base = bases.rows[0];

    if (!base) throw new Error(`Document ${id} is missing a required base`);
    const version = Number(counter(base.version, 1n));
    const baseSeq = sequence(base.seq);

    const tail = await this.client.query<{
      seq: string;
      kind: string;
      version: string;
      content: string;
    }>(
      "SELECT seq, kind, version, content FROM agent.document_revisions WHERE document_id = $1 AND seq > $2 AND seq <= $3 ORDER BY seq",
      [id, baseSeq, upper],
    );

    let value = decode<JsonObject>(base.content);

    for (const revision of tail.rows) {
      sequence(revision.seq);

      if (revision.kind !== "delta" || Number(counter(revision.version, 1n)) !== version)
        throw new Error(`Document ${id} crosses a stored version boundary without a base`);
      value = apply(value, decode<Op[]>(revision.content));
    }

    return { record, version, value, deltasSinceBase: tail.rows.length };
  }

  private documentActions(writes: readonly StorageWrite[]): Map<DocumentId, DocumentAction> {
    const actions = new Map<DocumentId, DocumentAction>();

    for (const write of writes) {
      if (
        write.type === "conversation" ||
        write.type === "entry" ||
        write.type === "task" ||
        write.type === "submission"
      )
        continue;

      const id =
        write.type === "document.create" || write.type === "document.copy"
          ? write.record.id
          : write.id;

      const action = actions.get(id) ?? { retire: false };
      actions.set(id, action);

      if (write.type === "document.retire") {
        if (action.retire) throw new Error(`Document ${id} is retired more than once`);
        action.retire = true;
      } else {
        if (action.content || action.copy || action.create)
          throw new Error(`Document ${id} has more than one content command`);

        if (write.type === "document.create") {
          action.create = write.record;
          action.content = write.content;
        } else if (write.type === "document.copy") {
          action.create = write.record;
          action.copy = write.source;
        } else action.content = write.content;
      }
    }

    return actions;
  }
  private async checkDocuments(actions: Map<DocumentId, DocumentAction>): Promise<void> {
    const counts = new Map<string, number>();

    for (const [id, action] of actions) {
      if (action.copy && actions.has(action.copy.id))
        throw new StorageRejected(`Document copy ${id} source is changed in the copy batch`);
      const existing = await this.record<DocumentRecord>("documents", id);

      if (!action.create && !existing) throw new Error(`Unknown document: ${id}`);

      if (action.create && existing) throw new Error(`Document ${id} already exists`);

      if (existing?.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);

      if (action.content?.kind === "delta") {
        const previous = await this.client.query<{ version: string }>(
          "SELECT version FROM agent.document_revisions WHERE document_id = $1 ORDER BY seq DESC LIMIT 1",
          [id],
        );

        if (!previous.rows[0]) throw new Error(`Document ${id} delta has no base`);

        if (Number(counter(previous.rows[0].version, 1n)) !== action.content.version)
          throw new Error(`Document ${id} version transition requires a base`);
      }

      const record = action.create ?? existing;

      if (!record) throw new Error(`Unknown document: ${id}`);
      const key = JSON.stringify(addressParts(record));
      let count = counts.get(key) ?? ((await this.lookupDocument(record, "current")) ? 1 : 0);

      if (action.retire && existing) count--;

      if (action.create && !action.retire) count++;
      counts.set(key, count);
    }

    for (const count of counts.values())
      if (count > 1) throw new Error("Document address already has a current incarnation");
  }
  private async writeTable(write: StorageWrite, seq: Seq): Promise<void> {
    switch (write.type) {
      case "conversation":
        await this.client.query(
          "INSERT INTO agent.conversations (id, owner_conversation_id, owner_task_id, record) VALUES ($1, $2, $3, $4)",
          [
            write.value.id,
            write.value.owner?.conversationId ?? null,
            write.value.owner?.taskId ?? null,
            JSON.stringify(write.value),
          ],
        );
        break;
      case "entry":
        await this.client.query(
          "INSERT INTO agent.entries (id, conversation_id, head, commit_seq, record) VALUES ($1, $2, $3, $4, $5)",
          [
            write.value.id,
            write.value.conversationId,
            write.value.head ?? null,
            seq,
            JSON.stringify(write.value),
          ],
        );
        break;
      case "task":
        await this.client.query(
          `INSERT INTO agent.tasks (id, conversation_id, kind, status, abort_requested, background, record) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO UPDATE SET conversation_id = EXCLUDED.conversation_id, kind = EXCLUDED.kind, status = EXCLUDED.status, abort_requested = EXCLUDED.abort_requested, background = EXCLUDED.background, record = EXCLUDED.record`,
          [
            write.value.id,
            write.value.conversationId,
            JSON.stringify(write.value.kind),
            write.value.state.status,
            write.value.abortRequested,
            write.value.background,
            JSON.stringify(write.value),
          ],
        );
        break;
      case "submission":
        await this.client.query(
          `INSERT INTO agent.submissions (id, conversation_id, request_id, status, record) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO UPDATE SET conversation_id = EXCLUDED.conversation_id, request_id = EXCLUDED.request_id, status = EXCLUDED.status, record = EXCLUDED.record`,
          [
            write.value.id,
            write.value.conversationId,
            write.value.requestId === undefined ? null : JSON.stringify(write.value.requestId),
            write.value.status,
            JSON.stringify(write.value),
          ],
        );
        break;
      default:
        break;
    }
  }
  private async writeDocuments(actions: Map<DocumentId, DocumentAction>, seq: Seq): Promise<void> {
    for (const [id, action] of actions) {
      let content = action.content;

      if (action.copy) {
        try {
          const stored = await this.materialize(action.copy.id, action.copy.at);
          const create = action.create;

          if (
            !stored ||
            !create ||
            stored.record.scope.kind !== "conversation" ||
            create.scope.kind !== "conversation" ||
            stored.record.kind !== create.kind ||
            stored.record.key !== create.key ||
            stored.record.history !== create.history ||
            stored.record.fork !== create.fork
          )
            throw new Error(
              "Fork source document does not match the copied record or cannot be read",
            );
          content = { kind: "base", version: stored.version, value: stored.value };
        } catch (error) {
          throw new StorageRejected(`Document copy ${id} was rejected`, { cause: error });
        }
      }

      let record: DocumentRecord;

      if (action.create) {
        record = { ...action.create, createdAt: seq };

        if (action.retire) record = { ...record, retiredAt: seq };
        await this.client.query(
          "INSERT INTO agent.documents (id, kind, scope_kind, owner_id, family, key_value, created_at, retired_at, record) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
          [id, ...addressParts(record), seq, action.retire ? seq : null, JSON.stringify(record)],
        );
      } else {
        const existing = await this.record<DocumentRecord>("documents", id);

        if (!existing) throw new Error(`Unknown document: ${id}`);
        record = existing;
      }

      if (content) {
        if (content.kind === "base" && currentOnly(record))
          await this.client.query("DELETE FROM agent.document_revisions WHERE document_id = $1", [
            id,
          ]);
        await this.client.query(
          "INSERT INTO agent.document_revisions (document_id, seq, kind, version, content) VALUES ($1, $2, $3, $4, $5)",
          [
            id,
            seq,
            content.kind,
            identifier(content.version),
            JSON.stringify(content.kind === "base" ? content.value : content.ops),
          ],
        );
      }

      if (action.retire) {
        if (!action.create) {
          record = { ...record, retiredAt: seq };
          await this.client.query(
            "UPDATE agent.documents SET retired_at = $1, record = $2 WHERE id = $3",
            [seq, JSON.stringify(record), id],
          );
        }

        if (currentOnly(record))
          await this.client.query("DELETE FROM agent.document_revisions WHERE document_id = $1", [
            id,
          ]);
      }
    }
  }
}
