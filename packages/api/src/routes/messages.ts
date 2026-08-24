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
import { Hono, type Context } from "hono";
import { eq, inArray } from "drizzle-orm";
import { dispatchCommand, formatFileAttachmentsNote } from "@valet/engine";
import type { SessionEntry, Session as EngineSession } from "@valet/engine";
import type { AppEnv } from "../env.js";
import { agentSessions, sessionThreads } from "../schema/index.js";
import { makeCommandContext } from "../engine/command-providers.js";
import type {
  CreateThreadRequest,
  CreateThreadResponse,
  ListCommandsResponse,
  WireCommandInfo,
  ListDecisionsResponse,
  ListMessagesResponse,
  ListThreadsResponse,
  Message,
  MessagePart,
  MessageRole,
  PatchThreadRequest,
  PromptFileAttachment,
  PromptImageAttachment,
  ResolveDecisionRequest,
  SendPromptRequest,
  SendPromptResponse,
  ThreadSummary,
  WithdrawDecisionRequest,
} from "../wire/types.js";
import { commandResultEntryToMessage, engineGateToWire, engineSignalToWire, engineToWireParts } from "../engine/bridge.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import { GATE_ACTION_ALWAYS_ALLOW } from "../policies/service.js";
import { isOrgAdmin } from "../services/org.js";
import type { Providers } from "../providers/types.js";
import { canViewSession } from "../services/session-access.js";
import { getAttachmentRefStore, type AttachmentInfo } from "../services/attachment-refs.js";

export const messagesRouter = new Hono<AppEnv>();

/**
 * Every route in this file (threads, messages, decisions) shares this one
 * check — view access, not just direct ownership, so a team's orchestrator
 * session works the same way here as `GET /api/sessions/:id` does (see
 * `services/session-access.ts`). Session lifecycle routes (delete, pause,
 * model change — in `routes/sessions.ts`) are NOT widened by this; talking
 * to a team's orchestrator is not the same decision as reconfiguring it.
 */
async function loadOwnedSession(c: Context<AppEnv>) {
  const { db } = c.var.providers;
  const id = c.req.param("id");
  const userId = c.var.user.id;
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, id)).limit(1);
  const row = rows[0];
  if (!row || !(await canViewSession(db, row, userId))) return null;
  return row;
}

export function entryToMessage(e: SessionEntry, sessionId: string, threadId: string): Message | null {
  if (e.type === "command_result") {
    return commandResultEntryToMessage(e, sessionId, threadId);
  }
  if (e.type !== "message") return null;
  // Engine has 4 roles: user/assistant/tool/system. We forward as-is.
  const role: MessageRole = e.role;
  const parts: MessagePart[] = engineToWireParts(e.parts);
  // Engine entries have createdAt as `string` (ISO-ish) per BaseEntry. Coerce
  // to number for the wire.
  const created = typeof e.createdAt === "number" ? e.createdAt : Date.parse(e.createdAt as unknown as string);
  // Project engine image attachments into the wire shape. The engine holds
  // either a `data:` URL or raw bytes; the wire ships one canonical
  // `data:` URL string. Skip entries missing both (nothing to render).
  const wireAttachments = projectAttachments(e.attachments);
  return {
    id: e.id,
    sessionId,
    threadId,
    role,
    content: e.content,
    parts,
    createdAt: Number.isFinite(created) ? created : Date.now(),
    queueItemId: e.queueItemId,
    signal: engineSignalToWire(e.signal),
    model: e.model,
    ...(wireAttachments.length > 0 ? { attachments: wireAttachments } : {}),
  };
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
  title?: string,
  model?: string,
  key?: string,
  archivedAt?: number,
): ThreadSummary {
  return { id: threadId, sessionId, title, createdAt, model, key, archivedAt };
}

async function loadEngineSession(
  c: Context<AppEnv>,
): Promise<{ session: typeof agentSessions.$inferSelect; engineSession: EngineSession } | { error: Response }> {
  const session = await loadOwnedSession(c);
  if (!session) return { error: c.json({ error: "session not found" }, 404) };
  const { engineHost, db } = c.var.providers;

  // Repo bindings + git identity (GitHub/repo integration plan, Task 9) —
  // assembled centrally via `loadSessionMeta` so EVERY `sessionFor` caller
  // carries them. The first call to actually build the session (create or
  // restore) wires `prepareSandbox`; later calls are no-op reads once cached
  // (`sessionFor` returns early without touching `meta`).
  const engineSession = await engineHost.sessionFor(session.id, await loadSessionMeta(db, session));
  return { session, engineSession };
}

messagesRouter.get("/:id/threads", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;
  const { db } = c.var.providers;

  await engineSession.ensureDefaultThread();
  const threads = engineSession.listThreads();

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
        })
        .from(sessionThreads)
        .where(inArray(sessionThreads.id, ids))
    : [];
  const metaById = new Map(
    metaRows.map((r) => [r.id, { title: r.title ?? undefined, archivedAt: r.archivedAt ?? undefined }] as const),
  );

  // Default list excludes archived threads; `?archived=1` lists only them.
  const wantArchived = c.req.query("archived") === "1";
  const summaries = threads
    .filter((t) => (metaById.get(t.id)?.archivedAt !== undefined) === wantArchived)
    .map((t) =>
      threadToSummary(
        t.id,
        t.toThreadData().createdAt,
        session.id,
        metaById.get(t.id)?.title,
        t.modelId(),
        t.key,
        metaById.get(t.id)?.archivedAt,
      ),
    );
  const body: ListThreadsResponse = { threads: summaries };
  return c.json(body);
});

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

messagesRouter.patch("/:id/threads/:threadId", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;
  const { db } = c.var.providers;

  const threadId = c.req.param("threadId");
  const thread = engineSession.threadById(threadId);
  if (!thread) return c.json({ error: "thread not found" }, 404);

  let body: PatchThreadRequest;
  try {
    body = (await c.req.json()) as PatchThreadRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (body.model === undefined && body.archived === undefined) {
    return c.json(
      { error: "nothing to patch: send model (null to clear) and/or archived" },
      400,
    );
  }

  if (body.model !== undefined) {
    try {
      await thread.setModel(
        typeof body.model === "string" ? body.model : null,
      );
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  }

  let archivedAt: number | undefined;
  if (body.archived !== undefined) {
    // Upsert — the mirror row may not exist yet (auto-title hasn't run).
    const next = body.archived ? Date.now() : null;
    await db
      .insert(sessionThreads)
      .values({
        id: thread.id,
        sessionId: session.id,
        createdAt: thread.toThreadData().createdAt,
        archivedAt: next,
      })
      .onConflictDoUpdate({
        target: sessionThreads.id,
        set: { archivedAt: next },
      });
    archivedAt = next ?? undefined;
  } else {
    const rows = await db
      .select({ archivedAt: sessionThreads.archivedAt })
      .from(sessionThreads)
      .where(eq(sessionThreads.id, thread.id))
      .limit(1);
    archivedAt = rows[0]?.archivedAt ?? undefined;
  }

  const summary = threadToSummary(
    thread.id,
    thread.toThreadData().createdAt,
    session.id,
    undefined,
    thread.modelId(),
    thread.key,
    archivedAt,
  );
  return c.json(summary);
});

messagesRouter.post("/:id/threads", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;

  let body: CreateThreadRequest = {};
  try {
    const text = await c.req.text();
    body = text ? (JSON.parse(text) as CreateThreadRequest) : {};
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  // Engine identifies threads by `key`; we generate a fresh one so each
  // POST creates a new thread (calling thread() with an existing key
  // returns the cached one).
  const key = `web:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const thread = engineSession.thread(key);
  const summary: CreateThreadResponse = threadToSummary(
    thread.id,
    thread.toThreadData().createdAt,
    session.id,
    body.title,
    thread.modelId(),
    thread.key,
  );
  return c.json(summary, 201);
});

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

// ── Messages: list ────────────────────────────────────────────────────────

messagesRouter.get("/:id/messages", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;

  await engineSession.ensureDefaultThread();
  const requested = c.req.query("threadId") || undefined;
  const thread = resolveThread(engineSession, requested);
  if (!thread) return c.json({ error: "thread not found" }, 404);

  const limit = Number.parseInt(c.req.query("limit") ?? "100", 10);
  const cursor = c.req.query("cursor") ?? undefined;
  const entries = await thread.readEntries({ limit, cursor });

  const messages = entries
    .map((e) => entryToMessage(e, session.id, thread.id))
    .filter((m): m is Message => m !== null);

  const body: ListMessagesResponse = {
    messages,
    hasMore: entries.length === limit,
    nextCursor: undefined, // engine cursor pagination is opaque; revisit if needed
  };
  return c.json(body);
});

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
  threadId?: string,
  attachments?: SendPromptRequest["attachments"],
  fileRefs?: SendPromptRequest["fileRefs"],
): Promise<SendPromptResponse | null> {
  const { db, engineHost } = providers;
  const engineSession = await engineHost.sessionFor(row.id, await loadSessionMeta(db, row));
  // A prompt is USE: a hibernated row flips back to active here even when
  // the turn never touches the sandbox (chat-only — no ready transition
  // ever fires the attachment-side hooks).
  await engineHost.markSessionUsed(row.id);

  await engineSession.ensureDefaultThread();
  const thread = resolveThread(engineSession, threadId);
  if (!thread) return null;

  // Resolve file attachment refs
  const attachmentRefStore = getAttachmentRefStore();
  const resolvedFileAttachments: AttachmentInfo[] = [];

  if (fileRefs && fileRefs.length > 0) {
    for (const { ref } of fileRefs) {
      const info = attachmentRefStore.consume(row.id, ref);
      if (!info) {
        // Ref not found, expired, or wrong session
        throw new Error(`unknown attachment: ${ref}`);
      }
      resolvedFileAttachments.push(info);
    }
  }

  // Resolve "/"-text against the registry BEFORE choosing a path. Every
  // path targets the REQUESTED thread — never silently rerouted:
  // - execute-kind (builtin/plugin) → `session.prompt()` with the resolved
  //   thread id, so the command_result lands where the client is watching.
  // - expand-kind (skill/template) → expand here, then submit the expanded
  //   text to the requested thread like any prompt.
  // - pass-kind (unknown "/word", e.g. "/etc/passwd is the file") → the
  //   requested thread, text unchanged.
  const outcome = text.startsWith("/") ? dispatchCommand(text, engineSession.commandRegistry()) : null;

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

  // Wire the annotation: prepend file attachment note to content
  let promptText = outcome?.kind === "expand" ? outcome.text : text;
  if (resolvedFileAttachments.length > 0) {
    const note = formatFileAttachmentsNote(resolvedFileAttachments);
    promptText = `${note}\n\n${promptText}`;
  }

  const withAttachments = (t: string) =>
    allAttachments.length > 0 ? { text: t, attachments: allAttachments } : t;

  const receipt =
    outcome && outcome.kind === "execute"
      ? await engineSession.prompt(withAttachments(promptText), { threadId: thread.id })
      : await thread.submitPrompt(withAttachments(promptText), {});

  await db
    .update(agentSessions)
    .set({ updatedAt: Date.now() })
    .where(eq(agentSessions.id, row.id));

  return {
    // Commands take no queue item; "" would read as a real (broken) id.
    messageId: receipt.queueItemId || null,
    threadId: receipt.threadId,
  };
}

messagesRouter.post("/:id/messages", async (c) => {
  const row = await loadOwnedSession(c);
  if (!row) return c.json({ error: "session not found" }, 404);

  let body: SendPromptRequest;
  try {
    body = (await c.req.json()) as SendPromptRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body.text || typeof body.text !== "string") {
    return c.json({ error: "text is required" }, 400);
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

  try {
    const resp = await submitSessionPrompt(
      c.var.providers,
      row,
      body.text,
      body.threadId,
      body.attachments,
      body.fileRefs,
    );
    if (!resp) return c.json({ error: "thread not found" }, 404);
    return c.json(resp, 202);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("unknown attachment:")) {
      return c.json(
        {
          error: err.message,
          corrective: "Re-upload the file and retry.",
        },
        400,
      );
    }
    throw err;
  }
});

// ── Thread abort ──────────────────────────────────────────────────────────
//
// Mirrors the engine-spec route table: `POST .../threads/:threadId/abort`
// aborts the current turn on this thread and clears its queue. Delegates to
// `Session.abort({ threadId })`, which stamps `abortRequestedAt` durably and
// lets the claim/reconcile settlement path record the terminal outcome —
// see `packages/engine/src/session.ts` `abort()`. A thread with nothing
// running/queued is a no-op: `Thread.abort()` withdraws no gates, aborts a
// non-streaming agent (a safe no-op), and settles zero unclaimed items.
messagesRouter.post("/:id/threads/:threadId/abort", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { engineSession } = result;

  const threadId = c.req.param("threadId");
  const thread = engineSession.threadById(threadId);
  if (!thread) return c.json({ error: "thread not found" }, 404);

  await engineSession.abort({ threadId });
  return c.json({ ok: true });
});

// ── Decision gates ────────────────────────────────────────────────────────
//
// A gate is created by a tool calling `ctx.requestDecision(...)`. The engine
// emits `decision_gate` on the bus (forwarded to the WS by the bridge) and
// suspends the thread on `blocked_on_decision_gate` status. The user resolves
// or withdraws via these endpoints, which routes to `Session.resolveDecision`
// / `Session.withdrawDecision` — which finds the thread that owns the gate
// and unblocks it.

messagesRouter.get("/:id/decisions", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { engineSession } = result;

  const pending = await engineSession.pendingDecisionGates();
  const body: ListDecisionsResponse = { gates: pending.map(engineGateToWire) };
  return c.json(body);
});

messagesRouter.post("/:id/decisions/:gateId/resolve", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { engineSession } = result;
  const gateId = c.req.param("gateId");

  let body: ResolveDecisionRequest;
  try {
    body = (await c.req.json()) as ResolveDecisionRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (body.actionId === undefined && body.value === undefined) {
    return c.json({ error: "actionId or value is required" }, 400);
  }

  // Route-level 403 for `always_allow` (action-policies plan, Task 4):
  // defense-in-depth's front half — `onResolution` (T3) already fails this
  // closed for a non-admin resolver, but only after the engine has already
  // opened/consumed the gate. Rejecting here means a non-admin never sees
  // the button "work" only to fail late; the button itself should be hidden
  // client-side, this is the server-side backstop.
  if (body.actionId === GATE_ACTION_ALWAYS_ALLOW) {
    const { db } = c.var.providers;
    const user = c.var.user;
    if (!(await isOrgAdmin(db, user.orgId, user.id))) {
      return c.json({ error: "org admin required for always_allow" }, 403);
    }
  }

  // Confirm the gate is actually pending in this session before resolving.
  // Without this check, a stale gateId from the client would silently no-op.
  const pending = await engineSession.pendingDecisionGates();
  const gate = pending.find((g) => g.id === gateId);
  if (!gate) return c.json({ error: "gate not pending" }, 404);

  await engineSession.resolveDecision(gateId, {
    actionId: body.actionId,
    value: body.value,
    resolvedBy: c.var.user.id,
    resolvedAt: Date.now(),
    source: { channelType: "web" },
  });
  return c.json({ ok: true });
});

messagesRouter.post("/:id/decisions/:gateId/withdraw", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { engineSession } = result;
  const gateId = c.req.param("gateId");

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

  const pending = await engineSession.pendingDecisionGates();
  const gate = pending.find((g) => g.id === gateId);
  if (!gate) return c.json({ error: "gate not pending" }, 404);

  await engineSession.withdrawDecision(gateId, reason);
  return c.json({ ok: true });
});
