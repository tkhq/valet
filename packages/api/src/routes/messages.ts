import { HOME_THREAD_KEY, HOME_THREAD_TITLE } from "../home/context.js";
import { readAppPageHint, type AppPageHint } from "@valet/shared";
/**
 * Messages + threads routes — the agent loop entry points.
 *
 * Each session has a default engine thread (`web:default`); the user can
 * create additional threads via POST /threads. Subsequent calls to
 * /messages can target any thread by id (defaults to the default thread
 * when omitted, so single-thread clients keep working).
 *
 *   GET  /api/sessions/:id/threads   → all threads for the session
 *   POST /api/sessions/:id/threads   → create a new engine thread
 *   GET  /api/sessions/:id/messages  → list messages (?threadId=…)
 *   POST /api/sessions/:id/messages  → send prompt (body.threadId optional)
 */
import { SLACK_CHANNELS_METADATA_KEY, threadAudience, threadRef, visibleThreadIds } from "../services/thread-access.js";
import { threadPage } from "../services/thread-page.js";
import { ensureDefaultThreadWhereOwned } from "../services/default-thread.js";
import { isLegacyAssistantRuntime } from "../services/legacy-runtime.js";
import { isWorkflowRunConversation } from "../workflows/run-conversations.js";
import { ensureAssistantExecution, findDefaultAssistant, loadAssistantBySessionId } from "../assistants/service.js";
import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { INHERIT_TOOL_SCOPE_KEY, TOOL_SCOPE_KEY, type ToolScope } from "@valet/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  ConflictError,
  dispatchCommand,
  MESSAGE_TURN_ERROR_KEY,
  NotFoundError,
  parseReasoningLevel,
  ValidationError,
} from "@valet/engine";
import { exportSeedBundle, planForkSeed, readBranchNote, readThreadEdit, walkTranscriptDag, WORKSPACE_FILES, type ForkSeedRecord, type PromptAuthor, type SessionEntry, type Session as EngineSession, type Thread } from "@valet/engine";
import { isAgentCaller, type AuthVia, type RequestPrincipal } from "../lib/request-principal.js";
import type { AppEnv } from "../env.js";
import { ensureWorkflowSession, parseWorkflowSessionId } from "../workflows/engine-deps.js";
import { agentSessions, assistants, assistantExecutions, legacyAssistantRuntimes, sessionThreads, users, workflowDefinitions } from "../schema/index.js";
import { makeCommandContext } from "../engine/command-providers.js";
import type {
  CreateThreadRequest,
  CreateThreadResponse,
  EditPreviewResponse,
  ForkThreadResponse,
  ListCommandsResponse,
  WireCommandInfo,
  ListDecisionsResponse,
  ListMessagesResponse,
  ListThreadsResponse,
  ThreadChannelActivity,
  ThreadContextResponse,
  ThreadRecapResponse,
  MarkThreadsReadRequest,
  Message,
  MessagePart,
  MessageAuthor,
  MessageRole,
  MessageReplyReference,
  MessageSkillInvocation,
  PatchThreadRequest,
  PatchThreadResponse,
  PromptFileAttachment,
  PromptImageAttachment,
  ResolveDecisionRequest,
  ReturnToBranchResponse,
  AbortThreadRequest,
  SendPromptRequest,
  SendPromptResponse,
  ThreadShareMode,
  ThreadSummary,
  WithdrawDecisionRequest,
} from "../wire/types.js";
import { commandResultEntryToMessage, engineGateToWire, engineSignalToWire, engineToWireParts } from "../engine/bridge.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import { workflowRequestContext } from "../workflows/request-context.js";
import { canReadWorkflowRun } from "../workflows/service.js";
import { cancelAllWorkAsHuman, endChildSubscriptions } from "../engine/wakeups-admin.js";
import { gateBackgroundWork } from "./wakeups.js";
import { canApplyAlwaysAllow, GATE_ACTION_ALWAYS_ALLOW, GATE_ACTION_ALWAYS_ALLOW_OWNER, gatePolicyFacts, ownerAlwaysAllowRefusal } from "../policies/service.js";
import type { Providers } from "../providers/types.js";
import { answersGate, isSharedAccountGate, canResolveSessionGate, canViewSession, gateApprover, type SessionOwnerLike } from "../services/session-access.js";
import { publicUrlFromEnv } from "../channels/host.js";
import { runVisible, spawnedFromVisibleThread, threadEntry, threadsVisibleTo, viewerOf } from "./_thread-access.js";
import {
  getAttachmentRefStore,
  UnknownAttachmentError,
  type AttachmentInfo,
} from "../services/attachment-refs.js";
import { isOrgAdminUser } from "./_org-admin.js";
import { assertModelSelectable } from "../services/approved-models.js";
import { assertReasoningSelectable } from "../services/reasoning.js";
import { recordSessionActivity, recordThreadActivityBestEffort, recordThreadUserActivity } from "../services/thread-activity.js";
import { readOptionalJsonObject } from "../lib/optional-json-body.js";
import { trimToolResults } from "../services/transcript-trim.js";
import { isThreadShareMode, setThreadShare } from "../services/thread-share.js";
import { setThreadApprovalBypass } from "../services/thread-approval-bypass.js";
import { canAdministerTeam } from "../services/teams.js";
import { isAssistantConversationOf } from "../services/thread-access.js";
import { listThreadActivity, markThreadsRead } from "../services/thread-read-state.js";
import { threadRecap } from "../services/thread-recap.js";
import { threadChannel } from "../services/channels.js";
import { threadChannelActivity } from "../services/channel-messages.js";

export const messagesRouter = new Hono<AppEnv>();

/**
 * Every route in this file (threads, messages, decisions) shares this one
 * check — view access, not just direct ownership, so a team's orchestrator
 * session works the same way here as `GET /api/sessions/:id` does (see
 * `services/session-access.ts`). Session lifecycle routes (delete, pause,
 * model change — in `routes/sessions.ts`) are NOT widened by this; talking
 * to a team's orchestrator is not the same decision as reconfiguring it.
 */
export async function loadOwnedSession(
  c: Context<AppEnv>, id = c.req.param("id"), decisionAccess?: { threadId?: string },
) {
  const { db, engineStore } = c.var.providers;
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, id)).limit(1);
  const row = rows[0];
  if (!row || row.orgId !== c.var.user.orgId) return null;
  if (!(await canViewSession(db, row, c.var.principal))) {
    // A shared thread's guest, admitted by `routes/threads.ts` for this one
    // session and thread. Every operation it reaches is bound to that thread.
    const guest = c.var.threadShareGuest;
    const sameThread = !decisionAccess?.threadId || decisionAccess.threadId === guest?.threadId;
    return guest?.sessionId === row.id && sameThread ? row : null;
  }
  const thread = decisionAccess?.threadId ? await engineStore.getThread(id, decisionAccess.threadId) : undefined;
  if (decisionAccess?.threadId && !thread) return null;
  if (await spawnedFromVisibleThread(c, row) && (!thread || await threadsVisibleTo(c, row)(thread))) return row;
  // Named approval grants decision access only, never private child content.
  if (decisionAccess && c.var.principal.type === "user") {
    const gates = await engineStore.listDecisionGates(id, decisionAccess.threadId, "pending");
    if (gates.some(gate => gateApprover(gate)?.userId === c.var.principal.id)) return row;
  }
  return null;
}

/**
 * Wire timestamp for an entry. Typed `number` on `BaseEntry`, but rows
 * persisted by older builds may hold an ISO string — coerce defensively.
 */
function wireCreatedAt(createdAt: number | string): number {
  const created = typeof createdAt === "number" ? createdAt : Date.parse(createdAt);
  return Number.isFinite(created) ? created : Date.now();
}

export function entryToMessage(e: SessionEntry, sessionId: string, threadId: string): Message | null {
  if (e.type === "command_result") {
    return commandResultEntryToMessage(e, sessionId, threadId);
  }
  if (e.type === "compaction") {
    // Project the compaction boundary so the UI can render a divider
    // (thread-model-pinning and compaction design, decision 7). `content`
    // carries the summary so clients without a divider renderer still
    // degrade to readable text.
    return {
      id: e.id,
      sessionId,
      threadId,
      role: "system",
      content: e.summary,
      parts: [],
      createdAt: wireCreatedAt(e.createdAt),
      sequence: e.sequence,
      compaction: {
        summary: e.summary,
        tokensBefore: e.tokenCountBefore,
        tokensAfter: e.tokenCountAfter,
        coveredEntryIds: e.coveredEntryIds,
      },
    };
  }
  if (e.type === "branch_summary") return branchNoteToMessage(e, sessionId, threadId);
  if (e.type !== "message") return null;
  // Engine has 4 roles: user/assistant/tool/system. We forward as-is.
  const role: MessageRole = e.role;
  const parts: MessagePart[] = engineToWireParts(e.parts);
  // Project engine image attachments into the wire shape. The engine holds
  // either a `data:` URL or raw bytes; the wire ships one canonical
  // `data:` URL string. Skip entries missing both (nothing to render).
  const wireAttachments = projectAttachments(e.attachments);
  const skill = skillInvocationFromMetadata(e.metadata, role);
  const author = authorFromEntry(e.author, role);
  const errorMessage = turnErrorFromMetadata(e.metadata, role);
  const editOf = role === "user" ? readThreadEdit(e.metadata)?.entryId : undefined;
  return {
    id: e.id,
    sessionId,
    threadId,
    role,
    content: e.content,
    parts,
    createdAt: wireCreatedAt(e.createdAt),
    sequence: e.sequence,
    queueItemId: e.queueItemId,
    ...(role === "assistant" ? { completed: e.stopReason === "end_turn", stopReason: e.stopReason } : {}),
    replyTo: replyReferenceFromMetadata(e.metadata, role),
    signal: engineSignalToWire(e.signal),
    model: e.model,
    ...(skill ? { skill } : {}),
    ...(author ? { author } : {}),
    ...(editOf ? { editOf } : {}),
    ...(role === "user" && e.channel ? { channelType: e.channel.channelType } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(wireAttachments.length > 0 ? { attachments: wireAttachments } : {}),
  };
}

/**
 * Wire projection of a branch note (docs/specs/2026-10-22-thread-edit-fork-design.md).
 * `content` carries the note text, so a client without a divider renderer
 * still shows readable text. A fork copies notes with an empty
 * `branchLeafId` when the version they left was not copied.
 */
function branchNoteToMessage(
  e: Extract<SessionEntry, { type: "branch_summary" }>,
  sessionId: string,
  threadId: string,
): Message {
  const note = readBranchNote(e.metadata);
  const kind = note?.kind ?? "edit";
  return {
    id: e.id,
    sessionId,
    threadId,
    role: "system",
    content: e.summary,
    parts: [],
    createdAt: wireCreatedAt(e.createdAt),
    sequence: e.sequence,
    branch: {
      kind,
      ...(note?.version ? { version: note.version } : {}),
      actions: (note?.actions ?? []).map(({ label, count, urls }) => ({ label, count, urls })),
      moreActions: note?.moreActions ?? 0,
      filesChanged: note?.filesChanged ?? false,
      canReturn: kind !== "fork" && e.branchLeafId !== "",
      grants: note?.grants ?? [],
      ...(note?.files ? {
        files: {
          changed: note.files.flatMap((repo) => [...repo.restored, ...repo.removed].map((path) => repoPath(repo.repo, path))),
          skipped: note.files.flatMap((repo) => repo.skipped.map((path) => repoPath(repo.repo, path))),
          failed: note.files.flatMap((repo) => (repo.failed ? [checkpointLabel(repo.repo)] : [])),
          canBringBack: note.files.some((repo) => repo.restorePoint !== undefined && Object.keys(repo.bases ?? {}).length > 0),
        },
      } : {}),
      ...(note?.source ? { source: { threadId: note.source.threadId, sameWorkingDirectory: note.source.sameWorkingDirectory } } : {}),
      ...(note?.seed || note?.seedSkipped ? {
        seed: {
          repos: (note.seedResult ?? note.seed ?? []).filter((repo) => !("failed" in repo) || !repo.failed).map((repo) => checkpointLabel(repo.repo)),
          pending: note.seedResult === undefined && (note.seed?.length ?? 0) > 0,
          failed: (note.seedResult ?? []).flatMap((repo) => (repo.failed ? [checkpointLabel(repo.repo)] : [])),
          ...(note.seedSkipped ? { skipped: note.seedSkipped } : {}),
        },
      } : {}),
    },
  };
}

/** A file path for people, relative to the working directory. */
function repoPath(repo: string, path: string): string {
  return repo === "." || repo === WORKSPACE_FILES ? path : `${repo.replace(/\/+$/, "")}/${path}`;
}

function checkpointLabel(repo: string): string {
  return repo === WORKSPACE_FILES ? "the working directory" : repo;
}

/**
 * Wire projection of the provider error that the engine keeps on the
 * assistant entry of a failed turn. Without it, a reload shows an empty
 * reply that does not say why the turn failed.
 */
function turnErrorFromMetadata(
  metadata: Record<string, unknown> | undefined,
  role: MessageRole,
): string | undefined {
  if (role !== "assistant") return undefined;
  const value = metadata?.[MESSAGE_TURN_ERROR_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The engine `PromptAuthor` for a prompt the authenticated user typed.
 * One projection for every human-submit route (POST /messages,
 * `initialPrompt` on create) so the stamp cannot drift between them.
 * `name` is optional on the auth user; an absent or empty name is dropped
 * so downstream label fallbacks (email) engage.
 */
export function promptAuthorFromUser(user: {
  id: string;
  email: string;
  name?: string;
}, principal?: RequestPrincipal, authVia?: AuthVia): PromptAuthor {
  if (principal?.type === "team") return { id: `team:${principal.id}`, name: "Team API key" };
  return { id: user.id, email: user.email, ...(user.name ? { name: user.name } : {}),
    ...(authVia === "session" || authVia === "stub" ? { interactive: true } : {}) };
}

/**
 * Wire projection of the engine's `PromptAuthor`. Only user entries carry a
 * human sender; `externalId` is a channel-plugin detail and stays off the
 * wire.
 */
function authorFromEntry(
  author: PromptAuthor | undefined,
  role: MessageRole,
): MessageAuthor | undefined {
  if (role !== "user" || !author) return undefined;
  return {
    id: author.id,
    ...(author.name ? { name: author.name } : {}),
    ...(author.email ? { email: author.email } : {}),
    ...(author.avatarUrl ? { avatarUrl: author.avatarUrl } : {}),
    ...(author.externalSender ? { externalSender: true } : {}),
    ...(author.interactive ? { interactive: true } : {}),
  };
}

/**
 * Wire projection of a skill-invocation stamp. Both producers write the
 * same keys: the command dispatcher stamps `{ skill, skillArgs }` on a
 * slash expansion, and `Thread.skill()` stamps `{ skill }` on a host
 * invocation. Only user entries qualify — the stamp rides the queue item
 * onto the user entry, never onto assistant output.
 */
const REPLY_METADATA_KEY = "replyTo";
const REPLY_EXCERPT_CHARS = 280;

function replyReferenceFromMetadata(
  metadata: Record<string, unknown> | undefined,
  role: MessageRole,
): MessageReplyReference | undefined {
  if (role !== "user") return undefined;
  const value = metadata?.[REPLY_METADATA_KEY];
  if (!value || typeof value !== "object") return undefined;
  const ref = value as Record<string, unknown>;
  if (typeof ref.messageId !== "string" || typeof ref.excerpt !== "string") return undefined;
  return { messageId: ref.messageId, excerpt: ref.excerpt };
}

function assistantReplyExcerpt(entry: Extract<SessionEntry, { type: "message" }>): string {
  const partText = (entry.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.type === "text" ? part.text.trim() : "")
    .filter(Boolean)
    .join(" ");
  const text = (partText || entry.content).replace(/\s+/g, " ").trim();
  const codepoints = Array.from(text);
  return codepoints.length <= REPLY_EXCERPT_CHARS
    ? text
    : codepoints.slice(0, REPLY_EXCERPT_CHARS - 1).join("").trimEnd() + "…";
}

function skillInvocationFromMetadata(
  metadata: Record<string, unknown> | undefined,
  role: MessageRole,
): MessageSkillInvocation | undefined {
  if (role !== "user" || !metadata) return undefined;
  const name = metadata.skill;
  if (typeof name !== "string" || name.length === 0) return undefined;
  const args = metadata.skillArgs;
  return { name, ...(typeof args === "string" && args ? { args } : {}) };
}

/**
 * Wire projection of `MessageEntry.attachments`. The engine keeps images as
 * either `{ url }` (already a `data:` URL — the shape the REST route
 * accepts today) or `{ data: Uint8Array }` (some day, when a plugin drops a
 * raw buffer in). The wire ships one canonical string per attachment; if
 * neither field is set, drop the entry rather than emit an empty img.
 *
 * File attachments (type: "file") are projected as `PromptFileAttachment`
 * carrying the absolute sandbox path, size, hash, and optional markdown sidecar.
 */
function projectAttachments(
  attachments: NonNullable<Extract<SessionEntry, { type: "message" }>["attachments"]> | undefined,
): Array<PromptImageAttachment | PromptFileAttachment> {
  if (!attachments || attachments.length === 0) return [];
  const out: Array<PromptImageAttachment | PromptFileAttachment> = [];
  for (const att of attachments) {
    if (att.type === "image") {
      let url: string | undefined;
      if (typeof att.url === "string" && att.url.startsWith("data:")) {
        url = att.url;
      } else if (att.data) {
        url = `data:${att.mimeType};base64,${Buffer.from(att.data).toString("base64")}`;
      } else if (typeof att.url === "string") {
        // Non-data URL (e.g. an http url) is passed through as-is; harmless
        // if the client happens to already resolve it.
        url = att.url;
      }
      if (!url) continue;
      out.push({
        kind: "image",
        url,
        mimeType: att.mimeType,
        name: att.name ?? "image",
      });
    } else if (att.type === "file") {
      out.push({
        kind: "file",
        path: att.path,
        bytes: att.bytes,
        sha256: att.sha256,
        mimeType: att.mimeType,
        markdownPath: att.markdownPath,
        extractedTo: att.extractedTo,
        extractedFiles: att.extractedFiles,
        name: att.name,
      });
    }
  }
  return out;
}

// ── Threads ───────────────────────────────────────────────────────────────

function threadToSummary(
  threadId: string,
  createdAt: number,
  sessionId: string,
  lastUserActivityAt: number,
  title?: string,
  model?: string,
  key?: string,
  archivedAt?: number,
  reasoning?: string | null,
): ThreadSummary {
  return { id: threadId, sessionId, title, createdAt, lastUserActivityAt, model, key, archivedAt, reasoning };
}

async function loadEngineSession(
  c: Context<AppEnv>,
  id = c.req.param("id"),
  decisionAccess?: { threadId?: string },
  /** The key of the thread the request targets. A startup warning of this build goes there (fix wave 2, M13). */
  warningThreadKey?: string,
): Promise<
  | {
      session: typeof agentSessions.$inferSelect;
      engineSession: EngineSession;
      meta: Awaited<ReturnType<typeof loadSessionMeta>>;
    }
  | { error: Response }
> {
  const session = await loadOwnedSession(c, id, decisionAccess);
  if (!session) return { error: c.json({ error: "session not found" }, 404) };
  const { engineHost, db } = c.var.providers;

  // Repo bindings + git identity (GitHub/repo integration plan, Task 9) —
  // assembled centrally via `loadSessionMeta` so EVERY `sessionFor` caller
  // carries them. The first call to actually build the session (create or
  // restore) wires `prepareSandbox`; later calls are no-op reads once cached
  // (`sessionFor` returns early without touching `meta`).
  const loaded = await loadSessionMeta(db, session);
  const meta = warningThreadKey !== undefined ? { ...loaded, warningThreadKey } : loaded;
  const engineSession = await engineHost.sessionFor(session.id, meta);
  return { session, engineSession, meta };
}

messagesRouter.get("/:id/threads", (c) => listThreads(c, c.req.param("id")));

/** Enumerate execution histories without waking their sandboxes. */
async function workspaceThreadGroups(c: Context<AppEnv>, session: typeof agentSessions.$inferSelect, archived?: boolean) {
  const { db, engineStore } = c.var.providers;
  const executions = session.ownerType === "team" || session.ownerType === "user"
    ? await db.select({ session: agentSessions, governingThreadId: assistantExecutions.governingThreadId, governingKey: assistantExecutions.conversationKey,
        matchesArchive: archived === undefined ? sql<boolean>`true` : sql<boolean>`EXISTS (
          SELECT 1 FROM engine_threads t LEFT JOIN session_threads m ON m.id = t.id AND m.session_id = t.session_id
          WHERE t.session_id = ${agentSessions.id} AND (m.archived_at IS NOT NULL) = ${archived}
        )` }).from(assistantExecutions)
      .innerJoin(assistants, eq(assistants.id, assistantExecutions.assistantId))
      .innerJoin(agentSessions, eq(agentSessions.id, assistantExecutions.sessionId))
      .where(and(eq(assistants.sessionId, session.id), eq(agentSessions.orgId, session.orgId),
        eq(agentSessions.ownerType, session.ownerType), eq(agentSessions.ownerId, session.ownerId),
        sql`${agentSessions.status} <> 'deleted'`))
    : [];
  // The singleton cutover retained older assistant runtimes under their original
  // workspace ownership. Include their history without moving threads or files.
  const legacy = (session.ownerType === "user" || session.ownerType === "team" || session.ownerType === "org") && session.ownerId
    ? await db.select({ session: agentSessions }).from(legacyAssistantRuntimes)
      .innerJoin(agentSessions, eq(agentSessions.id, legacyAssistantRuntimes.sessionId))
      .where(and(eq(legacyAssistantRuntimes.orgId, session.orgId),
        eq(legacyAssistantRuntimes.ownerType, session.ownerType), eq(legacyAssistantRuntimes.ownerId, session.ownerId),
        eq(agentSessions.orgId, session.orgId), eq(agentSessions.ownerType, session.ownerType), eq(agentSessions.ownerId, session.ownerId),
        sql`${agentSessions.status} <> 'deleted'`,
        sql`EXISTS (SELECT 1 FROM assistants a WHERE a.session_id = ${session.id}
          AND a.org_id = ${session.orgId} AND a.owner_type = ${session.ownerType}
          AND a.owner_id = ${session.ownerId} AND a.archived_at IS NULL)`))
    : [];
  const retained = [];
  for (const row of legacy) {
    if (row.session.id !== session.id && await isLegacyAssistantRuntime(db, row.session.id, session.orgId)) retained.push(row.session);
  }
  const anchors = new Set(executions.map(e => e.governingThreadId));
  const keys = new Map(executions.map(e => [e.session.id, e.governingKey]));
  if (session.id.startsWith("execution:")) {
    const [self] = await db.select({ key: assistantExecutions.conversationKey }).from(assistantExecutions)
      .where(eq(assistantExecutions.sessionId, session.id)).limit(1);
    if (self) keys.set(session.id, self.key);
  }
  const rows = [session, ...retained, ...executions.filter(e => e.matchesArchive).map(e => e.session)];
  // Each team conversation is its own session, so a workspace's history is
  // one session per conversation. Read every thread, and decide who may see
  // each one, in a fixed number of queries rather than several per session.
  // `visibleThreadIds` gives each thread the answer `threadsVisibleTo` gives,
  // including the audience of the thread that started a child session.
  const stored = await engineStore.listThreadsForSessions(rows.map(row => row.id));
  const shown = await visibleThreadIds(c.var.providers, { ownerType: session.ownerType }, viewerOf(c),
    stored.map(thread => ({ sessionId: thread.sessionId, threadId: thread.id })));
  // Root anchors carry authorization; keep old history when an anchor already held entries.
  const rootAnchors = stored.filter(thread => thread.sessionId === session.id && anchors.has(thread.id)).map(thread => thread.id);
  const anchorsWithHistory = new Set(rootAnchors.length === 0 ? [] : (await db.execute(sql`SELECT a.id FROM unnest(ARRAY[${sql.join(rootAnchors.map(id => sql`${id}`), sql`, `)}]::text[]) AS a(id)
    WHERE EXISTS (SELECT 1 FROM engine_entries e WHERE e.session_id = ${session.id} AND e.thread_id = a.id)`) as { rows: Array<{ id: string }> }).rows.map(row => row.id));
  return rows.map(row => ({ session: row, threads: stored
    .filter(thread => thread.sessionId === row.id && shown.has(`${thread.sessionId}:${thread.id}`)
      && !(row.id === session.id && anchors.has(thread.id) && !anchorsWithHistory.has(thread.id)))
    .map(thread => ({ ...thread, key: keys.get(row.id) ?? thread.key })) }));
}

export async function listThreads(c: Context<AppEnv>, sessionId: string) {
  const result = await loadEngineSession(c, sessionId);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;
  const { db } = c.var.providers;

  await ensureDefaultThreadWhereOwned(session.id, engineSession);
  const wantArchived = c.req.query("archived") === "1";
  const selectedThreadId = c.req.query("threadId");
  const groups = await workspaceThreadGroups(c, session, selectedThreadId ? undefined : wantArchived);
  // Parse stored tokens: a legacy "off" row has no pin and shows the session
  // default, which is filled in for the returned page below.
  const threads = groups.flatMap(group => group.threads.filter(t => t.id === selectedThreadId || !isWorkflowRunConversation(group.session.id, t.key))
    .map(t => ({ ...t, reasoning: parseReasoningLevel(t.reasoning) })));

  // Titles + archive state live in the app-side `session_threads` mirror
  // (titles populated by auto-title). One lookup by id set — small, since a
  // session has O(few) threads. Missing rows → undefined title, not archived.
  const ids = threads.map((t) => t.id);
  const metaRows = ids.length
    ? await db
        .select({
          id: sessionThreads.id,
          title: sessionThreads.title,
          archivedAt: sessionThreads.archivedAt,
          lastUserActivityAt: sessionThreads.lastUserActivityAt,
          shareMode: sessionThreads.shareMode,
          approvalBypassBy: sessionThreads.approvalBypassBy,
        })
        .from(sessionThreads)
        .where(inArray(sessionThreads.id, ids))
    : [];
  const metaById = new Map(
    metaRows.map(
      (r) =>
        [
          r.id,
          {
            title: r.title ?? undefined,
            archivedAt: r.archivedAt ?? undefined,
            lastUserActivityAt: r.lastUserActivityAt ?? undefined,
            share: r.shareMode ?? undefined,
            approvalBypass: r.approvalBypassBy !== null,
          },
        ] as const,
    ),
  );

  // Default list excludes archived threads; `?archived=1` lists only them.
  // A team runtime's private threads show only to the people they belong to
  // (`services/thread-access.ts`).
  const query = c.req.query("q")?.trim().toLowerCase() ?? "";
  if (query.includes("\0")) return c.json({ error: "Search contains an unsupported NUL character. Remove it and try again." }, 400);
  if (query.length > 500) return c.json({ error: "Search is too long. Use at most 500 characters." }, 400);
  // Search persisted chat text without downloading histories. The session was
  // authorized above; the visibility filter below also excludes private threads.
  const contentMatches = query
    ? await db.selectDistinct({ threadId: sql<string>`thread_id` })
        .from(sql`engine_entries`)
        .where(sql`session_id in (${sql.join(groups.map(g => sql`${g.session.id}`), sql`, `)}) and entry_type = 'message'
          and role in ('user', 'assistant')
          and strpos(lower(content), ${query}) > 0`)
    : [];
  const matchingIds = new Set([...contentMatches.map((row) => row.threadId), ...(c.req.queries("fixedId") ?? [])]);
  const summaries = threads
    .filter(t => !query || matchingIds.has(t.id) || metaById.get(t.id)?.title?.toLowerCase().includes(query))
    .filter(t => t.id === selectedThreadId || (metaById.get(t.id)?.archivedAt !== undefined) === wantArchived)
    .map(t => {
      const meta = metaById.get(t.id);
      const summary = threadToSummary(t.id, t.createdAt, t.sessionId, meta?.lastUserActivityAt ?? t.createdAt, t.key === HOME_THREAD_KEY ? HOME_THREAD_TITLE : meta?.title,
        t.model, t.key, meta?.archivedAt, t.reasoning ?? null);
      return { ...summary, ...(meta?.share ? { share: meta.share } : {}), ...(meta?.approvalBypass ? { approvalBypass: true as const } : {}) };
    });
  let body: ListThreadsResponse;
  try { body = threadPage(summaries, new URL(c.req.url).searchParams); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : "Refresh the thread list." }, 400); }
  // A thread without its own model or reasoning shows its session's defaults.
  const unpinned = [...new Set(body.threads.filter(t => !t.model || !t.reasoning).map(t => t.sessionId))];
  const defaults = new Map(await Promise.all(unpinned.map(async id => [id, await c.var.providers.engineStore.getSession(id)] as const)));
  for (const summary of body.threads) {
    const session = defaults.get(summary.sessionId);
    summary.model ??= session?.model;
    summary.reasoning ??= parseReasoningLevel(session?.reasoning) ?? null;
  }
  for (const group of groups) {
    const groupSummaries = body.threads.filter(t => t.sessionId === group.session.id);
    if (!groupSummaries.length) continue;
    const activity = await listThreadActivity(db, c.var.user.id, group.session.id, groupSummaries.map(t => t.id), c.var.principal,
      group.session.ownerType === "team");
    for (const summary of groupSummaries) {
      Object.assign(summary, activity.get(summary.id));
      const channel = threadChannel(summary.key, summary.pullRequests);
      if (channel) summary.channel = channel;
    }
  }
  return c.json(body);
}

/** How much one thread has talked in its channel: a count and the newest message. */
messagesRouter.get("/:id/threads/:threadId/channel-activity", (c) => getThreadChannelActivity(c, c.req.param("id"), c.req.param("threadId")));

export async function getThreadChannelActivity(c: Context<AppEnv>, sessionId: string, threadId: string) {
  const result = await loadEngineSession(c, sessionId);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;
  if (!await visibleThread(c, session, engineSession, threadId)) {
    return c.json({ error: "Thread not found. Refresh the thread list." }, 404);
  }
  const body: ThreadChannelActivity = await threadChannelActivity(c.var.providers.db, session.id, threadId);
  return c.json(body);
}

/** How full one thread's model context is. Reading it never loads the transcript or wakes the sandbox. */
messagesRouter.get("/:id/threads/:threadId/context", (c) => getThreadContext(c, c.req.param("id"), c.req.param("threadId")));

export async function getThreadContext(c: Context<AppEnv>, sessionId: string, threadId: string) {
  const result = await loadEngineSession(c, sessionId);
  if ("error" in result) return result.error;
  const thread = await visibleThread(c, result.session, result.engineSession, threadId);
  if (!thread) return c.json({ error: "Thread not found. Refresh the thread list." }, 404);
  const body: ThreadContextResponse = { context: (await thread.contextUsage()) ?? null };
  return c.json(body);
}

/** Entries read for a recap. Tool entries count too, so this covers a few dozen messages. */
const RECAP_ENTRY_LIMIT = 600;

/** What other people did in a thread since the reader last saw it. `since` is the reader's last read time. */
export async function getThreadRecap(c: Context<AppEnv>, sessionId: string, threadId: string) {
  const result = await loadEngineSession(c, sessionId);
  if ("error" in result) return result.error;
  const thread = await visibleThread(c, result.session, result.engineSession, threadId);
  if (!thread) return c.json({ error: "Thread not found. Refresh the thread list." }, 404);
  const since = c.req.query("since");
  const readAt = since === undefined ? undefined : Number(since);
  if (readAt !== undefined && (!Number.isFinite(readAt) || readAt < 0)) {
    return c.json({ error: "since must be a time in milliseconds. Omit it for a thread the reader never opened." }, 400);
  }
  const messages = (await thread.readEntries({ limit: RECAP_ENTRY_LIMIT }))
    .map((entry) => entryToMessage(entry, sessionId, thread.id))
    .filter((message): message is Message => message !== null);
  const user = c.var.user;
  try {
    const body: ThreadRecapResponse = await threadRecap({
      threadId: thread.id, messages, readerId: user.id, readerName: user.name || user.email, readAt,
    });
    return c.json(body);
  } catch (err) {
    console.error(`GET /threads/${thread.id}/recap: the recap failed:`, err);
    return c.json({ error: "Valet could not write the recap. Open the thread again to retry." }, 502);
  }
}

/** Marks threads read for the caller. With no ids, marks every thread in the session. */
messagesRouter.post("/:id/threads/read", (c) => readThreads(c, c.req.param("id")));

export async function readThreads(c: Context<AppEnv>, sessionId: string) {
  const result = await loadEngineSession(c, sessionId);
  if ("error" in result) return result.error;
  const { session } = result;
  // An empty body marks every thread. A malformed one is refused rather than
  // read as that default.
  const body: MarkThreadsReadRequest | null = await readOptionalJsonObject(c);
  if (!body) {
    return c.json({ error: "Send a JSON object, such as {\"threadIds\": [\"<thread id>\"]}, or an empty body to mark every thread read." }, 400);
  }
  // Another pod may have made a thread this one has not loaded, so the
  // stored threads decide which ids exist.
  const groups = await workspaceThreadGroups(c, session);
  const known = new Set(groups.flatMap(g => g.threads.map(t => t.id)));
  if (body.threadIds !== undefined && !Array.isArray(body.threadIds)) {
    return c.json({ error: "threadIds must be an array of thread ids." }, 400);
  }
  const ids = body.threadIds === undefined ? [...known]
    : body.threadIds.filter((id): id is string => typeof id === "string" && known.has(id));
  const selected = new Set(ids);
  for (const group of groups) {
    await markThreadsRead(c.var.providers.db, c.var.user.id, group.session.id, group.threads.filter(t => selected.has(t.id)).map(t => t.id));
  }
  return c.body(null, 204);
}

// ── Commands ────────────────────────────────────────────────────────────────
//
// GET /:id/commands — the merged slash-command registry for the session
// (built-ins + skills + user/repo templates + plugin commands) plus registry
// diagnostics. Building the session (via `loadEngineSession`) is what wires the
// host `workspaceSkillsProvider`/`commandContext`; the registry is built lazily and
// cached on the Session, refreshed after workspace prep.
messagesRouter.get("/:id/commands", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { engineSession } = result;

  // Refresh before reading so user templates (DB-backed, always available) and
  // repo templates (readable once the sandbox is ready) land in the registry.
  // Cheap when nothing changed: one DB read plus, only when the sandbox is
  // ready, one exec.
  await engineSession.refreshCommandRegistry();
  const registry = engineSession.commandRegistry();

  // Attach argument completions for commands whose first argument is
  // enumerable. Today that is `/model` (the org's active model catalog).
  // Failure to enumerate degrades to no completions, never a route error.
  const { db, engineCredentials } = c.var.providers;
  const commands: WireCommandInfo[] = registry.list();
  const model = commands.find((cmd) => cmd.source === "builtin" && cmd.name === "model");
  if (model) {
    try {
      const ctx = makeCommandContext(db, engineCredentials, result.session.orgId, result.session.id);
      const models = await ctx.listModels();
      model.argOptions = models.map((m) => ({ value: m.id, label: m.name }));
    } catch (err) {
      console.error(`GET /commands: model enumeration failed for ${result.session.id}:`, err);
    }
  }

  const body: ListCommandsResponse = {
    commands,
    diagnostics: registry.diagnostics(),
  };
  return c.json(body);
});

/** Maximum length for a thread title. This matches the session title limit. */
const MAX_THREAD_TITLE_CHARS = 200;

messagesRouter.patch("/:id/threads/:threadId", (c) => patchThread(c, c.req.param("id"), c.req.param("threadId")));

export async function patchThread(c: Context<AppEnv>, sessionId: string, threadId: string) {
  const result = await loadEngineSession(c, sessionId);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;
  const { db } = c.var.providers;

  const thread = await visibleThread(c, session, engineSession, threadId);
  if (!thread) return c.json({ error: "thread not found" }, 404);

  let body: PatchThreadRequest;
  try {
    body = (await c.req.json()) as PatchThreadRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (
    body.model === undefined &&
    body.archived === undefined &&
    body.title === undefined &&
    body.reasoning === undefined &&
    body.share === undefined &&
    body.approvalBypass === undefined
  ) {
    return c.json(
      { error: "nothing to patch: send model (null to clear), archived, title, reasoning, share, and/or approvalBypass" },
      400,
    );
  }

  // Only the owner shares a personal thread. A team thread is already open to
  // its team, so it has no share (`services/thread-share.ts`).
  let nextShare: ThreadShareMode | null | undefined;
  if (body.share !== undefined) {
    if (body.share !== "off" && !isThreadShareMode(body.share)) {
      return c.json({ error: "Set share to \"off\", \"view\", or \"reply\"." }, 400);
    }
    if (session.ownerType !== "user") {
      return c.json({ error: "Only a personal thread can be shared. Everyone on the team can already open team threads." }, 400);
    }
    nextShare = body.share === "off" ? null : body.share;
  }

  // "Run without asking" (`services/thread-approval-bypass.ts`). Anyone who
  // may open the thread may turn it off. Only a person who could stop each
  // approval for good may turn it on, and only from a signed-in browser, so
  // an agent that holds the person's API key cannot turn it on for itself.
  if (body.approvalBypass !== undefined) {
    if (typeof body.approvalBypass !== "boolean") {
      return c.json({ error: "Set approvalBypass to true or false." }, 400);
    }
    if (body.approvalBypass) {
      if (c.var.authVia !== "session" && c.var.authVia !== "stub") {
        return c.json({ error: "Turn on Run without asking in Valet, signed in to your browser." }, 403);
      }
      if (session.ownerType === "team") {
        if (!session.ownerId || !(await canAdministerTeam(db, session.ownerId, c.var.user.id))) {
          return c.json({ error: "Only a team admin can turn on Run without asking for a team thread. Ask a team admin." }, 403);
        }
      } else if (session.ownerType !== "user" || (session.ownerId || session.userId) !== c.var.user.id) {
        return c.json({ error: "Only the thread's owner can turn on Run without asking." }, 403);
      }
    }
  }

  // Validate the title before changing any thread settings.
  let nextTitle: string | null | undefined;
  if (body.title !== undefined) {
    if (body.title === null) {
      nextTitle = null;
    } else if (typeof body.title !== "string") {
      return c.json(
        { error: "Set title to a string, or use null to clear it." },
        400,
      );
    } else {
      const trimmed = body.title.trim();
      if (trimmed.length === 0) {
        nextTitle = null;
      } else if (trimmed.length > MAX_THREAD_TITLE_CHARS) {
        return c.json(
          { error: `title is too long. Use ${MAX_THREAD_TITLE_CHARS} characters or fewer.` },
          400,
        );
      } else {
        nextTitle = trimmed;
      }
    }
  }

  if (body.model !== undefined && typeof body.model === "string") {
    const isAdmin = await isOrgAdminUser(c);
    const err = await assertModelSelectable(db, session.orgId, isAdmin, body.model);
    if (err) return c.json({ error: err }, 400);
  }

  // `reasoning: null` clears the override and always passes. Storage/
  // application of a thread-level override is Task 11 — this only
  // validates so a bad value 400s instead of being silently accepted.
  if (body.reasoning !== undefined && body.reasoning !== null) {
    if (typeof body.reasoning !== "string") {
      return c.json(
        { error: "reasoning must be a reasoning level string, or null to clear the override." },
        400,
      );
    }
    const normalizedReasoning = body.reasoning.trim().toLowerCase();
    const reasoningErr = await assertReasoningSelectable(db, session.orgId, normalizedReasoning);
    if (reasoningErr) return c.json({ error: reasoningErr }, 400);
  }

  // An archive waits for the thread's turn, forced or not (fix wave 4, P4).
  // A turn that starts background work after the gate below would leave
  // work running on a hidden thread, and nobody would see the 409 for it.
  // A turn blocked on an approval does not count: the archive withdraws
  // its gate below (TKAI-260), and the turn then settles.
  const threadBusy = async (): Promise<boolean> =>
    (await c.var.providers.engineStore.listUnsettledSubmissions(sessionId))
      .some((item) => item.threadId === thread.id && item.status !== "blocked_on_decision_gate");
  if (body.archived === true && (await threadBusy())) {
    return c.json({ error: "A turn is running in this thread. Wait for it to finish, then archive." }, 409);
  }

  // Archiving a thread with background work stops that work, so it needs
  // `force: true` (fix wave 3, H1). The check runs before any write; the
  // forced stop runs below, next to the approval withdrawal.
  const archiveGate = body.archived === true
    ? await gateBackgroundWork(c, session, "archive", { threadId: thread.id }, body.force === true)
    : undefined;
  if (archiveGate?.kind === "refused") return archiveGate.response;

  if (body.model !== undefined) {
    try {
      await thread.setModel(
        typeof body.model === "string" ? body.model : null,
      );
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  }

  if (body.reasoning !== undefined) {
    try {
      await thread.setReasoning(
        typeof body.reasoning === "string" ? body.reasoning.trim().toLowerCase() : null,
      );
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  }

  // Archiving hides the thread, so an approval pending on it would suspend
  // the agent with nobody left to answer (TKAI-260). Archive withdraws those
  // approvals as cancelled, which only someone who may answer them can do.
  if (body.archived === true) {
    const pending = (await engineSession.pendingDecisionGates())
      .filter((gate) => gate.threadId === thread.id && gate.status === "pending");
    if (pending.length > 0) {
      if (!(await canAnswerDecision(c, session, sessionId))) {
        return c.json(
          { error: "This thread is waiting on an approval. Ask someone who can answer it to approve or deny it, then archive the thread." },
          409,
        );
      }
      for (const gate of pending) await engineSession.withdrawDecision(gate.id, "cancel");
    }
  }

  // A forced archive stops the thread's wakeups and holds as a human cancel
  // (fix wave 3, H1). The signal goes to the session's main thread, because
  // the work's own thread is about to be hidden. It tells the agent that a
  // person stopped the work, so it does not wait for a signal that never
  // comes after an unarchive. The main thread can have a wider audience,
  // so the signal carries the reason but no log tail and no channel origin
  // (fix wave 4, N3). The archived thread keeps a note of the stop.
  let cancelledWork: string[] | undefined;
  if (archiveGate?.kind === "force") {
    const stopped = await cancelAllWorkAsHuman(
      c.var.providers.engineStore,
      engineSession,
      sessionId,
      { threadId: thread.id, ids: archiveGate.ids },
      {
        actorUserId: c.var.user.id,
        signal: "deliver",
        deliverTo: "main",
        note: "They archived the thread it ran in. Do not start it again unless someone asks.",
      },
    );
    if (stopped.cancelled.length > 0) {
      cancelledWork = stopped.cancelled.map((w) => w.id);
      const items = stopped.cancelled.map((w) => `"${w.reason}" (${w.kind})`).join(", ");
      await thread.appendEntry({
        id: `e-${randomUUID()}`,
        sessionId,
        threadId: thread.id,
        parentId: null,
        type: "message",
        role: "system",
        content: `A person archived this thread, which stopped its background work: ${items}. The agent got a message about it on the main thread.`,
        createdAt: Date.now(),
      });
    }
  }

  if (body.archived === true) await endChildSubscriptions(c.var.providers.engineStore, sessionId, thread.id, db);

  // The mirror row can be missing before auto-title runs.
  const wantsArchived = body.archived !== undefined;
  const wantsTitle = nextTitle !== undefined;
  if (wantsArchived || wantsTitle) {
    const nextArchivedAt = wantsArchived
      ? (body.archived ? Date.now() : null)
      : undefined;
    await db
      .insert(sessionThreads)
      .values({
        id: thread.id,
        sessionId: session.id,
        createdAt: thread.toThreadData().createdAt,
        archivedAt: nextArchivedAt ?? null,
        title: nextTitle ?? null,
      })
      .onConflictDoUpdate({
        target: sessionThreads.id,
        set: {
          ...(wantsArchived ? { archivedAt: nextArchivedAt } : {}),
          ...(wantsTitle ? { title: nextTitle } : {}),
        },
      });
  }

  if (nextShare !== undefined) {
    await setThreadShare(db, { id: thread.id, sessionId: session.id, createdAt: thread.toThreadData().createdAt }, nextShare);
  }

  if (body.approvalBypass !== undefined) {
    await setThreadApprovalBypass(db, { id: thread.id, sessionId: session.id, createdAt: thread.toThreadData().createdAt },
      body.approvalBypass ? c.var.user.id : null);
  }

  // Return the same title and archive state as a subsequent GET.
  const rows = await db
    .select({
      archivedAt: sessionThreads.archivedAt,
      title: sessionThreads.title,
      lastUserActivityAt: sessionThreads.lastUserActivityAt,
      shareMode: sessionThreads.shareMode,
      approvalBypassBy: sessionThreads.approvalBypassBy,
    })
    .from(sessionThreads)
    .where(eq(sessionThreads.id, thread.id))
    .limit(1);
  const archivedAt = rows[0]?.archivedAt ?? undefined;
  const title = rows[0]?.title ?? undefined;

  const summary = threadToSummary(
    thread.id,
    thread.toThreadData().createdAt,
    session.id,
    rows[0]?.lastUserActivityAt ?? thread.toThreadData().createdAt,
    title,
    thread.modelId(),
    thread.key,
    archivedAt,
    thread.reasoning() ?? null,
  );
  const response: PatchThreadResponse = {
    ...summary,
    ...(rows[0]?.shareMode ? { share: rows[0].shareMode } : {}),
    ...(rows[0]?.approvalBypassBy ? { approvalBypass: true as const } : {}),
    ...(cancelledWork ? { cancelledWork } : {}),
  };
  return c.json(response);
}

messagesRouter.post("/:id/threads", (c) => createThread(c, c.req.param("id")));

export async function createThread(c: Context<AppEnv>, sessionId: string) {
  const result = await loadEngineSession(c, sessionId);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;
  const { db } = c.var.providers;

  let parsed: unknown = {};
  try {
    const text = await c.req.text();
    parsed = text ? JSON.parse(text) : {};
  } catch {
    return c.json({ error: "invalid JSON body. Send a JSON object." }, 400);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return c.json({ error: "invalid JSON body. Send a JSON object." }, 400);
  }
  const body = parsed as CreateThreadRequest;
  if (body.sourceThreadId !== undefined && typeof body.sourceThreadId !== "string") {
    return c.json({ error: "sourceThreadId must be a string. Select a thread from this session." }, 400);
  }

  if (body.title !== undefined && typeof body.title !== "string") {
    return c.json({ error: "Set title to a string." }, 400);
  }
  const title = body.title?.trim() || undefined;
  if (title && title.length > MAX_THREAD_TITLE_CHARS) {
    return c.json({ error: `title is too long. Use ${MAX_THREAD_TITLE_CHARS} characters or fewer.` }, 400);
  }

  const sourceThreadId = body.sourceThreadId;
  // An empty id names no thread; `visibleThread` would read it as the default.
  let source = sourceThreadId ? await visibleThread(c, session, engineSession, sourceThreadId) : null;
  if (sourceThreadId && !source && engineSession.options.readOnlyReason) {
    const [mapped] = await db.select({ sessionId: assistantExecutions.sessionId }).from(assistantExecutions)
      .innerJoin(assistants, eq(assistants.id, assistantExecutions.assistantId))
      .where(and(eq(assistants.sessionId, session.id), sql`exists (select 1 from engine_threads t
        where t.session_id = ${assistantExecutions.sessionId} and t.id = ${sourceThreadId})`)).limit(1);
    if (mapped) {
      const loaded = await loadEngineSession(c, mapped.sessionId);
      if (!("error" in loaded)) source = await visibleThread(c, loaded.session, loaded.engineSession, sourceThreadId);
    }
  }
  if (sourceThreadId !== undefined && !source) {
    return c.json({ error: "thread not found. Select a thread from this session." }, 404);
  }

  const { summary } = await openThread(c, result, { source, title });
  return c.json(summary, 201);
}

/**
 * Create a thread in a loaded session: the body of `POST .../threads`, and
 * the destination of a fork. Forks and new team conversations get their own
 * execution sessions. `source` lends its model and
 * reasoning level when the person keeps current settings for new threads.
 */
export async function openThread(
  c: Context<AppEnv>,
  loaded: { session: typeof agentSessions.$inferSelect; engineSession: EngineSession; meta: Awaited<ReturnType<typeof loadSessionMeta>> },
  opts: { source?: Thread | null; title?: string; isolated?: boolean; channels?: string[] },
): Promise<{ thread: Thread; summary: CreateThreadResponse }> {
  const { session, engineSession, meta } = loaded;
  const { db, engineHost } = c.var.providers;
  const { source, title } = opts;
  const assistant = opts.isolated ? await loadAssistantBySessionId(db, session.id) : undefined;
  if (opts.isolated && (!assistant || assistant.orgId !== session.orgId
    || assistant.ownerType !== session.ownerType || assistant.ownerId !== (session.ownerId || session.userId)
    || (assistant.ownerType !== "user" && assistant.ownerType !== "team"))) {
    throw new ValidationError("This session cannot be forked into an isolated working directory while preserving its tools and persona. Start a new session instead.");
  }
  if (opts.isolated && assistant) {
    const current = await findDefaultAssistant(db, session.orgId, { type: assistant.ownerType, id: assistant.ownerId });
    if (current?.id !== assistant.id) {
      throw new ValidationError("This retained assistant cannot be forked without changing its persona and sender. Start a new conversation in your current workspace instead.");
    }
  }
  const behaviorRows = await db
    .select({ newThreadBehavior: users.newThreadBehavior })
    .from(users)
    .where(eq(users.id, c.var.user.id))
    .limit(1);
  const keepCurrent = behaviorRows[0]?.newThreadBehavior !== "use_defaults";
  const settings = (opts.isolated || keepCurrent) && source
    ? {
        model: source.modelId() ?? engineSession.options.modelSpec ?? engineSession.options.model.id,
        reasoning: parseReasoningLevel(
          source.reasoning() ?? engineSession.options.sampling?.reasoning,
        ),
      }
    : await engineHost.resolveFreshThreadSettings(session.id, meta, c.var.user.id);

  // Engine identifies threads by `key`; we generate a fresh one so each
  // POST creates a new thread (calling thread() with an existing key
  // returns the cached one).
  const key = `web:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const target = opts.isolated && assistant
    ? (await ensureAssistantExecution(c.var.providers, { type: assistant.ownerType, id: assistant.ownerId },
      { orgId: session.orgId, actorUserId: c.var.user.id }, key, { isolated: true, metadata: { [SLACK_CHANNELS_METADATA_KEY]: opts.channels ?? [] } })).session
    : engineSession.options.readOnlyReason && session.ownerType === "team"
    ? (await ensureAssistantExecution(c.var.providers, { type: "team", id: session.ownerId },
      { orgId: session.orgId, actorUserId: c.var.user.id }, key)).session
    : engineSession;
  const thread = await target.createThread(key, settings);
  if (title) {
    await db.insert(sessionThreads).values({
      id: thread.id, sessionId: target.id,
      createdAt: thread.toThreadData().createdAt, title,
    }).onConflictDoUpdate({ target: sessionThreads.id, set: { title } });
  }
  const summary: CreateThreadResponse = threadToSummary(
    thread.id,
    thread.toThreadData().createdAt,
    target.id,
    thread.toThreadData().createdAt,
    title,
    thread.modelId(),
    thread.key,
    undefined,
    thread.reasoning() ?? null,
  );
  return { thread, summary };
}

/**
 * Resolve the target thread from a `?threadId=` query param or body field.
 * Returns either the matching engine Thread, or the session's default thread
 * when no id was supplied. Returns null if a specific id was given but no
 * thread matches — caller should 404.
 */
function resolveThread(
  engineSession: EngineSession,
  threadId: string | undefined,
) {
  if (!threadId) return engineSession.thread();
  return engineSession.threadById(threadId);
}

/** `resolveThread`, but only a thread this request may see
 * (`services/thread-access.ts`): a team runtime's private thread reads as
 * missing to anyone else. */
async function visibleThread(
  c: Context<AppEnv>,
  session: { ownerType: string },
  engineSession: EngineSession,
  threadId: string | undefined,
) {
  const thread = resolveThread(engineSession, threadId);
  return thread && await threadsVisibleTo(c, session)(threadRef(thread)) ? thread : undefined;
}

// ── Messages: list ────────────────────────────────────────────────────────

messagesRouter.get("/:id/messages", (c) => listMessages(c, c.req.param("id")));

/** Read an earlier path without moving the active leaf or restoring files. */
export async function branchPreview(c: Context<AppEnv>, sessionId: string, threadId: string) {
  const loaded = await loadEngineSession(c, sessionId);
  if ("error" in loaded) return loaded.error;
  const thread = await visibleThread(c, loaded.session, loaded.engineSession, threadId);
  if (!thread) return c.json({ error: "Thread not found." }, 404);
  const noteId = c.req.query("noteEntryId");
  if (!noteId) return c.json({ error: "Choose an earlier version to view." }, 400);
  const snapshot = await c.var.providers.engineStore.getThreadSnapshot(sessionId, threadId);
  const note = snapshot?.entries.find((entry) => entry.id === noteId);
  if (!snapshot || note?.type !== "branch_summary" || !note.branchLeafId
    || !snapshot.entries.some((entry) => entry.id === note.branchLeafId)) {
    return c.json({ error: "This version is not here. Reload the thread and choose another version." }, 404);
  }
  let path = walkTranscriptDag(snapshot.entries, note.branchLeafId);
  const cursor = c.req.query("cursor");
  if (cursor) {
    const index = path.findIndex((entry) => entry.id === cursor);
    if (index < 0) return c.json({ error: "This preview changed. Open the version again." }, 400);
    path = path.slice(0, index);
  }
  const parsedLimit = Number.parseInt(c.req.query("limit") ?? "50", 10);
  const limit = Number.isFinite(parsedLimit) ? Math.min(100, Math.max(1, parsedLimit)) : 50;
  const hasMore = path.length > limit;
  const tail = path.slice(-limit);
  const response: ListMessagesResponse = {
    messages: tail.map((entry) => entryToMessage(entry, sessionId, threadId)).filter((message): message is Message => message !== null),
    hasMore,
    ...(hasMore && tail[0] ? { nextCursor: tail[0].id } : {}),
  };
  return c.json(response);
}

export async function listMessages(c: Context<AppEnv>, sessionId: string, threadId?: string) {
  if (sessionId.startsWith("wf:")) return listWorkflowStepMessages(c, sessionId, threadId);
  const result = await loadEngineSession(c, sessionId);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;

  await ensureDefaultThreadWhereOwned(session.id, engineSession);
  const requested = threadId ?? (c.req.query("threadId") || undefined);
  const thread = await visibleThread(c, session, engineSession, requested);
  if (!thread) {
    return c.json({ error: "thread not found" }, 404);
  }

  const parsedLimit = Number.parseInt(c.req.query("limit") ?? "100", 10);
  const queueItemId = c.req.query("queueItemId") || undefined;
  const requestedLimit = Number.isNaN(parsedLimit) ? 100 : Math.max(1, parsedLimit);
  const limit = queueItemId ? Math.min(2000, requestedLimit) : requestedLimit;
  const cursor = c.req.query("cursor") ?? undefined;
  // Read one extra row so the bounded tail can report whether older rows
  // exist. The response still contains at most the requested limit.
  const entries = await thread.readEntries({ limit: limit + 1, cursor, queueItemId });
  const hasMore = entries.length > limit;
  const tail = hasMore ? entries.slice(1) : entries;

  // Large tool results ship trimmed; a step loads its full output when it opens.
  const messages = tail
    .map((e) => entryToMessage(e, session.id, thread.id))
    .filter((m): m is Message => m !== null)
    .map((m) => m.parts.length ? { ...m, parts: trimToolResults(m.parts, { entryId: m.id, threadId: thread.id }) } : m);

  const body: ListMessagesResponse = {
    messages,
    hasMore,
    nextCursor: undefined, // engine cursor pagination is opaque; revisit if needed
  };
  return c.json(body);
}

/**
 * A workflow step session's messages, for the run page's step logs. The
 * session has no app row, so `loadEngineSession` cannot reach it. Whoever may
 * read the run reads its steps, by the same check as `get_run`, and the read
 * is bounded like the live path. Nothing builds the session.
 */
async function listWorkflowStepMessages(c: Context<AppEnv>, sessionId: string, threadId?: string) {
  const missing = () => c.json({ error: "session not found" }, 404);
  let runId: string;
  try { ({ runId } = parseWorkflowSessionId(sessionId)); } catch { return missing(); }
  const { deps, owner } = workflowRequestContext(c);
  if (!(await canReadWorkflowRun(deps, owner, runId))) return missing();
  const store = c.var.providers.engineStore;
  const requested = threadId ?? (c.req.query("threadId") || undefined);
  const thread = requested ? await store.getThread(sessionId, requested) : (await store.listThreads(sessionId))[0];
  if (!thread) return c.json({ error: "thread not found" }, 404);
  const parsedLimit = Number.parseInt(c.req.query("limit") ?? "100", 10);
  const limit = Math.min(2000, Number.isNaN(parsedLimit) ? 100 : Math.max(1, parsedLimit));
  const queueItemId = c.req.query("queueItemId") || undefined;
  const entries = await store.getEntries(sessionId, thread.id, { limit: limit + 1, cursor: c.req.query("cursor") ?? undefined, queueItemId });
  const hasMore = entries.length > limit;
  const body: ListMessagesResponse = {
    messages: (hasMore ? entries.slice(1) : entries)
      .map((e) => entryToMessage(e, sessionId, thread.id))
      .filter((m): m is Message => m !== null),
    hasMore,
    nextCursor: undefined,
  };
  return c.json(body);
}

// ── Messages: send prompt ─────────────────────────────────────────────────

/**
 * Queue one user prompt on a session's thread and touch the session row so
 * list ordering reflects recency. This is the whole submit path: the route
 * below wraps it in authorization and HTTP, and `POST /api/sessions` calls it
 * to honour `CreateSessionRequest.initialPrompt`. Slash commands live here
 * for that reason — an initial prompt that starts with "/" must dispatch the
 * same way a typed one does.
 *
 * Returns null when `threadId` names no thread of this session. The caller
 * must have authorized the session already — this function does not.
 */
export async function submitSessionPrompt(
  providers: Pick<Providers, "db" | "engineHost">,
  row: typeof agentSessions.$inferSelect,
  text: string,
  opts?: {
    threadId?: string;
    appPageHint?: AppPageHint;
    attachments?: SendPromptRequest["attachments"];
    fileRefs?: SendPromptRequest["fileRefs"];
    queueMode?: "followup" | "inject" | "steer";
    promoteItemId?: string;
    /** The authenticated sender, persisted on the user entry as `MessageEntry.author`. */
    author?: PromptAuthor;
    /** False for agent-driven submissions, which must not reorder the sidebar. */
    recordUserActivity?: boolean;
    /** Internal continuation ceiling. Never read from the public message body. */
    toolScope?: ToolScope;
    /** Resolve the preceding task's ceiling again when the turn starts. */
    inheritToolScope?: boolean;
    /** Server-validated assistant entry reference. */
    replyTo?: MessageReplyReference;
    /** Authorized, request-scoped fork command operation. */
    forkThread?: (threadId: string, prompt: string) => Promise<string>;
    /** The sender's earlier user message that this text replaces (`Thread.editMessage`). */
    editEntryId?: string;
    /** With `editEntryId`: also undo the files the replaced turns changed. */
    undoFiles?: boolean;
  },
): Promise<SendPromptResponse | null> {
  const { threadId, attachments, fileRefs, author, recordUserActivity = true, replyTo, editEntryId, undoFiles } = opts ?? {};
  const admission = { queueMode: opts?.queueMode, promoteItemId: opts?.promoteItemId };
  const { db, engineHost } = providers;
  const engineSession = await engineHost.sessionFor(row.id, await loadSessionMeta(db, row));
  // A prompt is USE: a hibernated row flips back to active here even when
  // the turn never touches the sandbox (chat-only — no ready transition
  // ever fires the attachment-side hooks).
  await engineHost.markSessionUsed(row.id);

  await ensureDefaultThreadWhereOwned(row.id, engineSession);
  const thread = resolveThread(engineSession, threadId);
  if (!thread) return null;
  const recordActivity = (activityAt: number) => recordUserActivity
    ? recordThreadUserActivity(db, {
        sessionId: row.id,
        threadId: thread.id,
        threadCreatedAt: thread.toThreadData().createdAt,
        activityAt,
        emit: (event) => engineSession.emit(event),
      })
    : Promise.resolve();

  if (admission.promoteItemId) {
    const receipt = await thread.promoteQueuedItem(admission.promoteItemId);
    const activityAt = Date.now();
    await recordSessionActivity(db, row.id, activityAt);
    await recordThreadActivityBestEffort(() => recordActivity(activityAt));
    return {
      messageId: receipt.queueItemId || null,
      threadId: receipt.threadId,
      activityAt,
    };
  }

  // Reject reply-plus-command before consuming single-use attachment refs.
  const outcome = text.startsWith("/") ? dispatchCommand(text, engineSession.commandRegistry()) : null;
  if (replyTo && outcome?.kind === "execute") {
    throw new ValidationError("A reply must include a message. Cancel the reply before you run a slash command.");
  }
  if (editEntryId !== undefined && outcome && outcome.kind !== "pass") {
    throw new ValidationError("An edited message cannot run a slash command. Send the command as a new message.");
  }

  if (outcome?.kind === "execute" && outcome.resolved.source === "builtin" && outcome.resolved.name === "fork"
    && (attachments?.length || fileRefs?.length)) {
    throw new ValidationError("Send /fork with an optional text prompt only. Attach files in the new thread.");
  }

  // Resolve file attachment refs. Consumption is atomic for the whole
  // batch: the loop is synchronous, so two concurrent submits can never
  // both take the same ref (single-use holds under races). A bad ref in
  // the batch — or any failure before the prompt is queued — restores
  // every ref this request took, so the good refs survive for a retry.
  const attachmentRefStore = getAttachmentRefStore();
  const resolvedFileAttachments: AttachmentInfo[] = [];

  // The same ref listed twice in one request attaches its file once.
  const uniqueRefs = [...new Set((fileRefs ?? []).map((r) => r.ref))];
  for (const ref of uniqueRefs) {
    const info = attachmentRefStore.consume(row.id, ref);
    if (!info) {
      // Ref not found, expired, already used, or wrong session.
      attachmentRefStore.restore(resolvedFileAttachments);
      throw new UnknownAttachmentError(ref);
    }
    resolvedFileAttachments.push(info);
  }

  // Resolve "/"-text against the registry BEFORE choosing a path. Every
  // path targets the REQUESTED thread — never silently rerouted:
  // - execute-kind (builtin/plugin) → `session.prompt()` with the resolved
  //   thread id, so the command_result lands where the client is watching.
  // - expand-kind (skill/template) → expand here, then submit the expanded
  //   text to the requested thread like any prompt.
  // - pass-kind (unknown "/word", e.g. "/etc/passwd is the file") → the
  //   requested thread, text unchanged.

  // Build the prompt content once per text variant: plain text, or text +
  // attachments. The expand path swaps only the text; the attachment
  // mapping must stay identical on both paths.
  //
  // Image attachments map to the existing shape; file attachments add a
  // system-authored note and persist on MessageEntry.attachments.
  const imageAttachments =
    attachments && attachments.length > 0
      ? attachments.map((att) => ({
          type: "image" as const,
          url: att.url,
          mimeType: att.mimeType,
          name: att.name,
        }))
      : undefined;

  // Build final attachment array: images + files
  const allAttachments = [
    ...(imageAttachments ?? []),
    ...resolvedFileAttachments.map((info) => ({
      type: "file" as const,
      path: info.path,
      bytes: info.bytes,
      sha256: info.sha256,
      mimeType: info.mimeType ?? "application/octet-stream",
      markdownPath: info.markdownPath,
      extractedTo: info.extractedTo,
      extractedFiles: info.extractedFiles,
      name: info.name,
    })),
  ];

  // The file-attachment note is NOT baked into the prompt text here: the
  // engine renders it at transcript-build time from the persisted
  // MessageEntry.attachments (see `userContentBlocks` in the engine), so
  // the persisted user text stays clean and slash-command dispatch below
  // still sees text that starts with "/".
  const promptText = outcome?.kind === "expand" ? outcome.text : text;

  const withAttachments = (t: string) =>
    allAttachments.length > 0 ? { text: t, attachments: allAttachments } : t;

  // A submit failure hands the consumed refs back so a retry can resend
  // them. Once the prompt is queued the refs stay consumed — the
  // attachments are already part of the persisted prompt.
  // A context-invocation skill expansion carries the skill identity as
  // submission metadata; the persisted entry's wire projection renders it
  // as a skill card without re-parsing the text.
  const skillMetadata =
    outcome?.kind === "expand" && outcome.skill
      ? { skill: outcome.skill.source.name, skillArgs: outcome.skill.args }
      : undefined;
  const appPageHint = author && !author.externalSender && isAssistantConversationOf(thread.key, author.id)
    ? readAppPageHint(opts?.appPageHint) : undefined;
  const continuationMetadata = {
    ...(appPageHint ? { appPageHint } : {}),
    ...(opts?.toolScope ? { [TOOL_SCOPE_KEY]: opts.toolScope } : {}),
    ...(opts?.inheritToolScope ? { [INHERIT_TOOL_SCOPE_KEY]: true } : {}),
  };

  // This is the user action time. Persist it only after the engine accepts
  // the prompt, so a slow command cannot overtake a later user submission.
  const activityAt = Date.now();
  let receipt;
  try {
    receipt = editEntryId !== undefined
      ? await thread.editMessage(editEntryId, withAttachments(promptText), {
          metadata: continuationMetadata,
          ...(author ? { author } : {}),
        }, { undoFiles: undoFiles === true })
      : outcome && outcome.kind === "execute"
        ? await engineSession.prompt(withAttachments(promptText), {
            threadId: thread.id,
            ...(opts?.forkThread ? { forkThread: opts.forkThread } : {}),
            ...(admission.queueMode ? { queueMode: admission.queueMode } : {}),
            ...(author ? { author } : {}),
            metadata: { ...(replyTo ? { [REPLY_METADATA_KEY]: replyTo } : {}), ...continuationMetadata },
          })
        : await thread.submitPrompt(withAttachments(promptText), {
            ...(admission.queueMode ? { queueMode: admission.queueMode } : {}),
            metadata: { ...(skillMetadata ?? {}), ...(replyTo ? { [REPLY_METADATA_KEY]: replyTo } : {}), ...continuationMetadata },
            ...(outcome?.kind === "expand" && outcome.skill
              ? { skillInvocation: { skill: outcome.skill.source, path: outcome.skill.path } }
              : {}),
            ...(author ? { author } : {}),
          });
  } catch (err) {
    attachmentRefStore.restore(resolvedFileAttachments);
    throw err;
  }

  // Session recency is completion time. `activityAt` marks request start and
  // can be older than a later submission that already finished.
  const sessionTouchedAt = Date.now();
  await recordSessionActivity(db, row.id, sessionTouchedAt);
  await recordThreadActivityBestEffort(() => recordActivity(activityAt));

  return {
    // Commands take no queue item; "" would read as a real (broken) id.
    messageId: receipt.queueItemId || null,
    threadId: receipt.threadId,
    activityAt,
  };
}

messagesRouter.post("/:id/messages", (c) => sendPrompt(c, c.req.param("id")));

/**
 * The key of the thread a prompt targets: the route's thread, else the
 * body's `threadId`. Undefined for the default thread, an unknown thread,
 * or an unreadable body; `sendPrompt` reports a bad body itself. Hono
 * caches the parsed body, so the second read in `sendPrompt` is free.
 */
async function promptThreadKey(c: Context<AppEnv>, sessionId: string, threadId: string | undefined): Promise<string | undefined> {
  let id = threadId;
  if (id === undefined) {
    const parsed: unknown = await c.req.json().catch(() => undefined);
    if (typeof parsed === "object" && parsed !== null && "threadId" in parsed && typeof parsed.threadId === "string") {
      id = parsed.threadId;
    }
  }
  if (!id) return undefined;
  return (await c.var.providers.engineStore.getThread(sessionId, id))?.key;
}

export async function sendPrompt(c: Context<AppEnv>, sessionId: string, threadId?: string) {
  const row = await loadOwnedSession(c, sessionId);
  if (!row) return c.json({ error: "session not found" }, 404);
  const loadedPrompt = await loadEngineSession(c, sessionId, undefined, await promptThreadKey(c, sessionId, threadId));
  if ("error" in loadedPrompt) return loadedPrompt.error;

  let body: SendPromptRequest;
  try {
    body = (await c.req.json()) as SendPromptRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  body = { ...body, threadId: threadId ?? body.threadId };
  const promoteItemId =
    typeof body.promoteItemId === "string" && body.promoteItemId.length > 0
      ? body.promoteItemId
      : undefined;
  if (!promoteItemId && typeof body.text !== "string") {
    return c.json({ error: "text must be a string (it may be empty with attachments)" }, 400);
  }
  if (body.queueMode !== undefined && body.queueMode !== "followup" && body.queueMode !== "inject" && body.queueMode !== "steer") {
    return c.json(
      { error: "queueMode must be 'followup', 'inject' or 'steer'. Omit it to use the thread default." },
      400,
    );
  }
  if (body.attachments !== undefined) {
    const valid =
      Array.isArray(body.attachments) &&
      body.attachments.every(
        (a) => a !== null && typeof a === "object" && typeof a.url === "string" && typeof a.mimeType === "string",
      );
    if (!valid) {
      return c.json(
        { error: "attachments must be an array of { url, mimeType } image objects. Re-attach the images and send again." },
        400,
      );
    }
  }
  if (Array.isArray(body.attachments) && body.attachments.length > 20) {
    return c.json({ error: "At most 20 images are allowed per message." }, 400);
  }
  if (body.fileRefs !== undefined) {
    const valid =
      Array.isArray(body.fileRefs) &&
      body.fileRefs.every((a) => a !== null && typeof a === "object" && typeof a.ref === "string");
    if (!valid) {
      return c.json(
        { error: "fileRefs must be an array of { ref } objects. Re-upload the files and retry." },
        400,
      );
    }
  }

  if (!promoteItemId && !body.text.trim() && !body.attachments?.length && !body.fileRefs?.length) {
    return c.json({ error: "Add a message or an attachment." }, 400);
  }
  if (body.editEntryId !== undefined) {
    if (typeof body.editEntryId !== "string" || body.editEntryId.length === 0) {
      return c.json({ error: "editEntryId must name one of your messages in this thread." }, 400);
    }
    if (promoteItemId || body.replyToMessageId !== undefined || body.queueMode !== undefined) {
      return c.json({ error: "An edit cannot also reply, promote, or set a queue mode. Send the edit alone." }, 400);
    }
  }
  if (body.undoFiles !== undefined && (typeof body.undoFiles !== "boolean" || body.editEntryId === undefined)) {
    return c.json({ error: "undoFiles must be true or false, and only with editEntryId." }, 400);
  }
  if (row.ownerType === "team" && body.threadId !== undefined) {
    const loaded = await loadEngineSession(c, sessionId);
    if ("error" in loaded) return loaded.error;
    if (!await visibleThread(c, row, loaded.engineSession, body.threadId)) return c.json({ error: "thread not found" }, 404);
  }

  if (loadedPrompt.engineSession.options.readOnlyReason) return c.json({ error: loadedPrompt.engineSession.options.readOnlyReason }, 409);
  // A shared thread's guest sends prompts only. A command such as /model
  // changes the owner's thread, and a file reference names an upload into
  // the owner's working directory.
  if (c.var.threadShareGuest) {
    if (body.fileRefs?.length) return c.json({ error: "Files cannot be attached in a shared thread. Paste the content into the message." }, 403);
    const text = body.text ?? "";
    if (text.startsWith("/") && dispatchCommand(text, loadedPrompt.engineSession.commandRegistry()).kind === "execute") {
      return c.json({ error: "Only the thread owner can run commands in a shared thread. Send the request as a message." }, 403);
    }
  }

  try {
    let replyTo: MessageReplyReference | undefined;
    if (body.replyToMessageId !== undefined) {
      if (typeof body.replyToMessageId !== "string" || body.replyToMessageId.length === 0) {
        return c.json({ error: "replyToMessageId must name an assistant message in this thread." }, 400);
      }
      const loaded = await loadEngineSession(c, sessionId);
      if ("error" in loaded) return loaded.error;
      const targetThread = await visibleThread(c, loaded.session, loaded.engineSession, body.threadId);
      if (!targetThread) return c.json({ error: "thread not found" }, 404);
      const entries = await targetThread.readEntries();
      const target = entries.find(
        (entry): entry is Extract<SessionEntry, { type: "message" }> =>
          entry.type === "message" && entry.id === body.replyToMessageId,
      );
      const excerpt =
        target?.role === "assistant" && target.stopReason === "end_turn"
          ? assistantReplyExcerpt(target)
          : "";
      if (!target || target.role !== "assistant" || target.stopReason !== "end_turn" || !excerpt) {
        return c.json(
          { error: "Reply target not found in this thread. Reply to a completed assistant message." },
          400,
        );
      }
      replyTo = { messageId: target.id, excerpt };
    }

    // Stamp the sender on the submission. The engine persists it on the
    // user entry (`MessageEntry.author`); on team-owned sessions several
    // members share one thread, and both the UI and the model need to tell
    // their messages apart.
    let fork: ForkThreadResponse | undefined;
    const resp = await submitSessionPrompt(c.var.providers, row, body.text ?? "", {
      forkThread: async (sourceThreadId, prompt) => {
        const result = await forkThreadAt(c, sessionId, sourceThreadId, { latest: true, prompt });
        if (result instanceof Response) {
          const failure: unknown = await result.json();
          throw new ValidationError(typeof failure === "object" && failure !== null && "error" in failure && typeof failure.error === "string"
            ? failure.error : "Cannot branch this thread. Reload the thread and try again.");
        }
        fork = result;
        return `Branched the conversation. [Open the new thread](${(publicUrlFromEnv(process.env) ?? new URL(c.req.url).origin).replace(/\/+$/, "")}/threads/${encodeURIComponent(fork.thread.id)}).`;
      },
      threadId: body.threadId,
      appPageHint: readAppPageHint(body.appPageHint),
      attachments: body.attachments,
      fileRefs: body.fileRefs,
      ...(body.queueMode ? { queueMode: body.queueMode } : {}),
      ...(promoteItemId ? { promoteItemId } : {}),
      author: promptAuthorFromUser(c.var.user, c.var.principal, c.var.authVia),
      ...(replyTo ? { replyTo } : {}),
      ...(body.editEntryId !== undefined ? { editEntryId: body.editEntryId, undoFiles: body.undoFiles === true } : {}),
    });
    if (!resp) return c.json({ error: "thread not found" }, 404);
    return c.json({ ...resp, ...(fork ? { fork: fork.thread } : {}) }, 202);
  } catch (err) {
    if (err instanceof UnknownAttachmentError) {
      return c.json(
        {
          error: err.message,
          corrective: "Re-upload the file and retry.",
        },
        400,
      );
    }
    if (err instanceof NotFoundError && err.resource === "queue item") {
      return c.json(
        {
          error: "That queued message was not found. Send the message again.",
        },
        404,
      );
    }
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
}

// ── Thread abort ──────────────────────────────────────────────────────────
//
// Mirrors the engine-spec route table: `POST .../threads/:threadId/abort`
// interrupts only the turn named by the gesture target. `Thread.interrupt()`
// stamps abort intent only if that item is still active, withdraws its gates,
// and starts the next queued submission. A delayed retry cannot abort it.
messagesRouter.post("/:id/threads/:threadId/abort", (c) => abortThread(c, c.req.param("id"), c.req.param("threadId")));

export async function abortThread(c: Context<AppEnv>, sessionId: string, threadId: string) {
  const result = await loadEngineSession(c, sessionId);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;

  const thread = await visibleThread(c, session, engineSession, threadId);
  if (!thread) return c.json({ error: "thread not found" }, 404);

  const rawBody = await c.req.text();
  if (rawBody.trim().length === 0) {
    // Clients loaded before target-bound Stop cannot identify the turn that
    // the gesture saw. Never guess: a delayed bodyless retry could otherwise
    // abort the queued successor. The durable error event gives those tabs a
    // visible reload instruction instead of only a rejected fetch in console.
    await engineSession.emit({
      type: "error",
      threadId,
      code: "client_update_required",
      error: "Valet was updated. Reload this page, then select Stop again.",
      recoverable: true,
    });
    return c.json(
      {
        error: "This Stop request came from an older client.",
        corrective: "Reload this page, then select Stop again.",
      },
      409,
    );
  }

  let body: AbortThreadRequest;
  try {
    body = JSON.parse(rawBody) as AbortThreadRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof body.targetItemId !== "string" ||
    body.targetItemId.length === 0
  ) {
    return c.json({ error: "targetItemId is required. Send the active queue item as targetItemId." }, 400);
  }

  await thread.interrupt(body.targetItemId);
  return c.json({ ok: true });
}

// One queued message the person no longer wants. Only a message that has not
// started is canceled here; a started turn ends with Stop (`abortThread`).
// ── Thread branches (docs/specs/2026-10-22-thread-edit-fork-design.md) ──
//
// An edit is a send with `editEntryId` (`sendPrompt`). A return moves the
// leaf back to the version a branch note left. A fork copies the active path
// into a new thread in the same workspace.

export async function editPreview(c: Context<AppEnv>, sessionId: string, threadId: string) {
  const entryId = c.req.query("entryId");
  if (!entryId) return c.json({ error: "entryId must name one of your messages in this thread." }, 400);
  const loaded = await loadEngineSession(c, sessionId);
  if ("error" in loaded) return loaded.error;
  const thread = await visibleThread(c, loaded.session, loaded.engineSession, threadId);
  if (!thread) return c.json({ error: "thread not found" }, 404);
  const preview = await thread.previewEdit(entryId, promptAuthorFromUser(c.var.user, c.var.principal, c.var.authVia).id);
  const body: EditPreviewResponse = {
    ...(preview.refusal ? { refusal: preview.refusal } : {}),
    turns: preview.turns,
    actions: preview.actions.map(({ label, count, urls }) => ({ label, count, urls })),
    moreActions: preview.moreActions,
    grants: preview.grants,
    files: preview.files.map((file) => repoPath(file.repo, file.path)),
    pushed: preview.pushed,
  };
  return c.json(body);
}

export async function returnToBranch(c: Context<AppEnv>, sessionId: string, threadId: string) {
  const body = await readOptionalJsonObject(c);
  const noteEntryId = body?.noteEntryId;
  if (typeof noteEntryId !== "string" || noteEntryId.length === 0) {
    return c.json({ error: "noteEntryId must name a version note in this thread." }, 400);
  }
  const restoreFiles = body?.restoreFiles;
  if (restoreFiles !== undefined && typeof restoreFiles !== "boolean") {
    return c.json({ error: "restoreFiles must be true or false." }, 400);
  }
  const loaded = await loadEngineSession(c, sessionId);
  if ("error" in loaded) return loaded.error;
  const thread = await visibleThread(c, loaded.session, loaded.engineSession, threadId);
  if (!thread) return c.json({ error: "thread not found" }, 404);
  try {
    const result: ReturnToBranchResponse = await thread.returnToBranch(noteEntryId, { id: c.var.user.id }, { restoreFiles: restoreFiles === true });
    return c.json(result);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    if (err instanceof ConflictError) return c.json({ error: err.message }, 409);
    throw err;
  }
}

export async function forkThread(c: Context<AppEnv>, sessionId: string, threadId: string) {
  const body = await readOptionalJsonObject(c);
  const entryId = body?.entryId;
  if (typeof entryId !== "string" || entryId.length === 0) {
    return c.json({ error: "entryId must name a message in this thread." }, 400);
  }
  const result = await forkThreadAt(c, sessionId, threadId, { entryId });
  return result instanceof Response ? result : c.json(result, 201);
}

/** Both the message command and the fork endpoint use this authorized operation. */
async function forkThreadAt(
  c: Context<AppEnv>, sessionId: string, threadId: string,
  selection: { entryId: string } | { latest: true; prompt: string },
): Promise<ForkThreadResponse | Response> {
  const loaded = await loadEngineSession(c, sessionId);
  if ("error" in loaded) return loaded.error;
  const access = await threadEntry(c, loaded.session, threadId);
  if (!access || access.as === "guest") {
    return c.json({ error: "Only the thread owner or a team member can branch this thread. Ask the owner to make a branch." }, 403);
  }
  const command = "latest" in selection ? selection : undefined;
  const entryId = "entryId" in selection ? selection.entryId : undefined;
  const source = await visibleThread(c, loaded.session, loaded.engineSession, threadId);
  if (!source) return c.json({ error: "thread not found" }, 404);

  // A user message branches from just before it, and its text goes to the
  // new thread's composer. Any other entry branches through itself.
  const active = await source.readEntries();
  const selectedId = command
    ? [...active].reverse().find((entry) => entry.type === "message" && entry.role === "assistant" && entry.stopReason === "end_turn")?.id
    : entryId;
  let index = active.findIndex((entry) => entry.id === selectedId);
  if (command && index >= 0) {
    // These notes remain part of the completed context. Stop before a new
    // turn or the command echo, so unfinished work stays in the source.
    while (active[index + 1]?.type === "branch_summary" || active[index + 1]?.type === "compaction") index++;
  }
  const entry = active[index];
  if (!entry && !command) {
    return c.json({ error: "That message is not in this version of the conversation. Reload the thread and try again." }, 404);
  }
  const typed = !command && entry?.type === "message" && entry.role === "user" && !entry.signal;
  let path: SessionEntry[];
  try {
    path = await source.forkPath(typed ? active[index - 1]?.id ?? null : entry?.id ?? null);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }

  // A team fork keeps the source's audience. A private thread cannot keep
  // it in a new thread, so it is refused; Slack channel gates are copied.
  const { db } = c.var.providers;
  const audience = loaded.session.ownerType === "team" ? await threadAudience(db, sessionId, threadId) : undefined;
  if (audience?.privateTo !== undefined) {
    return c.json({ error: "This thread is private to you, and a branch would show its history to your team. Copy what you need into a new thread instead." }, 400);
  }

  // A team conversation runs in its own execution session. Its fork starts
  // from the team runtime, as a new team thread does.
  const [execution] = await db.select({ runtimeId: assistants.sessionId }).from(assistantExecutions)
    .innerJoin(assistants, eq(assistants.id, assistantExecutions.assistantId))
    .where(eq(assistantExecutions.sessionId, sessionId)).limit(1);
  const home = execution && execution.runtimeId !== sessionId ? await loadEngineSession(c, execution.runtimeId) : loaded;
  if ("error" in home) return home.error;
  const [titled] = await db.select({ title: sessionThreads.title }).from(sessionThreads)
    .where(and(eq(sessionThreads.sessionId, sessionId), eq(sessionThreads.id, threadId))).limit(1);
  const title = titled?.title ? `${titled.title} (branch)`.slice(0, MAX_THREAD_TITLE_CHARS) : undefined;

  let opened: Awaited<ReturnType<typeof openThread>>;
  try {
    opened = await openThread(c, home, { source, title, isolated: true, channels: audience?.channels });
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
  const { thread, summary } = opened;
  // The governing thread receives these gates at execution creation. Keep
  // them on the visible thread too, before any history or files are copied.
  for (const channel of audience?.channels ?? []) await thread.addToMetadataList(SLACK_CHANNELS_METADATA_KEY, channel);
  // A fork in its own working directory (a team conversation) takes the
  // source's files at the fork point along, as git bundles in the blob store.
  const seed = summary.sessionId !== sessionId ? await exportForkSeed(c, loaded.engineSession, path, thread.id) : undefined;
  await thread.copyPath(path, { source: { sessionId, threadId }, actorId: c.var.user.id, ...(seed ? { seed } : {}) });
  const response: ForkThreadResponse = {
    thread: summary,
    ...(typed && entry?.type === "message" ? { draft: entry.content } : {}),
  };
  if (command?.prompt) {
    const destination = await loadOwnedSession(c, summary.sessionId);
    if (!destination) return c.json({ error: "New thread not found. Open the thread list and try again." }, 404);
    await submitSessionPrompt(c.var.providers, destination, command.prompt, {
      threadId: thread.id,
      author: promptAuthorFromUser(c.var.user, c.var.principal, c.var.authVia),
    });
  }
  return response;
}

/**
 * The source thread's files at a fork point, one git bundle per repository
 * that the copied turns changed, saved under the fork's id. Undefined when no
 * copied turn changed files; a reason when the files cannot come along.
 */
async function exportForkSeed(
  c: Context<AppEnv>,
  source: EngineSession,
  path: readonly SessionEntry[],
  forkThreadId: string,
): Promise<{ repos: ForkSeedRecord[] } | { skipped: string } | undefined> {
  const plan = planForkSeed(path);
  if (plan.length === 0) return undefined;
  try {
    // A fork reads live compute outside a model turn. Reserve ownership before the first sandbox await.
    const seed = await source.claimExecution(async () => {
      const repos: ForkSeedRecord[] = [];
      for (const [index, repo] of plan.entries()) {
        const bundle = await exportSeedBundle(source.sandbox, source.options.workspace, repo);
        const blobKey = `fork-seed/${forkThreadId}/${index}`;
        await c.var.providers.blobs.put(blobKey, bundle, { contentType: "application/x-git-bundle" });
        repos.push({ repo: repo.repo, snapshot: repo.snapshot, blobKey, ...(repo.branch ? { branch: repo.branch } : {}) });
      }
      return { repos };
    }, path[0]?.threadId);
    return seed ?? { skipped: "the source configuration or sandbox is changing; retry the branch to copy its files" };
  } catch (err) {
    return { skipped: `the files could not be read from the original thread: ${err instanceof Error ? err.message : String(err)}` };
  }
}

messagesRouter.post("/:id/threads/:threadId/queue/:itemId/cancel", (c) => cancelQueuedItem(c, c.req.param("id"), c.req.param("threadId")));

export async function cancelQueuedItem(c: Context<AppEnv>, sessionId: string, threadId: string) {
  const result = await loadEngineSession(c, sessionId);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;

  const thread = await visibleThread(c, session, engineSession, threadId);
  if (!thread) return c.json({ error: "thread not found" }, 404);

  // One store CAS decides: a claim or a Send now that lands first wins, and
  // the person is told the message is no longer queued.
  const itemId = c.req.param("itemId");
  if (!itemId || !await thread.cancelQueuedItem(itemId)) {
    return c.json({ error: "This message is no longer queued. If it started, select Stop to end it." }, 409);
  }
  return c.json({ ok: true });
}

// A queue can be busy without an active Stop target while paused or between
// durable claims. This control resumes a paused queue and kicks an unpaused
// queue without stamping abort intent on any submission.
messagesRouter.post("/:id/threads/:threadId/resume", (c) => resumeThread(c, c.req.param("id"), c.req.param("threadId")));

export async function resumeThread(c: Context<AppEnv>, sessionId: string, threadId: string) {
  const result = await loadEngineSession(c, sessionId);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;

  if (!await visibleThread(c, session, engineSession, threadId)) return c.json({ error: "thread not found" }, 404);

  await engineSession.resume({ threadId });
  return c.json({ ok: true });
}

// ── Decision gates ────────────────────────────────────────────────────────
//
// A gate is created by a tool calling `ctx.requestDecision(...)`. The engine
// emits `decision_gate` on the bus (forwarded to the WS by the bridge) and
// suspends the thread on `blocked_on_decision_gate` status. The user resolves
// or withdraws via these endpoints, which routes to `Session.resolveDecision`
// / `Session.withdrawDecision` — which finds the thread that owns the gate
// and unblocks it.

async function canAnswerDecision(c: Context<AppEnv>, session: SessionOwnerLike, sessionId: string): Promise<boolean> {
  if (session.ownerType === "org" && sessionId.startsWith("wf:")) {
    return c.var.principal.type === "user" && session.ownerId === c.var.user.orgId
      && await isOrgAdminUser(c);
  }
  return canResolveSessionGate(c.var.providers.db, session, c.var.principal);
}

/** The 403 for a caller who may see a gate but not answer it. A shared
 * thread's guest never answers: approvals stay with the thread's owner. */
function decisionDenied(c: Context<AppEnv>) {
  const error = c.var.threadShareGuest
    ? "Only the thread owner can answer approvals in a shared thread. Ask the owner to answer it."
    : "Only the session owner or a member of its team can resolve this approval. Ask one of them.";
  return c.json({ error }, 403);
}

/** Workflow agent gates have a run owner, but no app session row. Only
 * decision endpoints use this fallback; it grants no sandbox or prompt access.
 */
export async function loadDecisionSession(c: Context<AppEnv>, id: string, threadId?: string) {
  if (!id.startsWith("wf:")) return loadEngineSession(c, id, { threadId });
  const missing = () => ({ error: c.json({ error: "session not found" }, 404) });
  let parts;
  try { parts = parseWorkflowSessionId(id); } catch { return missing(); }
  const p = c.var.providers;
  const run = await p.workflowStore.getRun(parts.runId);
  if (!run?.owner) return missing();
  const [definition] = await p.db.select({ orgId: workflowDefinitions.orgId })
    .from(workflowDefinitions).where(eq(workflowDefinitions.id, run.params.workflowId)).limit(1);
  if (!definition || definition.orgId !== c.var.user.orgId) return missing();
  const session = {
    ownerType: run.owner.ownerType, ownerId: run.owner.ownerId,
    userId: run.owner.ownerType === "user" ? run.owner.ownerId : "",
    orgId: definition.orgId,
  };
  if (!(await canAnswerDecision(c, session, id))) return missing();
  const decisionApproverOnly = !await runVisible(c, { ownerType: run.owner.ownerType, origin: run.params.origin, actorUserId: run.actorUserId, params: run.params });
  if (decisionApproverOnly) {
    const gates = await p.engineStore.listDecisionGates(id, threadId, "pending");
    if (c.var.principal.type !== "user" || !gates.some(gate => gateApprover(gate)?.userId === c.var.principal.id)) return missing();
  }
  // A guessed node ID must not materialize a new agent on a read request.
  if (!(await p.engineStore.getSession(id))) return missing();
  const engineSession = await ensureWorkflowSession({
    db: p.db, store: p.workflowStore, engineStore: p.engineStore,
    host: p.engineHost, actionPluginByService: p.actionPluginByService,
    credentials: p.engineCredentials,
  }, id);
  return { session: { ...session, decisionApproverOnly }, engineSession };
}

/** Pending gates on threads this request may see. Another pod may have made
 * the thread after this one loaded the session, so a thread missing here is
 * read from the store. A gate whose thread is gone stays hidden. */
async function visibleGates(c: Context<AppEnv>, session: { ownerType: string; decisionApproverOnly?: boolean }, engineSession: EngineSession) {
  const visible = threadsVisibleTo(c, session);
  const pending = await engineSession.pendingDecisionGates();
  const shown = await Promise.all(pending.map(async (gate) => {
    // The member asked to lend their account answers the gate even when the
    // requester's thread is private to the requester.
    const approver = gateApprover(gate)?.userId;
    if (approver !== undefined && approver === viewerOf(c).userId) return true;
    if (session.decisionApproverOnly) return false;
    const thread = engineSession.threadById(gate.threadId)
      ?? await c.var.providers.engineStore.getThread(engineSession.id, gate.threadId);
    return !!thread && visible(threadRef(thread));
  }));
  return pending.filter((_, i) => shown[i]);
}

messagesRouter.get("/:id/decisions", (c) => listDecisions(c, c.req.param("id")));

export async function listDecisions(c: Context<AppEnv>, sessionId: string, threadId?: string) {
  const result = await loadDecisionSession(c, sessionId, threadId);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;

  const pending = await visibleGates(c, session, engineSession);
  const body: ListDecisionsResponse = { gates: pending.filter(gate => !threadId || gate.threadId === threadId).map(engineGateToWire) };
  return c.json(body);
}

messagesRouter.post("/:id/decisions/:gateId/resolve", (c) => resolveDecision(c, c.req.param("id")));

export async function resolveDecision(c: Context<AppEnv>, sessionId: string, threadId?: string) {
  const result = await loadDecisionSession(c, sessionId, threadId);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;
  const gateId = c.req.param("gateId");

  // Explicit resolve authorization, distinct from `loadEngineSession`'s
  // view check: answering a gate acts on the session's behalf. The same
  // named check gates the channel gate-callback path.
  if (!(await canAnswerDecision(c, session, sessionId))) {
    return decisionDenied(c);
  }

  let body: ResolveDecisionRequest;
  try {
    body = (await c.req.json()) as ResolveDecisionRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  // Accept only bounded inline images, never URLs that would require a server fetch.
  if (body.attachments !== undefined) {
    let totalBytes = 0;
    const valid = Array.isArray(body.attachments) && body.attachments.length <= 20 && body.attachments.every((image) => {
      if (!image || typeof image.url !== "string" || typeof image.mimeType !== "string"
        || (image.name !== undefined && typeof image.name !== "string") || image.url.length > 7 * 1024 * 1024) return false;
      const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+=*)$/.exec(image.url);
      if (!match || match[1] !== image.mimeType) return false;
      const bytes = Buffer.byteLength(match[2]!, "base64");
      totalBytes += bytes;
      return bytes > 0 && bytes <= 5 * 1024 * 1024 && totalBytes <= 15 * 1024 * 1024;
    });
    if (!valid) return c.json({ error: "Attach up to 20 PNG, JPEG, GIF, or WebP images, at most 5 MB each and 15 MB total." }, 400);
  }
  if (body.actionId === undefined && body.value === undefined && !body.attachments?.length) {
    return c.json({ error: "actionId or value is required" }, 400);
  }
  // A typed answer is text. Refuse anything else before it resolves the gate:
  // a resolved gate cannot be answered again.
  if ((body.value !== undefined && typeof body.value !== "string") || (body.actionId !== undefined && typeof body.actionId !== "string")) {
    return c.json({ error: "Send actionId and value as text, such as {\"value\": \"staging\"}." }, 400);
  }

  // Route-level 403 for `always_allow` (action-policies plan, Task 4):
  // defense-in-depth's front half — `onResolution` (T3) already fails this
  // closed for a non-admin resolver, but only after the engine has already
  // opened/consumed the gate. Rejecting here means a non-admin never sees
  // the button "work" only to fail late; the button itself should be hidden
  // client-side, this is the server-side backstop. `canApplyAlwaysAllow` is
  // the shared guard (also called by the channel gate-callback path) and is
  // checked against the SESSION's org, the scope the policy write lands in.
  if (body.actionId === GATE_ACTION_ALWAYS_ALLOW) {
    // A team key carries the minting admin as `c.var.user` for audit only;
    // an org-wide policy is that admin's decision to make signed in, never
    // a CI key's. Every other org-admin gate short-circuits the same way
    // (`_org-admin.ts`).
    if (c.var.principal.type === "team") {
      return c.json(
        { error: "A team API key cannot grant an always-allow policy. Sign in as an organization admin to apply it." },
        403,
      );
    }
    if (!(await canApplyAlwaysAllow(c.var.providers.db, session.orgId, c.var.user.id))) {
      return c.json({ error: "org admin required for always_allow" }, 403);
    }
  }
  if (body.actionId === GATE_ACTION_ALWAYS_ALLOW_OWNER && c.var.principal.type === "team") {
    return c.json({ error: "A team API key cannot always allow an action. Sign in to apply it." }, 403);
  }

  // Confirm the gate is actually pending in this session before resolving.
  // Without this check, a stale gateId from the client would silently no-op.
  const pending = await visibleGates(c, session, engineSession);
  const gate = pending.find((g) => g.id === gateId && (!threadId || g.threadId === threadId));
  if (!gate) return c.json({ error: "gate not pending" }, 404);
  // The owner's lasting allow follows the same rule: refuse it here, before
  // the engine consumes the gate, when the caller may not set it. A critical
  // action or a team rule needs a team admin, so the check reads what the
  // gate recorded about both.
  if (body.actionId === GATE_ACTION_ALWAYS_ALLOW_OWNER) {
    const refusal = await ownerAlwaysAllowRefusal(c.var.providers.db, {
      orgId: session.orgId, sessionId, ...gatePolicyFacts(gate),
      ...(session.ownerType === "team" ? { teamId: session.ownerId } : { userId: session.ownerId }),
    }, c.var.user.id);
    if (refusal) return c.json({ error: refusal }, 403);
  }
  // An MCP client or a `valet login` key is an agent. It may answer a
  // question, but an approval or a credential request needs a person, or
  // require_approval policy would let one agent approve another's actions.
  if (isAgentCaller(c.var.authVia) && gate.type !== "question") {
    return c.json({ error: "A person must approve this request. Open the thread in Valet to approve or deny it." }, 403);
  }
  if (body.attachments?.length && gate.type !== "question") {
    return c.json({ error: "Images can only answer questions. Use the approval buttons for this request." }, 400);
  }
  if (!answersGate(gate, c.var.principal)) {
    return c.json({ error: isSharedAccountGate(gate)
      ? `Only ${gateApprover(gate)?.name ?? "the account's owner"} can allow use of their account.`
      : `Only ${gateApprover(gate)?.name ?? "the person who asked"} can answer this request. Ask them in the thread.` }, 403);
  }

  if (body.actionId === "always_allow_account" && (
    c.var.principal.type !== "user" || !["session", "stub"].includes(c.var.authVia)
    || !gateApprover(gate) || !gate.actions.some(action => action.id === "always_allow_account")
  )) {
    return c.json({ error: "Open this account approval in Valet as the account owner to allow it for the team." }, 403);
  }

  if (gate.context?.browser) {
    const policy = c.var.providers.engineHost.browserPolicy();
    if (c.var.principal.type !== 'user' || !policy) {
      return c.json({ error: 'A browser approval requires an authorized user. Sign in to Valet.' }, 403);
    }
    try {
      await policy.authorize({ protocolVersion: '1.0', sessionId,
        threadId: gate.threadId, actorId: c.var.user.id, ownerId: session.ownerId });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Browser access changed. Reopen the session.' }, 403);
    }
  }

  await engineSession.resolveDecision(gateId, {
    actionId: body.actionId,
    value: body.value,
    ...(body.attachments?.length ? { attachments: body.attachments } : {}),
    resolvedBy: c.var.user.id,
    resolvedAt: Date.now(),
    source: { channelType: "web" },
  });
  return c.json({ ok: true });
}

messagesRouter.post("/:id/decisions/:gateId/withdraw", (c) => withdrawDecision(c, c.req.param("id")));

export async function withdrawDecision(c: Context<AppEnv>, sessionId: string, threadId?: string) {
  const result = await loadDecisionSession(c, sessionId, threadId);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;
  const gateId = c.req.param("gateId");

  // Same explicit resolve authorization as the resolve route above —
  // withdrawing settles the gate too.
  if (!(await canAnswerDecision(c, session, sessionId))) {
    return decisionDenied(c);
  }

  let body: WithdrawDecisionRequest = {};
  try {
    const text = await c.req.text();
    body = text ? (JSON.parse(text) as WithdrawDecisionRequest) : {};
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  // The user-initiated path should always be `cancel`. `steer` and `abort`
  // are engine-internal reasons; reject them so we don't end up with
  // misleading audit records.
  const reason = body.reason ?? "cancel";
  if (reason !== "cancel") {
    return c.json({ error: "only reason='cancel' is allowed from clients" }, 400);
  }

  const pending = await visibleGates(c, session, engineSession);
  const gate = pending.find((g) => g.id === gateId && (!threadId || g.threadId === threadId));
  if (!gate) return c.json({ error: "gate not pending" }, 404);

  await engineSession.withdrawDecision(gateId, reason);
  return c.json({ ok: true });
}
