import type {
  BranchSummaryEntry,
  CommandResultEntry,
  CompactionEntry,
  DecisionGate,
  DecisionGateEntry,
  MessageEntry,
  SessionEntry,
  SettlePatchRef,
} from "@valet/engine";

export function jsonOrNull<T>(value: T | undefined | null): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export function parseJson<T>(value: string | null | undefined): T | undefined {
  if (value === null || value === undefined) return undefined;
  return JSON.parse(value) as T;
}

/** Like parseJson, but for NOT NULL columns where the value is guaranteed present. */
export function parseJsonRequired<T>(value: string): T {
  return JSON.parse(value) as T;
}

/**
 * Postgres (node-postgres AND PGlite) returns `bigint` columns as strings by
 * default, to avoid silently losing precision outside JS's safe-integer
 * range. Every ms-timestamp column in this schema is `bigint` (decision 7 of
 * docs/specs/2026-07-15-postgres-backend-design.md: timestamps stay JS
 * numbers on the TS side) — every row-mapper in this file funnels those
 * columns through `toNum`/`toNumOrNull` so no bigint-as-string ever leaks
 * into a returned `SessionData`/`ThreadData`/`QueueItem`/etc.
 */
export function toNum(value: unknown, field = "value"): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isNaN(n)) {
      throw new Error(`expected numeric value for ${field}, got non-numeric string ${JSON.stringify(value)}`);
    }
    return n;
  }
  throw new Error(`expected numeric value for ${field}, got ${typeof value}`);
}

export function toNumOrNull(value: unknown, field = "value"): number | null {
  return value === null || value === undefined ? null : toNum(value, field);
}

export function asString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`expected string for ${field}, got ${typeof value}`);
  return value;
}

export function asStringOrNull(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : asString(value, field);
}

/**
 * Validates and narrows a string into a valid CommandSource enum value.
 * Invalid values fall back to "builtin".
 */
export function asCommandSource(value: unknown): CommandResultEntry["source"] {
  const validSources: CommandResultEntry["source"][] = ["builtin", "skill", "plugin"];
  if (typeof value === "string" && validSources.includes(value as CommandResultEntry["source"])) {
    return value as CommandResultEntry["source"];
  }
  return "builtin";
}

/** Raw column shape of a `SELECT * FROM engine_entries` row. */
export interface EntryRow {
  id: string;
  sessionId: string;
  threadId: string;
  parentId: string | null;
  entryType: string;
  role: string | null;
  content: string | null;
  parts: string | null;
  signal: string | null;
  author: string | null;
  channel: string | null;
  model: string | null;
  queueItemId: string | null;
  stopReason: string | null;
  summary: string | null;
  coveredEntryIds: string | null;
  tokenCountBefore: number | null;
  tokenCountAfter: number | null;
  fileContext: string | null;
  branchRootId: string | null;
  branchLeafId: string | null;
  gateId: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  withdrawnReason: string | null;
  metadata: string | null;
  usage: string | null;
  cost: string | null;
  attachments: string | null;
  createdAt: number;
}

/** Narrows a raw `engine_entries` row (as returned by pg's query()) into an EntryRow. */
export function rawToEntryRow(raw: Record<string, unknown>): EntryRow {
  return {
    id: asString(raw.id, "id"),
    sessionId: asString(raw.session_id, "session_id"),
    threadId: asString(raw.thread_id, "thread_id"),
    parentId: asStringOrNull(raw.parent_id, "parent_id"),
    entryType: asString(raw.entry_type, "entry_type"),
    role: asStringOrNull(raw.role, "role"),
    content: asStringOrNull(raw.content, "content"),
    parts: asStringOrNull(raw.parts, "parts"),
    signal: asStringOrNull(raw.signal, "signal"),
    author: asStringOrNull(raw.author, "author"),
    channel: asStringOrNull(raw.channel, "channel"),
    model: asStringOrNull(raw.model, "model"),
    queueItemId: asStringOrNull(raw.queue_item_id, "queue_item_id"),
    stopReason: asStringOrNull(raw.stop_reason, "stop_reason"),
    summary: asStringOrNull(raw.summary, "summary"),
    coveredEntryIds: asStringOrNull(raw.covered_entry_ids, "covered_entry_ids"),
    tokenCountBefore: toNumOrNull(raw.token_count_before, "token_count_before"),
    tokenCountAfter: toNumOrNull(raw.token_count_after, "token_count_after"),
    fileContext: asStringOrNull(raw.file_context, "file_context"),
    branchRootId: asStringOrNull(raw.branch_root_id, "branch_root_id"),
    branchLeafId: asStringOrNull(raw.branch_leaf_id, "branch_leaf_id"),
    gateId: asStringOrNull(raw.gate_id, "gate_id"),
    resolvedAt: asStringOrNull(raw.resolved_at, "resolved_at"),
    resolution: asStringOrNull(raw.resolution, "resolution"),
    withdrawnReason: asStringOrNull(raw.withdrawn_reason, "withdrawn_reason"),
    metadata: asStringOrNull(raw.metadata, "metadata"),
    usage: asStringOrNull(raw.usage, "usage"),
    cost: asStringOrNull(raw.cost, "cost"),
    attachments: asStringOrNull(raw.attachments, "attachments"),
    createdAt: toNum(raw.created_at, "created_at"),
  };
}

export interface EntryInsertRow {
  id: string;
  sessionId: string;
  threadId: string;
  parentId: string | null;
  entryType: string;
  role: string | null;
  content: string | null;
  parts: string | null;
  signal: string | null;
  author: string | null;
  channel: string | null;
  model: string | null;
  queueItemId: string | null;
  stopReason: string | null;
  summary: string | null;
  coveredEntryIds: string | null;
  tokenCountBefore: number | null;
  tokenCountAfter: number | null;
  fileContext: string | null;
  branchRootId: string | null;
  branchLeafId: string | null;
  gateId: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  withdrawnReason: string | null;
  metadata: string | null;
  usage: string | null;
  cost: string | null;
  attachments: string | null;
  createdAt: number;
}

/**
 * Serializes message attachments for the `attachments` text column.
 * `data` bytes do not survive JSON.stringify (a Uint8Array becomes an index
 * map), so byte-backed attachments are normalized to a `data:` URL here and
 * the raw bytes are dropped.
 */
export function attachmentsToJson(attachments: MessageEntry["attachments"]): string | null {
  if (!attachments || attachments.length === 0) return null;
  const serializable = attachments.map((att) => {
    const { data, ...rest } = att;
    if (data && !rest.url) {
      return { ...rest, url: `data:${att.mimeType};base64,${Buffer.from(data).toString("base64")}` };
    }
    return rest;
  });
  return JSON.stringify(serializable);
}

export function entryToRow(entry: SessionEntry): EntryInsertRow {
  const base: EntryInsertRow = {
    id: entry.id,
    sessionId: entry.sessionId,
    threadId: entry.threadId,
    parentId: entry.parentId,
    entryType: entry.type,
    role: null,
    content: null,
    parts: null,
    signal: null,
    author: null,
    channel: null,
    model: null,
    queueItemId: entry.queueItemId ?? null,
    stopReason: null,
    summary: null,
    coveredEntryIds: null,
    tokenCountBefore: null,
    tokenCountAfter: null,
    fileContext: null,
    branchRootId: null,
    branchLeafId: null,
    gateId: null,
    resolvedAt: null,
    resolution: null,
    withdrawnReason: null,
    metadata: jsonOrNull(entry.metadata),
    usage: null,
    cost: null,
    attachments: null,
    createdAt: entry.createdAt,
  };
  switch (entry.type) {
    case "message":
      return {
        ...base,
        role: entry.role,
        content: entry.content,
        parts: jsonOrNull(entry.parts),
        signal: jsonOrNull(entry.signal),
        author: jsonOrNull(entry.author),
        channel: jsonOrNull(entry.channel),
        model: entry.model ?? null,
        stopReason: entry.stopReason ?? null,
        usage: jsonOrNull(entry.usage),
        cost: jsonOrNull(entry.cost),
        attachments: attachmentsToJson(entry.attachments),
      };
    case "compaction":
      return {
        ...base,
        summary: entry.summary,
        coveredEntryIds: JSON.stringify(entry.coveredEntryIds),
        tokenCountBefore: entry.tokenCountBefore,
        tokenCountAfter: entry.tokenCountAfter,
        fileContext: jsonOrNull(entry.fileContext),
      };
    case "branch_summary":
      return {
        ...base,
        branchRootId: entry.branchRootId,
        branchLeafId: entry.branchLeafId,
        summary: entry.summary,
      };
    case "decision_gate":
      // The gate snapshot lives in metadata under a reserved `gate` key so we
      // don't need a dedicated text column for it.
      return {
        ...base,
        gateId: entry.gate.id,
        metadata: JSON.stringify({ gate: entry.gate, ...(entry.metadata ?? {}) }),
        resolvedAt: entry.resolvedAt ?? null,
        resolution: jsonOrNull(entry.resolution),
        withdrawnReason: entry.withdrawnReason ?? null,
      };
    case "command_result":
      // command, source, ok, and output stored in metadata as opaque JSON
      // per Task 8 design (no dedicated columns needed).
      return {
        ...base,
        content: entry.output,
        metadata: JSON.stringify({
          ...(entry.metadata ?? {}),
          command: entry.command,
          source: entry.source,
          ok: entry.ok,
        }),
      };
  }
}

export function rowToEntry(row: EntryRow): SessionEntry {
  switch (row.entryType) {
    case "message": {
      const e: MessageEntry = {
        id: row.id,
        sessionId: row.sessionId,
        threadId: row.threadId,
        parentId: row.parentId,
        type: "message",
        role: (row.role as MessageEntry["role"]) ?? "user",
        content: row.content ?? "",
        parts: parseJson(row.parts),
        signal: parseJson(row.signal),
        author: parseJson(row.author),
        channel: parseJson(row.channel),
        model: row.model ?? undefined,
        stopReason: (row.stopReason as MessageEntry["stopReason"]) ?? undefined,
        usage: parseJson(row.usage),
        cost: parseJson(row.cost),
        attachments: parseJson(row.attachments),
        metadata: parseJson(row.metadata),
        createdAt: row.createdAt,
        queueItemId: row.queueItemId ?? undefined,
      };
      return e;
    }
    case "compaction": {
      const e: CompactionEntry = {
        id: row.id,
        sessionId: row.sessionId,
        threadId: row.threadId,
        parentId: row.parentId,
        type: "compaction",
        summary: row.summary ?? "",
        coveredEntryIds: parseJson<string[]>(row.coveredEntryIds) ?? [],
        tokenCountBefore: row.tokenCountBefore ?? 0,
        tokenCountAfter: row.tokenCountAfter ?? 0,
        fileContext: parseJson(row.fileContext),
        metadata: parseJson(row.metadata),
        createdAt: row.createdAt,
        queueItemId: row.queueItemId ?? undefined,
      };
      return e;
    }
    case "branch_summary": {
      const e: BranchSummaryEntry = {
        id: row.id,
        sessionId: row.sessionId,
        threadId: row.threadId,
        parentId: row.parentId,
        type: "branch_summary",
        branchRootId: row.branchRootId ?? "",
        branchLeafId: row.branchLeafId ?? "",
        summary: row.summary ?? "",
        metadata: parseJson(row.metadata),
        createdAt: row.createdAt,
        queueItemId: row.queueItemId ?? undefined,
      };
      return e;
    }
    case "decision_gate": {
      const meta = parseJson<{ gate: DecisionGate } & Record<string, unknown>>(row.metadata);
      const gate = meta?.gate;
      if (!gate) throw new Error(`decision_gate entry ${row.id} missing gate snapshot`);
      const { gate: _gate, ...userMeta } = meta;
      void _gate;
      const e: DecisionGateEntry = {
        id: row.id,
        sessionId: row.sessionId,
        threadId: row.threadId,
        parentId: row.parentId,
        type: "decision_gate",
        gate,
        resolvedAt: row.resolvedAt ?? undefined,
        resolution: parseJson(row.resolution),
        withdrawnReason: (row.withdrawnReason as DecisionGateEntry["withdrawnReason"]) ?? undefined,
        metadata: Object.keys(userMeta).length > 0 ? (userMeta as Record<string, unknown>) : undefined,
        createdAt: row.createdAt,
        queueItemId: row.queueItemId ?? undefined,
      };
      return e;
    }
    case "command_result": {
      const meta = parseJson<{ command: string; source: string; ok: boolean } & Record<string, unknown>>(row.metadata);
      const { command, source, ok, ...userMeta } = meta ?? {};
      const e: CommandResultEntry = {
        id: row.id,
        sessionId: row.sessionId,
        threadId: row.threadId,
        parentId: row.parentId,
        type: "command_result",
        command: command ?? "",
        source: asCommandSource(source),
        ok: ok ?? false,
        output: row.content ?? "",
        metadata: Object.keys(userMeta).length > 0 ? (userMeta as Record<string, unknown>) : undefined,
        createdAt: row.createdAt,
        queueItemId: row.queueItemId ?? undefined,
      };
      return e;
    }
    default:
      throw new Error(`unknown entry type: ${row.entryType}`);
  }
}

/** Raw column shape of a `SELECT * FROM engine_queue_items` row. */
export interface QueueItemRow {
  id: string;
  sessionId: string;
  threadId: string;
  dispatchId: string | null;
  status: string;
  outcome: string | null;
  error: string | null;
  supersededByItemId: string | null;
  mergedIntoItemId: string | null;
  content: string;
  author: string | null;
  channel: string | null;
  replyTarget: string | null;
  model: string | null;
  role: string | null;
  metadata: string | null;
  attemptId: string | null;
  attemptCount: number;
  maxAttempts: number;
  credentialAttempts: number;
  lastCredentialReleaseAt: number | null;
  timeoutAt: number;
  abortRequestedAt: number | null;
  ownerId: string | null;
  leaseExpiresAt: number | null;
  settlePatch: SettlePatchRef | null;
  createdAt: number;
  updatedAt: number;
}

export function rawToQueueItemRow(raw: Record<string, unknown>): QueueItemRow {
  return {
    id: asString(raw.id, "id"),
    sessionId: asString(raw.session_id, "session_id"),
    threadId: asString(raw.thread_id, "thread_id"),
    dispatchId: asStringOrNull(raw.dispatch_id, "dispatch_id"),
    status: asString(raw.status, "status"),
    outcome: asStringOrNull(raw.outcome, "outcome"),
    error: asStringOrNull(raw.error, "error"),
    supersededByItemId: asStringOrNull(raw.superseded_by_item_id, "superseded_by_item_id"),
    mergedIntoItemId: asStringOrNull(raw.merged_into_item_id, "merged_into_item_id"),
    content: asString(raw.content, "content"),
    author: asStringOrNull(raw.author, "author"),
    channel: asStringOrNull(raw.channel, "channel"),
    replyTarget: asStringOrNull(raw.reply_target, "reply_target"),
    model: asStringOrNull(raw.model, "model"),
    role: asStringOrNull(raw.role, "role"),
    metadata: asStringOrNull(raw.metadata, "metadata"),
    attemptId: asStringOrNull(raw.attempt_id, "attempt_id"),
    attemptCount: toNum(raw.attempt_count, "attempt_count"),
    maxAttempts: toNum(raw.max_attempts, "max_attempts"),
    credentialAttempts: toNum(raw.credential_attempts, "credential_attempts"),
    lastCredentialReleaseAt: toNumOrNull(raw.last_credential_release_at, "last_credential_release_at"),
    timeoutAt: toNum(raw.timeout_at, "timeout_at"),
    abortRequestedAt: toNumOrNull(raw.abort_requested_at, "abort_requested_at"),
    ownerId: asStringOrNull(raw.owner_id, "owner_id"),
    leaseExpiresAt: toNumOrNull(raw.lease_expires_at, "lease_expires_at"),
    settlePatch: settlePatchFromRaw(raw),
    createdAt: toNum(raw.created_at, "created_at"),
    updatedAt: toNum(raw.updated_at, "updated_at"),
  };
}

/** Reassemble a `SettlePatchRef` from the five settle_patch_* columns; null
 * when no record was ever written (status column NULL). */
function settlePatchFromRaw(raw: Record<string, unknown>): SettlePatchRef | null {
  const status = asStringOrNull(raw.settle_patch_status, "settle_patch_status");
  if (!status) return null;
  const reason = asStringOrNull(raw.settle_patch_reason, "settle_patch_reason");
  const blobKey = asStringOrNull(raw.settle_patch_blob_key, "settle_patch_blob_key");
  const bytes = toNumOrNull(raw.settle_patch_bytes, "settle_patch_bytes");
  const truncated = toNumOrNull(raw.settle_patch_truncated, "settle_patch_truncated");
  return {
    status: status as SettlePatchRef["status"],
    ...(reason !== null ? { reason } : {}),
    ...(blobKey !== null ? { blobKey } : {}),
    ...(bytes !== null ? { bytes } : {}),
    ...(truncated !== null ? { truncated: truncated === 1 } : {}),
  };
}

/** Raw column shape of a `SELECT * FROM engine_sessions` row. */
export interface SessionRow {
  id: string;
  ownerType: string;
  ownerId: string;
  userId: string;
  orgId: string;
  workspace: string;
  purpose: string;
  status: string;
  sandboxId: string | null;
  snapshotId: string | null;
  parentSessionId: string | null;
  parentThreadId: string | null;
  model: string | null;
  metadata: string | null;
  startRef: string | null;
  createdAt: number;
  updatedAt: number;
}

export function rawToSessionRow(raw: Record<string, unknown>): SessionRow {
  return {
    id: asString(raw.id, "id"),
    ownerType: asString(raw.owner_type, "owner_type"),
    ownerId: asString(raw.owner_id, "owner_id"),
    userId: asString(raw.user_id, "user_id"),
    orgId: asString(raw.org_id, "org_id"),
    workspace: asString(raw.workspace, "workspace"),
    purpose: asString(raw.purpose, "purpose"),
    status: asString(raw.status, "status"),
    sandboxId: asStringOrNull(raw.sandbox_id, "sandbox_id"),
    snapshotId: asStringOrNull(raw.snapshot_id, "snapshot_id"),
    parentSessionId: asStringOrNull(raw.parent_session_id, "parent_session_id"),
    parentThreadId: asStringOrNull(raw.parent_thread_id, "parent_thread_id"),
    model: asStringOrNull(raw.model, "model"),
    metadata: asStringOrNull(raw.metadata, "metadata"),
    startRef: asStringOrNull(raw.start_ref, "start_ref"),
    createdAt: toNum(raw.created_at, "created_at"),
    updatedAt: toNum(raw.updated_at, "updated_at"),
  };
}

/** Raw column shape of a `SELECT * FROM engine_threads` row. */
export interface ThreadRow {
  id: string;
  sessionId: string;
  key: string;
  status: string;
  activeLeafEntryId: string | null;
  queueMode: string;
  paused: number | null;
  model: string | null;
  summary: string | null;
  metadata: string | null;
  createdAt: number;
  updatedAt: number;
}

export function rawToThreadRow(raw: Record<string, unknown>): ThreadRow {
  return {
    id: asString(raw.id, "id"),
    sessionId: asString(raw.session_id, "session_id"),
    key: asString(raw.key, "key"),
    status: asString(raw.status, "status"),
    activeLeafEntryId: asStringOrNull(raw.active_leaf_entry_id, "active_leaf_entry_id"),
    queueMode: asString(raw.queue_mode, "queue_mode"),
    // engine_threads.paused is `integer` (0/1), NOT boolean — a deliberate
    // Task 2 deferral (see docs/specs/2026-07-15-postgres-backend-design.md
    // task 3 brief). Do not change the DDL here; read/write 0/1 exactly like
    // store-sqlite did.
    paused: toNumOrNull(raw.paused, "paused"),
    model: asStringOrNull(raw.model, "model"),
    summary: asStringOrNull(raw.summary, "summary"),
    metadata: asStringOrNull(raw.metadata, "metadata"),
    createdAt: toNum(raw.created_at, "created_at"),
    updatedAt: toNum(raw.updated_at, "updated_at"),
  };
}

/** Raw column shape of a `SELECT * FROM engine_decision_gates` row. */
export interface GateRow {
  id: string;
  sessionId: string;
  threadId: string;
  queueItemId: string;
  resumeKey: string;
  ordinal: number;
  type: string;
  status: string;
  title: string;
  body: string | null;
  actions: string;
  origin: string | null;
  context: string | null;
  resolution: string | null;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export function rawToGateRow(raw: Record<string, unknown>): GateRow {
  return {
    id: asString(raw.id, "id"),
    sessionId: asString(raw.session_id, "session_id"),
    threadId: asString(raw.thread_id, "thread_id"),
    queueItemId: asString(raw.queue_item_id, "queue_item_id"),
    resumeKey: asString(raw.resume_key, "resume_key"),
    ordinal: toNum(raw.ordinal, "ordinal"),
    type: asString(raw.type, "type"),
    status: asString(raw.status, "status"),
    title: asString(raw.title, "title"),
    body: asStringOrNull(raw.body, "body"),
    actions: asString(raw.actions, "actions"),
    origin: asStringOrNull(raw.origin, "origin"),
    context: asStringOrNull(raw.context, "context"),
    resolution: asStringOrNull(raw.resolution, "resolution"),
    expiresAt: toNumOrNull(raw.expires_at, "expires_at"),
    createdAt: toNum(raw.created_at, "created_at"),
    updatedAt: toNum(raw.updated_at, "updated_at"),
  };
}

export function rowToGate(row: GateRow): DecisionGate {
  return {
    id: row.id,
    sessionId: row.sessionId,
    threadId: row.threadId,
    queueItemId: row.queueItemId,
    resumeKey: row.resumeKey,
    ordinal: row.ordinal,
    type: row.type as DecisionGate["type"],
    status: row.status as DecisionGate["status"],
    title: row.title,
    body: row.body ?? undefined,
    actions: parseJson(row.actions) ?? [],
    origin: parseJson(row.origin),
    context: parseJson(row.context),
    expiresAt: row.expiresAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Raw column shape of a `SELECT * FROM engine_suspended_turns` row. */
export interface SuspendedTurnRow {
  sessionId: string;
  threadId: string;
  queueItemId: string;
  gateId: string;
  model: string;
  leafEntryId: string | null;
  toolCallId: string;
  toolName: string;
  toolArgs: string;
  resumeKey: string;
  ordinal: number;
  attempt: number;
  createdAt: number;
}

export function rawToSuspendedTurnRow(raw: Record<string, unknown>): SuspendedTurnRow {
  return {
    sessionId: asString(raw.session_id, "session_id"),
    threadId: asString(raw.thread_id, "thread_id"),
    queueItemId: asString(raw.queue_item_id, "queue_item_id"),
    gateId: asString(raw.gate_id, "gate_id"),
    model: asString(raw.model, "model"),
    leafEntryId: asStringOrNull(raw.leaf_entry_id, "leaf_entry_id"),
    toolCallId: asString(raw.tool_call_id, "tool_call_id"),
    toolName: asString(raw.tool_name, "tool_name"),
    toolArgs: asString(raw.tool_args, "tool_args"),
    resumeKey: asString(raw.resume_key, "resume_key"),
    ordinal: toNum(raw.ordinal, "ordinal"),
    attempt: toNum(raw.attempt, "attempt"),
    createdAt: toNum(raw.created_at, "created_at"),
  };
}
