-- Application-owned PostgreSQL format v1, based on pi-durable 1.0.0's Storage
-- contract and SQLite format v1. Deployed by Prisma Migrate with board migrations.
-- Records/content are JSON.stringify output, NOT decoded PostgreSQL JSONB.
-- Every arbitrary indexed string is JSON.stringify(string), including kind,
-- request_id and key_value. C collation preserves exact encoded identities.
-- Hash indexes are candidate filters only: always also compare the full text.

-- Prisma does not automatically wrap PostgreSQL migrations in a transaction.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE SCHEMA agent;

CREATE TABLE agent.durable_metadata (
    singleton smallint PRIMARY KEY CHECK (singleton = 1),
    storage_format_version smallint NOT NULL CHECK (storage_format_version > 0),
    -- MAX_SAFE_INTEGER + 1 is the exhausted-allocation sentinel, not a valid ID/Seq.
    next_id bigint NOT NULL CHECK (next_id BETWEEN 2 AND 9007199254740992),
    next_seq bigint NOT NULL CHECK (next_seq BETWEEN 1 AND 9007199254740992)
);
INSERT INTO agent.durable_metadata (singleton, storage_format_version, next_id, next_seq)
    VALUES (1, 1, 2, 1);

CREATE TABLE agent.record_ids (
    id bigint PRIMARY KEY CHECK (id BETWEEN 1 AND 9007199254740991),
    record_type text COLLATE "C" NOT NULL
        CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document')),
    UNIQUE (id, record_type)
);

CREATE TABLE agent.conversations (
    id bigint PRIMARY KEY,
    record_type text GENERATED ALWAYS AS ('conversation'::text) STORED,
    owner_conversation_id bigint CHECK (owner_conversation_id BETWEEN 1 AND 9007199254740991),
    owner_task_id bigint CHECK (owner_task_id BETWEEN 1 AND 9007199254740991),
    record text NOT NULL CHECK (record IS JSON OBJECT),
    CHECK ((owner_conversation_id IS NULL) = (owner_task_id IS NULL)),
    FOREIGN KEY (id, record_type) REFERENCES agent.record_ids (id, record_type)
        DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX conversations_by_owner_conversation ON agent.conversations (owner_conversation_id, id);
CREATE INDEX conversations_by_owner_task ON agent.conversations (owner_task_id, id);

CREATE TABLE agent.entries (
    id bigint PRIMARY KEY,
    record_type text GENERATED ALWAYS AS ('entry'::text) STORED,
    conversation_id bigint NOT NULL CHECK (conversation_id BETWEEN 1 AND 9007199254740991),
    head bigint CHECK (head BETWEEN 1 AND 9007199254740991),
    commit_seq bigint NOT NULL CHECK (commit_seq BETWEEN 1 AND 9007199254740991),
    record text NOT NULL CHECK (record IS JSON OBJECT),
    FOREIGN KEY (id, record_type) REFERENCES agent.record_ids (id, record_type)
        DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX entries_by_conversation ON agent.entries (conversation_id, id DESC);
CREATE INDEX entry_heads_by_conversation ON agent.entries (conversation_id, id DESC)
    WHERE head IS NOT NULL;

-- These execution tasks/checkpoints are unrelated to public."Task" (Kanban).
CREATE TABLE agent.tasks (
    id bigint PRIMARY KEY,
    record_type text GENERATED ALWAYS AS ('task'::text) STORED,
    conversation_id bigint NOT NULL CHECK (conversation_id BETWEEN 1 AND 9007199254740991),
    kind text COLLATE "C" NOT NULL CHECK (kind IS JSON SCALAR AND left(kind, 1) = '"'),
    status text COLLATE "C" NOT NULL
        CHECK (status IN ('pending', 'running', 'waiting', 'completing', 'terminal')),
    abort_requested boolean NOT NULL,
    background boolean NOT NULL,
    record text NOT NULL CHECK (record IS JSON OBJECT),
    FOREIGN KEY (id, record_type) REFERENCES agent.record_ids (id, record_type)
        DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX tasks_by_status ON agent.tasks (status, id);
CREATE INDEX tasks_by_conversation ON agent.tasks (conversation_id, id);
CREATE INDEX tasks_by_kind ON agent.tasks ((md5(kind) COLLATE "C"), id);
CREATE INDEX tasks_by_abort_requested ON agent.tasks (abort_requested, id);
CREATE INDEX tasks_by_background ON agent.tasks (background, id);

CREATE TABLE agent.submissions (
    id bigint PRIMARY KEY,
    record_type text GENERATED ALWAYS AS ('submission'::text) STORED,
    conversation_id bigint NOT NULL CHECK (conversation_id BETWEEN 1 AND 9007199254740991),
    request_id text COLLATE "C" CHECK (request_id IS NULL OR
        (request_id IS JSON SCALAR AND left(request_id, 1) = '"')),
    status text COLLATE "C" NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
    record text NOT NULL CHECK (record IS JSON OBJECT),
    FOREIGN KEY (id, record_type) REFERENCES agent.record_ids (id, record_type)
        DEFERRABLE INITIALLY DEFERRED
);
-- Nonunique like the reference Storage. Session serializes admission/deduplication.
-- Do not impose uniqueness on a hash: collisions must not merge distinct requests.
CREATE INDEX submissions_by_request ON agent.submissions
    (conversation_id, (md5(request_id) COLLATE "C")) WHERE request_id IS NOT NULL;
CREATE INDEX submissions_by_conversation ON agent.submissions (conversation_id, id);
CREATE INDEX submissions_by_status ON agent.submissions (status, id);

CREATE TABLE agent.documents (
    id bigint PRIMARY KEY,
    record_type text GENERATED ALWAYS AS ('document'::text) STORED,
    kind text COLLATE "C" NOT NULL CHECK (kind IS JSON SCALAR AND left(kind, 1) = '"'),
    family boolean NOT NULL,
    key_value text COLLATE "C" NOT NULL CHECK (key_value IS JSON SCALAR AND left(key_value, 1) = '"'),
    scope_kind text COLLATE "C" NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
    owner_id bigint NOT NULL CHECK (owner_id BETWEEN 0 AND 9007199254740991),
    created_at bigint NOT NULL CHECK (created_at BETWEEN 1 AND 9007199254740991),
    retired_at bigint CHECK (retired_at BETWEEN created_at AND 9007199254740991),
    record text NOT NULL CHECK (record IS JSON OBJECT),
    CHECK ((scope_kind = 'session' AND owner_id = 0) OR
        (scope_kind <> 'session' AND owner_id > 0)),
    CHECK (family OR key_value = '""'),
    FOREIGN KEY (id, record_type) REFERENCES agent.record_ids (id, record_type)
        DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX documents_by_address ON agent.documents
    ((md5(kind) COLLATE "C"), scope_kind, owner_id, family,
     (md5(key_value) COLLATE "C"), created_at DESC, retired_at);
CREATE INDEX documents_by_scope ON agent.documents (scope_kind, owner_id, id);
CREATE INDEX documents_by_scope_kind ON agent.documents
    (scope_kind, owner_id, (md5(kind) COLLATE "C"), id);
-- Current-address uniqueness is checked using exact text by the serialized
-- Storage commit, not a lossy hash constraint. Retirement/recreation in one
-- batch must be evaluated against the final state, independent of write order.

CREATE TABLE agent.document_revisions (
    document_id bigint NOT NULL REFERENCES agent.documents (id) DEFERRABLE INITIALLY DEFERRED,
    seq bigint NOT NULL CHECK (seq BETWEEN 1 AND 9007199254740991),
    kind text COLLATE "C" NOT NULL CHECK (kind IN ('base', 'delta')),
    version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
    content text NOT NULL CHECK (content IS JSON),
    PRIMARY KEY (document_id, seq)
);
CREATE INDEX document_revisions_by_kind ON agent.document_revisions (document_id, kind, seq DESC);

-- Conversation identity/ancestry, transcript entries and global ID claims are
-- append-only. Task/submission records and document lifecycles are mutable.
-- Latest-only document revisions may be pruned, so they have no such trigger.
CREATE FUNCTION agent.reject_immutable_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'agent.% records are immutable', TG_TABLE_NAME USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER immutable_conversations BEFORE UPDATE OR DELETE ON agent.conversations
    FOR EACH ROW EXECUTE FUNCTION agent.reject_immutable_change();
CREATE TRIGGER immutable_entries BEFORE UPDATE OR DELETE ON agent.entries
    FOR EACH ROW EXECUTE FUNCTION agent.reject_immutable_change();
CREATE TRIGGER immutable_record_ids BEFORE UPDATE OR DELETE ON agent.record_ids
    FOR EACH ROW EXECUTE FUNCTION agent.reject_immutable_change();

COMMENT ON SCHEMA agent IS
    'Application-owned pi-durable PostgreSQL storage; public._prisma_migrations owns DDL history for both schemas.';
COMMENT ON TABLE agent.durable_metadata IS
    'One storage namespace: root ID 1, next candidate ID 2, first atomic commit sequence 1. Not a PostgreSQL sequence.';
COMMENT ON TABLE agent.tasks IS
    'Durable execution records: input, definition version, checkpoint/state, ownership, memos and outcome live in record.';
COMMENT ON TABLE agent.documents IS
    'Incarnation records with creation/retirement commit sequences; exact encoded addresses, base/delta history in revisions.';
COMMENT ON TABLE agent.entries IS
    'Immutable complete transcript entries and their atomic commit sequence; lossless serialized records, no auth values.';

COMMIT;
