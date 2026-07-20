import type { Env } from '../env.js';
import type { AppDb } from '../lib/drizzle.js';
import {
  getSession,
  getSessionGitState,
  createSession,
  createSessionGitState,
  getUserById,
  getSessionChannelBindings,
  listUserChannelBindings,
  getOrchestratorSession,
} from '../lib/db.js';
import { getChildSessions } from '../lib/db/sessions.js';
import { getCredential } from './credentials.js';

// ─── fetchMessagesFromDO ──────────────────────────────────────────────────────

/** Default number of messages returned by a cross-session read when no limit is given. */
export const DEFAULT_MESSAGE_LIMIT = 50;

/**
 * Maximum size (in characters) of any single field on a message part. A tool result
 * holding a megabyte API dump, or the base64 `data` of an image part, is capped here so
 * one part cannot on its own approach the Runner↔DO WebSocket 1MB frame limit.
 */
export const MAX_TOOL_RESULT_CHARS = 50_000;

/**
 * Aggregate serialized-byte ceiling for one page of cross-session messages, held below
 * the 1MB WebSocket frame limit so the page still fits after the envelope around it.
 */
export const MAX_PAGE_PAYLOAD_BYTES = 768 * 1024;

/**
 * Cap oversized fields on a message's parts. Parts are usually an array, but an image
 * message stores a single part object, so a non-array part is normalized into a
 * one-element list before mapping and unwrapped again on the way out. Every field is
 * measured as it will be serialized — a string directly, anything else through
 * JSON.stringify — and one longer than MAX_TOOL_RESULT_CHARS is replaced by its
 * truncated prefix plus a marker naming how many characters were dropped. Parts that
 * need no capping are returned by identity, so the common case allocates nothing.
 */
export function truncateOversizedParts(parts: unknown): unknown {
  if (parts === null || parts === undefined) return parts;
  const list = Array.isArray(parts) ? parts : [parts];
  let mutated = false;
  const capped = list.map((part) => {
    if (!part || typeof part !== 'object') return part;
    const p = part as Record<string, unknown>;
    let next: Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(p)) {
      if (value === null || value === undefined) continue;
      const serialized =
        typeof value === 'string'
          ? value
          : typeof value === 'object'
            ? JSON.stringify(value)
            : undefined;
      if (!serialized || serialized.length <= MAX_TOOL_RESULT_CHARS) continue;
      next = next ?? { ...p };
      const dropped = serialized.length - MAX_TOOL_RESULT_CHARS;
      next[key] = `${serialized.slice(0, MAX_TOOL_RESULT_CHARS)}… [truncated ${dropped} chars]`;
    }
    if (!next) return part;
    mutated = true;
    return next;
  });
  if (!mutated) return parts;
  return Array.isArray(parts) ? capped : capped[0];
}

/**
 * Trim a page of messages so its serialized size stays under MAX_PAGE_PAYLOAD_BYTES.
 * Per-part capping bounds one part but says nothing about a page of fifty messages, so
 * the page is walked from the end the reader cares about — the newest messages for a
 * tail read, the oldest for forward paging from a cursor — and messages past the budget
 * are dropped. The surviving messages keep their chronological order. One message that
 * exceeds the budget on its own is still returned rather than the page coming back
 * empty, so the ceiling is a bound on accumulation, not a hard guarantee for a single
 * pathological message.
 */
export function applyPagePayloadBudget<T>(
  messages: T[],
  dropFrom: 'start' | 'end',
): { messages: T[]; dropped: number } {
  const encoder = new TextEncoder();
  const walkOrder = dropFrom === 'start' ? [...messages].reverse() : messages;
  const kept: T[] = [];
  let total = 0;
  for (const message of walkOrder) {
    const size = encoder.encode(JSON.stringify(message) ?? '').length;
    if (kept.length > 0 && total + size > MAX_PAGE_PAYLOAD_BYTES) break;
    total += size;
    kept.push(message);
  }
  if (dropFrom === 'start') kept.reverse();
  return { messages: kept, dropped: messages.length - kept.length };
}

/** Fetch messages from another session's DO via internal HTTP endpoint. */
export async function fetchMessagesFromDO(
  env: Env,
  targetSessionId: string,
  limit: number,
  after?: string,
  tail?: boolean,
): Promise<Array<{
  id?: string;
  sessionId?: string;
  role: string;
  content: string;
  parts?: unknown;
  authorId?: string;
  authorEmail?: string;
  authorName?: string;
  authorAvatarUrl?: string;
  channelType?: string;
  channelId?: string;
  opencodeSessionId?: string;
  threadId?: string;
  createdAt: string;
}>> {
  const doId = env.SESSIONS.idFromName(targetSessionId);
  const targetDO = env.SESSIONS.get(doId);

  const params = new URLSearchParams({ limit: String(limit) });
  if (after) params.set('after', after);
  if (tail) params.set('tail', '1');

  const res = await targetDO.fetch(new Request(`http://do/messages?${params}`));
  if (!res.ok) {
    throw new Error(`Target DO returned ${res.status}: ${await res.text()}`);
  }

  const data = await res.json() as {
    messages: Array<{
      id?: string;
      sessionId?: string;
      role: string;
      content: string;
      parts?: unknown;
      authorId?: string;
      authorEmail?: string;
      authorName?: string;
      authorAvatarUrl?: string;
      channelType?: string;
      channelId?: string;
      opencodeSessionId?: string;
      threadId?: string;
      createdAt: string;
    }>;
  };
  return data.messages.map((m) =>
    m.parts === undefined ? m : { ...m, parts: truncateOversizedParts(m.parts) },
  );
}

// ─── spawnChild ───────────────────────────────────────────────────────────────

export type SpawnChildParams = {
  task: string;
  workspace: string;
  repoUrl?: string;
  branch?: string;
  ref?: string;
  title?: string;
  sourceType?: string;
  sourcePrNumber?: number;
  sourceIssueNumber?: number;
  sourceRepoFullName?: string;
  model?: string;
  personaId?: string;
};

export type SpawnChildContext = {
  parentSessionId: string;
  userId: string;
  parentThreadId: string | undefined;
  spawnRequest: Record<string, unknown> & { doWsUrl: string; envVars: Record<string, string> };
  backendUrl: string;
  terminateUrl?: string | null;
  hibernateUrl?: string | null;
  restoreUrl?: string | null;
  idleTimeoutMs?: number | null;
};

export type SpawnChildResult =
  | { childSessionId: string; error?: undefined }
  | { error: string; childSessionId?: undefined };

export async function spawnChild(
  appDb: AppDb,
  env: Env,
  ctx: SpawnChildContext,
  params: SpawnChildParams,
): Promise<SpawnChildResult> {
  const { parentSessionId, userId, parentThreadId, spawnRequest, backendUrl, terminateUrl, hibernateUrl, restoreUrl, idleTimeoutMs } = ctx;

  // Query parent's git state to use as defaults for the child
  const parentGitState = await getSessionGitState(appDb, parentSessionId);

  // Merge: explicit params override parent defaults
  const mergedRepoUrl = params.repoUrl || parentGitState?.sourceRepoUrl || undefined;
  const mergedBranch = params.branch || parentGitState?.branch || undefined;
  const mergedRef = params.ref || parentGitState?.ref || undefined;
  const mergedSourceType = params.sourceType || parentGitState?.sourceType || undefined;
  const mergedSourcePrNumber = params.sourcePrNumber ?? parentGitState?.sourcePrNumber ?? undefined;
  const mergedSourceIssueNumber = params.sourceIssueNumber ?? parentGitState?.sourceIssueNumber ?? undefined;
  const mergedSourceRepoFullName = params.sourceRepoFullName || parentGitState?.sourceRepoFullName || undefined;

  // Generate child session identifiers
  const childSessionId = crypto.randomUUID();
  const childRunnerToken = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Create child session in D1
  await createSession(appDb, {
    id: childSessionId,
    userId,
    workspace: params.workspace,
    title: params.title || params.workspace,
    parentSessionId,
    parentThreadId,
    personaId: params.personaId,
  });

  // Create git state for child (always create if we have any git context)
  if (mergedRepoUrl || mergedSourceType) {
    // Derive sourceRepoFullName from URL if not explicitly set
    let derivedRepoFullName = mergedSourceRepoFullName;
    if (!derivedRepoFullName && mergedRepoUrl) {
      const match = mergedRepoUrl.match(/github\.com[/:]([^/]+\/[^/.]+)/);
      if (match) derivedRepoFullName = match[1];
    }

    await createSessionGitState(appDb, {
      sessionId: childSessionId,
      sourceType: (mergedSourceType as any) || 'branch',
      sourceRepoUrl: mergedRepoUrl,
      sourceRepoFullName: derivedRepoFullName,
      branch: mergedBranch,
      ref: mergedRef,
      sourcePrNumber: mergedSourcePrNumber,
      sourceIssueNumber: mergedSourceIssueNumber,
    });
  }

  // Build child DO WebSocket URL
  // Replace parent sessionId with child sessionId in the URL
  const parentDoWsUrl = spawnRequest.doWsUrl;
  const childDoWsUrl = parentDoWsUrl.replace(parentSessionId, childSessionId);

  // Build child spawn request, inheriting parent env vars
  const childSpawnRequest: Record<string, unknown> & { envVars: Record<string, string> } = {
    ...spawnRequest,
    sessionId: childSessionId,
    doWsUrl: childDoWsUrl,
    runnerToken: childRunnerToken,
    workspace: params.workspace,
    envVars: {
      ...(spawnRequest.envVars as Record<string, string> | undefined),
      PARENT_SESSION_ID: parentSessionId,
    },
  };

  // Override repo-specific env vars if we have repo info (explicit or inherited)
  if (mergedRepoUrl) {
    childSpawnRequest.envVars = {
      ...childSpawnRequest.envVars,
      REPO_URL: mergedRepoUrl,
    };
    if (mergedBranch) {
      childSpawnRequest.envVars.REPO_BRANCH = mergedBranch;
    }
    if (mergedRef) {
      childSpawnRequest.envVars.REPO_REF = mergedRef;
    }

    // Inject git credentials if the parent doesn't have them (e.g. orchestrator)
    if (!childSpawnRequest.envVars.GITHUB_TOKEN) {
      try {
        const ghResult = await getCredential(env, 'user', userId, 'github');
        if (ghResult.ok) {
          childSpawnRequest.envVars.GITHUB_TOKEN = ghResult.credential.accessToken;
        }
      } catch (err) {
        console.warn('[session-cross] Failed to fetch GitHub token for child:', err);
      }
    }

    // Inject git user identity if missing
    if (!childSpawnRequest.envVars.GIT_USER_NAME || !childSpawnRequest.envVars.GIT_USER_EMAIL) {
      try {
        const userRow = await getUserById(appDb, userId);
        if (userRow) {
          if (!childSpawnRequest.envVars.GIT_USER_NAME) {
            childSpawnRequest.envVars.GIT_USER_NAME = userRow.gitName || userRow.name || userRow.githubUsername || 'Valet User';
          }
          if (!childSpawnRequest.envVars.GIT_USER_EMAIL) {
            childSpawnRequest.envVars.GIT_USER_EMAIL = userRow.gitEmail || userRow.email;
          }
        }
      } catch (err) {
        console.warn('[session-cross] Failed to fetch user info for child git config:', err);
      }
    }
  }

  // Initialize child SessionAgentDO
  const childDoId = env.SESSIONS.idFromName(childSessionId);
  const childDO = env.SESSIONS.get(childDoId);

  await childDO.fetch(new Request('http://do/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: childSessionId,
      userId,
      workspace: params.workspace,
      runnerToken: childRunnerToken,
      backendUrl,
      terminateUrl: terminateUrl || undefined,
      hibernateUrl: hibernateUrl || undefined,
      restoreUrl: restoreUrl || undefined,
      idleTimeoutMs,
      spawnRequest: childSpawnRequest,
      initialPrompt: params.task,
      initialModel: params.model,
      parentThreadId,
    }),
  }));

  return { childSessionId };
}

// ─── sendSessionMessage ───────────────────────────────────────────────────────

export type SendSessionMessageResult =
  | { success: true; error?: undefined }
  | { error: string; success?: undefined };

export async function sendSessionMessage(
  env: Env,
  appDb: AppDb,
  userId: string,
  targetSessionId: string,
  content: string,
  interrupt?: boolean,
  callerSessionId?: string,
): Promise<SendSessionMessageResult> {
  // Verify target session belongs to the same user
  const targetSession = await getSession(appDb, targetSessionId);
  if (!targetSession || targetSession.userId !== userId) {
    return { error: 'Session not found or access denied' };
  }

  // Defense-in-depth: if the caller is an orchestrator session, verify it's the
  // *current* orchestrator — not an orphaned one from a previous restart. This
  // prevents stale sandboxes from sending duplicate steering messages.
  if (callerSessionId?.startsWith('orchestrator:')) {
    const currentOrch = await getOrchestratorSession(env.DB, userId);
    if (currentOrch && currentOrch.id !== callerSessionId) {
      console.warn(`[sendSessionMessage] Rejecting message from stale orchestrator ${callerSessionId} (current: ${currentOrch.id})`);
      return { error: 'Stale orchestrator session — message rejected' };
    }
  }

  // Forward prompt to target DO
  const targetDoId = env.SESSIONS.idFromName(targetSessionId);
  const targetDO = env.SESSIONS.get(targetDoId);

  const resp = await targetDO.fetch(new Request('http://do/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, interrupt: interrupt ?? false }),
  }));

  if (!resp.ok) {
    const errText = await resp.text();
    return { error: `Target DO returned ${resp.status}: ${errText}` };
  }

  return { success: true };
}

// ─── getSessionMessages ───────────────────────────────────────────────────────

export type GetSessionMessagesResult =
  | { messages: Array<{
      id?: string;
      sessionId?: string;
      role: string;
      content: string;
      parts?: unknown;
      authorId?: string;
      authorEmail?: string;
      authorName?: string;
      authorAvatarUrl?: string;
      channelType?: string;
      channelId?: string;
      opencodeSessionId?: string;
      threadId?: string;
      createdAt: string;
    }>; hasMore: boolean; error?: undefined }
  | { error: string; messages?: undefined; hasMore?: undefined };

export async function getSessionMessages(
  env: Env,
  appDb: AppDb,
  userId: string,
  targetSessionId: string,
  limit?: number,
  after?: string,
): Promise<GetSessionMessagesResult> {
  // Verify target session belongs to the same user
  const targetSession = await getSession(appDb, targetSessionId);
  if (!targetSession || targetSession.userId !== userId) {
    return { error: 'Session not found or access denied' };
  }

  // Fetch messages from the target DO's local SQLite (not D1). Without a cursor the
  // caller wants the end of the conversation — a child's final assistant text sits
  // behind however many tool-call messages the child produced, so a window taken from
  // the start of the conversation would never reach it. With a cursor the caller is
  // paging forward and the window stays where the cursor points.
  const effectiveLimit = limit || DEFAULT_MESSAGE_LIMIT;
  const tail = !after;
  // Over-fetch by one so a page that exactly fills the limit is not mistaken for a
  // truncated one; the probe row is dropped from whichever end the window grew towards.
  const fetched = await fetchMessagesFromDO(env, targetSessionId, effectiveLimit + 1, after, tail);
  let hasMore = fetched.length > effectiveLimit;
  const page = hasMore
    ? tail
      ? fetched.slice(fetched.length - effectiveLimit)
      : fetched.slice(0, effectiveLimit)
    : fetched;

  const budgeted = applyPagePayloadBudget(page, tail ? 'start' : 'end');
  if (budgeted.dropped > 0) hasMore = true;
  return { messages: budgeted.messages, hasMore };
}

// ─── forwardMessages ─────────────────────────────────────────────────────────

export type ForwardMessagesResult =
  | {
      messages: Array<{
        id?: string;
        sessionId?: string;
        role: string;
        content: string;
        parts?: unknown;
        authorId?: string;
        authorEmail?: string;
        authorName?: string;
        authorAvatarUrl?: string;
        channelType?: string;
        channelId?: string;
        opencodeSessionId?: string;
        threadId?: string;
        createdAt: string;
      }>;
      sessionTitle: string;
      sourceSessionId: string;
      error?: undefined;
    }
  | { error: string; messages?: undefined; sessionTitle?: undefined; sourceSessionId?: undefined };

export async function forwardMessages(
  env: Env,
  appDb: AppDb,
  userId: string,
  targetSessionId: string,
  limit?: number,
  after?: string,
): Promise<ForwardMessagesResult> {
  // Verify target session belongs to the same user
  const targetSession = await getSession(appDb, targetSessionId);
  if (!targetSession || targetSession.userId !== userId) {
    return { error: 'Session not found or access denied' };
  }

  // Fetch messages from target DO
  const messages = await fetchMessagesFromDO(env, targetSessionId, limit || 20, after);

  const sessionTitle = targetSession.title || targetSession.workspace || targetSessionId.slice(0, 8);

  return { messages, sessionTitle, sourceSessionId: targetSessionId };
}

// ─── terminateChild ───────────────────────────────────────────────────────────

export type TerminateChildResult =
  | { success: true; error?: undefined }
  | { error: string; success?: undefined };

export async function terminateChild(
  appDb: AppDb,
  env: Env,
  sessionId: string,
  userId: string,
  childSessionId: string,
): Promise<TerminateChildResult> {
  // Verify the child belongs to this parent session
  const childSession = await getSession(appDb, childSessionId);
  if (!childSession || childSession.userId !== userId) {
    return { error: 'Child session not found or access denied' };
  }
  if (childSession.parentSessionId !== sessionId) {
    return { error: 'Session is not a child of this session' };
  }

  // Stop the child via its DO
  const childDoId = env.SESSIONS.idFromName(childSessionId);
  const childDO = env.SESSIONS.get(childDoId);
  const resp = await childDO.fetch(new Request('http://do/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'terminated_by_parent' }),
  }));

  if (!resp.ok) {
    const errText = await resp.text();
    return { error: `Child DO returned ${resp.status}: ${errText}` };
  }

  return { success: true };
}

// ─── listChildSessions ────────────────────────────────────────────────────────

export async function listChildSessions(
  env: Env,
  sessionId: string,
): Promise<{ children: Awaited<ReturnType<typeof getChildSessions>>['children'] }> {
  const { children } = await getChildSessions(env.DB, sessionId);
  return { children };
}

// ─── getSessionStatus ─────────────────────────────────────────────────────────

export type SessionStatusResult =
  | {
      sessionStatus: {
        id: string;
        status: string | null;
        workspace: string;
        title: string | null;
        createdAt: string;
        lastActiveAt: string | null;
        runnerConnected: boolean;
        runnerBusy: boolean;
        queuedPrompts: number;
        agentStatus: string;
        recentMessages: Array<{ role: string; content: string; createdAt: string }>;
        tunnelUrls: Record<string, string> | null;
        tunnels: Array<{ name: string; url?: string; path?: string; port?: number; protocol?: string }> | null;
      };
      error?: undefined;
    }
  | { error: string; sessionStatus?: undefined };

export async function getSessionStatus(
  appDb: AppDb,
  env: Env,
  userId: string,
  targetSessionId: string,
): Promise<SessionStatusResult> {
  const session = await getSession(appDb, targetSessionId);
  if (!session || session.userId !== userId) {
    return { error: 'Session not found or access denied' };
  }

  // Fetch recent messages from the target DO's local SQLite (not D1)
  const recentMessages = await fetchMessagesFromDO(env, targetSessionId, 10);

  // Fetch live runner/sandbox status from target DO
  let liveStatus: {
    runnerConnected?: boolean;
    runnerBusy?: boolean;
    queuedPrompts?: number;
    sandboxId?: string | null;
    status?: string;
    tunnelUrls?: Record<string, string> | null;
    tunnels?: Array<{ name: string; url?: string; path?: string; port?: number; protocol?: string }> | null;
  } | null = null;
  try {
    const doId = env.SESSIONS.idFromName(targetSessionId);
    const targetDO = env.SESSIONS.get(doId);
    const statusRes = await targetDO.fetch(new Request('http://do/status'));
    if (statusRes.ok) {
      liveStatus = await statusRes.json() as any;
    }
  } catch (err) {
    console.warn('[session-cross] Failed to fetch live status for session:', targetSessionId, err);
  }

  const runnerBusy = liveStatus?.runnerBusy ?? false;
  const queuedPrompts = liveStatus?.queuedPrompts ?? 0;
  const runnerConnected = liveStatus?.runnerConnected ?? false;
  const agentStatus = runnerBusy || queuedPrompts > 0 ? 'working' : 'idle';

  return {
    sessionStatus: {
      id: session.id,
      status: session.status,
      workspace: session.workspace,
      title: session.title ?? null,
      createdAt: session.createdAt instanceof Date ? session.createdAt.toISOString() : String(session.createdAt),
      lastActiveAt: session.lastActiveAt instanceof Date ? session.lastActiveAt.toISOString() : String(session.lastActiveAt),
      runnerConnected,
      runnerBusy,
      queuedPrompts,
      agentStatus,
      recentMessages,
      tunnelUrls: liveStatus?.tunnelUrls ?? null,
      tunnels: liveStatus?.tunnels ?? null,
    },
  };
}

// ─── listChannels ─────────────────────────────────────────────────────────────

export type ListChannelsResult =
  | { channels: Awaited<ReturnType<typeof listUserChannelBindings>>; error?: undefined }
  | { error: string; channels?: undefined };

export async function listChannels(
  appDb: AppDb,
  sessionId: string,
  userId: string | null | undefined,
): Promise<ListChannelsResult> {
  let bindings = userId
    ? await listUserChannelBindings(appDb, userId)
    : [];

  // Fallback to session-scoped bindings if user-level bindings are unavailable.
  if (bindings.length === 0) {
    bindings = await getSessionChannelBindings(appDb, sessionId);
  }

  // Deduplicate by destination while preserving recency ordering.
  const unique: typeof bindings = [];
  const seen = new Set<string>();
  for (const binding of bindings) {
    const key = `${binding.channelType}:${binding.channelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(binding);
  }

  return { channels: unique };
}
