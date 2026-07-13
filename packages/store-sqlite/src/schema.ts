import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const engineSessions = sqliteTable(
  "engine_sessions",
  {
    id: text("id").primaryKey(),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    workspace: text("workspace").notNull(),
    purpose: text("purpose").notNull(),
    status: text("status").notNull(),
    sandboxId: text("sandbox_id"),
    snapshotId: text("snapshot_id"),
    parentSessionId: text("parent_session_id"),
    parentThreadId: text("parent_thread_id"),
    /** Persisted session-default model id (e.g. "claude-haiku-4-5"). Null
     *  means "use the host's global default". Mutated via Session.setModel. */
    model: text("model"),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("engine_sessions_user").on(t.userId),
    index("engine_sessions_status").on(t.status),
    index("engine_sessions_owner").on(t.ownerType, t.ownerId),
  ],
);

export const engineThreads = sqliteTable(
  "engine_threads",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    key: text("key").notNull(),
    status: text("status").notNull(),
    activeLeafEntryId: text("active_leaf_entry_id"),
    queueMode: text("queue_mode").notNull(),
    /** Persisted pause flag — the only stored piece of queue state; the rest of QueueState derives from durable queue items. */
    paused: integer("paused"),
    model: text("model"),
    summary: text("summary"),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("engine_threads_session").on(t.sessionId),
    uniqueIndex("engine_threads_session_key").on(t.sessionId, t.key),
  ],
);

export const engineEntries = sqliteTable(
  "engine_entries",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    threadId: text("thread_id").notNull(),
    parentId: text("parent_id"),
    entryType: text("entry_type").notNull(),
    role: text("role"),
    content: text("content"),
    parts: text("parts"),
    author: text("author"),
    channel: text("channel"),
    model: text("model"),
    /** The submission that produced this entry — the transcript↔submission linkage. */
    queueItemId: text("queue_item_id"),
    /** Persisted on the turn's final assistant entry. */
    stopReason: text("stop_reason"),
    summary: text("summary"),
    coveredEntryIds: text("covered_entry_ids"),
    tokenCountBefore: integer("token_count_before"),
    tokenCountAfter: integer("token_count_after"),
    fileContext: text("file_context"),
    branchRootId: text("branch_root_id"),
    branchLeafId: text("branch_leaf_id"),
    gateId: text("gate_id"),
    resolvedAt: text("resolved_at"),
    resolution: text("resolution"),
    withdrawnReason: text("withdrawn_reason"),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("engine_entries_thread").on(t.sessionId, t.threadId, t.createdAt),
    index("engine_entries_gate").on(t.gateId),
    index("engine_entries_queue_item").on(t.queueItemId),
  ],
);

export const engineQueueItems = sqliteTable(
  "engine_queue_items",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    threadId: text("thread_id").notNull(),
    /** Idempotent admission key. Unique per session when present. */
    dispatchId: text("dispatch_id"),
    status: text("status").notNull(),
    /** SubmissionOutcome.outcome — "completed" | "failed" | "aborted" | "superseded" | "merged". */
    outcome: text("outcome"),
    error: text("error"),
    supersededByItemId: text("superseded_by_item_id"),
    mergedIntoItemId: text("merged_into_item_id"),
    content: text("content").notNull(),
    author: text("author"),
    channel: text("channel"),
    replyTarget: text("reply_target"),
    model: text("model"),
    role: text("role"),
    metadata: text("metadata"),
    attemptId: text("attempt_id"),
    attemptCount: integer("attempt_count").notNull(),
    maxAttempts: integer("max_attempts").notNull(),
    timeoutAt: integer("timeout_at").notNull(),
    abortRequestedAt: integer("abort_requested_at"),
    ownerId: text("owner_id"),
    leaseExpiresAt: integer("lease_expires_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("engine_queue_items_thread").on(t.sessionId, t.threadId, t.status),
    uniqueIndex("engine_queue_items_dispatch")
      .on(t.sessionId, t.dispatchId)
      .where(sql`dispatch_id IS NOT NULL`),
  ],
);

export const engineAttemptMarkers = sqliteTable(
  "engine_attempt_markers",
  {
    itemId: text("item_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.attemptId] })],
);

export const engineMeta = sqliteTable("engine_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const engineDecisionGates = sqliteTable(
  "engine_decision_gates",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    threadId: text("thread_id").notNull(),
    type: text("type").notNull(),
    status: text("status").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    actions: text("actions").notNull(),
    origin: text("origin"),
    context: text("context"),
    resolution: text("resolution"),
    expiresAt: integer("expires_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("engine_decision_gates_thread").on(t.sessionId, t.threadId, t.status)],
);

export const engineDecisionGateRefs = sqliteTable(
  "engine_decision_gate_refs",
  {
    id: text("id").primaryKey(),
    gateId: text("gate_id").notNull(),
    channelType: text("channel_type").notNull(),
    ref: text("ref").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("engine_decision_gate_refs_gate").on(t.gateId)],
);

export const engineEvents = sqliteTable(
  "engine_events",
  {
    sessionId: text("session_id").notNull(),
    seq: integer("seq").notNull(),
    eventKey: text("event_key").notNull(),
    threadId: text("thread_id"),
    queueItemId: text("queue_item_id"),
    userId: text("user_id"),
    eventType: text("event_type").notNull(),
    /** JSON: the full EngineEvent. */
    payload: text("payload").notNull(),
    timestamp: integer("timestamp").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.seq] }),
    uniqueIndex("engine_events_event_key").on(t.sessionId, t.eventKey),
    index("engine_events_queue_item").on(t.sessionId, t.queueItemId),
  ],
);

export const engineSuspendedTurns = sqliteTable(
  "engine_suspended_turns",
  {
    sessionId: text("session_id").notNull(),
    threadId: text("thread_id").notNull(),
    queueItemId: text("queue_item_id").notNull(),
    gateId: text("gate_id").notNull(),
    model: text("model").notNull(),
    leafEntryId: text("leaf_entry_id"),
    toolCallId: text("tool_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    toolArgs: text("tool_args").notNull(),
    resumeKey: text("resume_key").notNull(),
    attempt: integer("attempt").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.threadId] }),
    index("engine_suspended_turns_gate").on(t.gateId),
  ],
);
