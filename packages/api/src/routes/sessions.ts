import { Hono } from "hono";
import { and, count, desc, eq, inArray, or } from "drizzle-orm";
import { mkdir, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseAssistantSessionId, type Principal } from "@valet/engine";
import { writeHibernated } from "../engine/hibernation-hooks.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import { computeTargetDirs } from "../engine/workspace-prep.js";
import { submitSessionPrompt } from "./messages.js";
import { autoTitle } from "../sessions/auto-title.js";
import {
  deriveRunFields,
  groupSubmissionsBySession,
  type RunStateRow,
  type SessionRunFields,
} from "../sessions/run-state.js";
import { canAdministerSession, canViewSession } from "../services/session-access.js";
import { isTeamMember, listTeamsForUser } from "../services/teams.js";
import type { AppEnv } from "../env.js";
import type { AppDb } from "../lib/drizzle.js";
import {
  agentSessions,
  childWatches,
  messages as messagesTable,
  sessionRepos,
} from "../schema/index.js";
import type {
  AssistantOwner,
  CreateSessionRequest,
  CreateSessionResponse,
  GetSessionResponse,
  ListSessionsResponse,
  PatchSessionRequest,
  PauseSessionResponse,
  RepoBinding,
  SandboxJwtResponse,
  SandboxProfile,
  SessionStatus,
  SessionSummary,
} from "../wire/types.js";

export const sessionsRouter = new Hono<AppEnv>();

function newId(prefix: string): string {
  // Short URL-safe id; not cryptographic. Engine's own id collision domain is
  // separate (prefixed `sess-...` by the engine); we use `s_...` here.
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const REPO_AUTH_VALUES = ["auto", "app", "user"] as const;

// Validates + normalizes the `repo`/`repos` create-request sugar into a flat
// list (GitHub/repo integration plan, Task 2). Returns an error message on
// the first invalid binding rather than a field-keyed map — the route
// surfaces it as a flat 400 like every other validation error here.
function parseRepoBindings(body: CreateSessionRequest): { repos: RepoBinding[] } | { error: string } {
  if (body.repo !== undefined && body.repos !== undefined) {
    return { error: "specify either 'repo' or 'repos', not both" };
  }
  const raw = body.repos ?? (body.repo !== undefined ? [body.repo] : undefined);
  if (raw === undefined) return { repos: [] };
  if (!Array.isArray(raw)) return { error: "repos must be an array" };
  if (raw.length > 5) return { error: "at most 5 repo bindings are allowed" };

  const repos: RepoBinding[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") {
      return { error: "each repo binding must be an object" };
    }
    if (typeof r.fullName !== "string" || r.fullName.trim() === "") {
      return { error: "repo binding fullName is required" };
    }
    if (typeof r.cloneUrl !== "string" || !r.cloneUrl.startsWith("https://")) {
      return { error: "repo binding cloneUrl must be an https:// URL" };
    }
    if (r.auth !== undefined && !REPO_AUTH_VALUES.includes(r.auth)) {
      return { error: "repo binding auth must be 'auto', 'app', or 'user'" };
    }
    repos.push({
      host: r.host ?? "github",
      fullName: r.fullName,
      cloneUrl: r.cloneUrl,
      ref: r.ref,
      auth: r.auth ?? "auto",
    });
  }
  return { repos };
}

async function getSessionRepos(db: AppDb, sessionId: string): Promise<RepoBinding[]> {
  const rows = await db
    .select()
    .from(sessionRepos)
    .where(eq(sessionRepos.sessionId, sessionId))
    .orderBy(sessionRepos.position);
  return rows.map((row) => ({
    host: row.host,
    fullName: row.fullName,
    cloneUrl: row.cloneUrl,
    ref: row.ref ?? undefined,
    auth: row.auth,
  }));
}

// Pure: everything it needs is the row plus the already-derived run fields
// (`sessions/run-state.ts` owns that derivation, and the queries that feed
// it). Keeping the mapper query-free is what lets the list route derive for
// every row from ONE cross-session read.
function rowToSummary(row: typeof agentSessions.$inferSelect, run: SessionRunFields): SessionSummary {
  return {
    id: row.id,
    workspace: row.workspace,
    status: row.status as SessionStatus,
    runState: run.runState,
    title: row.title ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastActivityAt: run.lastActivityAt,
    owner: { type: row.ownerType as AssistantOwner["type"], id: row.ownerId },
  };
}

/** The row fields `deriveRunFields` reads, narrowed from a full session row. */
function runStateRow(row: typeof agentSessions.$inferSelect): RunStateRow {
  return { status: row.status as SessionStatus, updatedAt: row.updatedAt };
}

// ── List ──────────────────────────────────────────────────────────────────

// Standalone-only (assistant-centered web UI decision 8): excludes
// ASSISTANT ids and child ids, server-side, so the client just renders what
// it gets. Every assistant is excluded, not only a principal's default —
// assistants are listed by `GET /api/assistants`, and a principal that owns
// several would otherwise fill this list with them. Assistant-derived
// children nest inline in the assistant's chat page (via
// GET /api/orchestrator/children) instead.
//
// Exported so other mounts needing the same "this user's standalone
// sessions" view (e.g. the MCP `list_sessions` tool, Task 9) reuse the exact
// query instead of re-deriving it.
export async function listStandaloneSessions(db: AppDb, userId: string, owner?: Principal) {
  // Own rows plus every team you are on — the same union `listWorkflowDefinitions`
  // and `listSkills` use, so one workspace's sessions read like its workflows.
  // `owner` narrows that to a single workspace; the caller has already checked
  // they may reach it.
  const teamIds = owner ? [] : (await listTeamsForUser(db, userId)).map((t) => t.id);
  const mine = and(eq(agentSessions.ownerType, "user"), eq(agentSessions.ownerId, userId));
  const teamRows =
    teamIds.length > 0
      ? and(eq(agentSessions.ownerType, "team"), inArray(agentSessions.ownerId, teamIds))
      : undefined;
  const scope = owner
    ? and(eq(agentSessions.ownerType, owner.type), eq(agentSessions.ownerId, owner.id))
    : teamRows
      ? or(mine, teamRows)
      : mine;

  const [rows, childRows] = await Promise.all([
    db
      .select()
      .from(agentSessions)
      .where(and(scope, inArray(agentSessions.status, ["active", "hibernated"])))
      .orderBy(desc(agentSessions.updatedAt)),
    db.select({ childSessionId: childWatches.childSessionId }).from(childWatches),
  ]);

  const childIds = new Set(childRows.map((r) => r.childSessionId));
  return rows.filter((r) => parseAssistantSessionId(r.id) === null && !childIds.has(r.id));
}

sessionsRouter.get("/", async (c) => {
  const { db, engineStore } = c.var.providers;
  const userId = c.var.user.id;

  // Optional workspace filter, same shape `GET /api/assistants` takes.
  const ownerType = c.req.query("ownerType");
  const ownerId = c.req.query("ownerId");
  if ((ownerType === undefined) !== (ownerId === undefined)) {
    return c.json({ error: "Filter by owner with both ownerType and ownerId, or send neither." }, 400);
  }
  let owner: Principal | undefined;
  if (ownerType !== undefined && ownerId !== undefined) {
    if (ownerType !== "user" && ownerType !== "team") {
      return c.json({ error: "ownerType must be 'user' or 'team'." }, 400);
    }
    const reachable =
      ownerType === "user" ? ownerId === userId : await isTeamMember(db, ownerId, userId);
    // 404, not 403: the same existence-hiding every cross-owner read here uses.
    if (!reachable) return c.json({ error: "owner not found" }, 404);
    owner = { type: ownerType, id: ownerId };
  }

  // Three round trips, whatever the number of sessions: the two
  // `listStandaloneSessions` makes, plus ONE cross-session read of every
  // unsettled submission (the same call the admin submissions route uses).
  // `groupSubmissionsBySession` then indexes it by session id. A per-row
  // query here would make an ordinary list cost one query per session.
  const [standalone, unsettled] = await Promise.all([
    listStandaloneSessions(db, userId, owner),
    engineStore.listAllUnsettledSubmissions(),
  ]);
  const bySession = groupSubmissionsBySession(unsettled);

  const body: ListSessionsResponse = {
    sessions: standalone.map((row) =>
      rowToSummary(row, deriveRunFields(runStateRow(row), bySession.get(row.id) ?? [])),
    ),
  };
  return c.json(body);
});

// ── Create ────────────────────────────────────────────────────────────────

sessionsRouter.post("/", async (c) => {
  const { db, engineStore, prebuildService } = c.var.providers;
  const user = c.var.user;
  let body: CreateSessionRequest;
  try {
    body = (await c.req.json()) as CreateSessionRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body.workspace || typeof body.workspace !== "string") {
    return c.json({ error: "workspace is required" }, 400);
  }
  if (!isAbsolute(body.workspace)) {
    return c.json({ error: "workspace must be an absolute path" }, 400);
  }
  if (body.profile !== undefined && body.profile !== "headless" && body.profile !== "full") {
    return c.json({ error: "profile must be 'headless' or 'full'" }, 400);
  }
  const profile = body.profile ?? "headless";
  // Rejected here, before anything is written: a mistyped `initialPrompt` is
  // a bad request, not a failed enqueue.
  if (body.initialPrompt !== undefined && typeof body.initialPrompt !== "string") {
    return c.json({ error: "initialPrompt must be a string. Send the prompt text, or omit the field." }, 400);
  }
  if (body.docker !== undefined && typeof body.docker !== "boolean") {
    return c.json({ error: "docker must be a boolean. Send true or false, or omit the field." }, 400);
  }
  const docker = body.docker === true;

  // An explicit `teamId: null` from a client that always sends the field is
  // a real shape — the body is an unchecked cast — so it must fall through to
  // a personal session rather than misroute into the team branch and 404 on a
  // team called "null". Same reasoning as `createWorkflowDefinition`.
  let owner: Principal = { type: "user", id: user.id };
  if (typeof body.teamId === "string") {
    // 404 for a non-member or unknown id, matching every other cross-owner
    // access here — existence-hiding applies to authorization, not just to
    // whether the row exists.
    if (!(await isTeamMember(db, body.teamId, user.id))) {
      return c.json({ error: "team not found" }, 404);
    }
    owner = { type: "team", id: body.teamId };
  }

  const parsedRepos = parseRepoBindings(body);
  if ("error" in parsedRepos) {
    return c.json({ error: parsedRepos.error }, 400);
  }
  const { repos } = parsedRepos;

  // Auto-create the workspace dir if it doesn't exist; reject if the path
  // exists but is a file (Docker bind-mount needs a directory).
  try {
    const st = await stat(body.workspace);
    if (!st.isDirectory()) {
      return c.json({ error: `workspace exists but is not a directory: ${body.workspace}` }, 400);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return c.json({ error: `cannot access workspace: ${(err as Error).message}` }, 400);
    }
    try {
      await mkdir(body.workspace, { recursive: true });
    } catch (mkErr) {
      return c.json({ error: `cannot create workspace: ${(mkErr as Error).message}` }, 400);
    }
  }

  const now = Date.now();
  const id = newId("s");
  // Session row + repo bindings must land atomically — a failure between
  // the two statements would otherwise leave an orphaned agentSessions row
  // with no bindings (review finding on commit d0de1af3).
  let created: typeof agentSessions.$inferSelect | undefined;
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(agentSessions)
      .values({
        id,
        userId: user.id,
        orgId: user.orgId,
        workspace: body.workspace,
        title: body.title ?? null,
        status: "active",
        ownerType: owner.type,
        ownerId: owner.id,
        profile,
        docker,
        createdAt: now,
        updatedAt: now,
      })
      // Returned rather than re-read: the `initialPrompt` submit below needs
      // the full row to assemble the session meta.
      .returning();
    created = inserted[0];

    if (repos.length > 0) {
      // Compute target dirs once at bind time (spec decision 15): each binding
      // gets a persistent subdirectory name derived from its repo name. This
      // value is stored on the row so later loads never recompute (and
      // convergence never relocates an existing clone).
      const targetDirs = computeTargetDirs(repos);
      await tx.insert(sessionRepos).values(
        repos.map((repo, position) => ({
          sessionId: id,
          host: repo.host ?? "github",
          fullName: repo.fullName,
          cloneUrl: repo.cloneUrl,
          ref: repo.ref ?? null,
          auth: repo.auth ?? "auto",
          position,
          targetDir: targetDirs[position] ?? null,
        })),
      );
    }
  });

  // Zero-config generation (spec decision 13): after the bindings land,
  // upsert each repo's image source + touch its `last_bound_at` and kick a
  // first bake in the background. Fire-and-forget — session create never
  // waits on a bake, and `ensureRepoSource` never throws.
  for (const repo of repos) {
    void prebuildService.ensureRepoSource(user.orgId, {
      host: repo.host ?? "github",
      fullName: repo.fullName,
      cloneUrl: repo.cloneUrl,
    });
  }

  // `initialPrompt` (wire `CreateSessionRequest`): queue the first turn once
  // the row and its repo bindings are durable, through the same submit path
  // `POST /api/sessions/:id/messages` uses. The prompt goes to the session's
  // default thread — a session one statement old has no other.
  //
  // An enqueue failure does NOT fail the create. The session row exists and
  // the response carries its id, so answering 500 here would leave the caller
  // believing nothing was created while an orphan row stayed behind. The
  // caller sees `runState: "idle"` instead of "working" and can send the
  // prompt again through the messages route; the server logs the cause.
  let queuedPrompt = false;
  if (body.initialPrompt && created) {
    try {
      queuedPrompt = (await submitSessionPrompt(c.var.providers, created, body.initialPrompt)) !== null;
    } catch (err) {
      console.error(`session ${id}: initialPrompt enqueue failed:`, err);
    }
  }
  // A session this new has no queue history, so the only submission it can
  // hold is the one just enqueued.
  const unsettled = queuedPrompt ? await engineStore.listUnsettledSubmissions(id) : [];

  const detail: CreateSessionResponse = {
    id,
    workspace: body.workspace,
    status: "active",
    ...deriveRunFields({ status: "active", updatedAt: now }, unsettled),
    title: body.title,
    owner,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    profile,
    docker,
    ...(repos.length > 0 ? { repos } : {}),
  };
  return c.json(detail, 201);
});

// ── Get ───────────────────────────────────────────────────────────────────

sessionsRouter.get("/:id", async (c) => {
  const { db, engineStore } = c.var.providers;
  const id = c.req.param("id");
  const userId = c.var.user.id;

  // View access, not just direct ownership — a team's orchestrator session
  // is readable by any member (see `services/session-access.ts`); every
  // other session route in this file stays direct-owner-only.
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, id)).limit(1);
  const row = rows[0];
  if (!row || !(await canViewSession(db, row, userId))) return c.json({ error: "session not found" }, 404);

  const [{ n }] = await db
    .select({ n: count() })
    .from(messagesTable)
    .where(eq(messagesTable.sessionId, id));

  // Surface the engine's session-default model. This is best-effort: if
  // the engine session hasn't been materialized yet we just omit the
  // field rather than spinning up a sandbox to read it.
  const { engineHost } = c.var.providers;
  let model: string | undefined;
  if (engineHost.isLive(id)) {
    const engineSession = await engineHost.sessionFor(id, await loadSessionMeta(db, row));
    // The canonical spec, not the wire id (`modelSpec` differs whenever the
    // resolver returned a wire-ready model for a namespaced spec).
    model = engineSession.options.modelSpec ?? engineSession.options.model.id;
  }

  const repos = await getSessionRepos(db, id);
  // One session, so one submission read — the same derivation the list uses.
  const unsettled = await engineStore.listUnsettledSubmissions(id);

  const detail: GetSessionResponse = {
    ...rowToSummary(row, deriveRunFields(runStateRow(row), unsettled)),
    messageCount: Number(n ?? 0),
    model,
    profile: row.profile,
    docker: row.docker,
    ...(repos.length > 0 ? { repos } : {}),
  };
  return c.json(detail);
});

// ── Patch (`model`, `title`, and/or `profile`) ───────────────────────────

/** Upper bound on a hand-typed session name. The auto-titler caps itself at
 * 60 characters. A person renaming a session sometimes wants more room, so
 * the manual limit is larger, but it stays bounded: the header and the
 * session lists render this string. */
const MAX_SESSION_TITLE_CHARS = 200;

/** The profile row is written before the sandbox is replaced, so a failed
 * replacement leaves a saved setting and a stale sandbox. Say both, and name
 * the one action that finishes the job. */
function profileSavedButSandboxFailed(reason: string): string {
  return `Profile saved, but the sandbox did not restart (${reason}). Use "Replace sandbox" in the session menu to apply it.`;
}

sessionsRouter.patch("/:id", async (c) => {
  const { db, engineHost, engineStore } = c.var.providers;
  const id = c.req.param("id");
  const userId = c.var.user.id;

  // Administer access, not direct ownership: on a team-owned session the
  // team's admins choose the model, not whichever member opened the
  // assistant first (see `services/session-access.ts`). The row loads
  // without an ownership filter so the check can run in application code;
  // an unauthorized caller still gets the same 404 a missing id gets.
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, id)).limit(1);
  const row = rows[0];
  if (!row || !(await canAdministerSession(db, row, userId))) return c.json({ error: "session not found" }, 404);

  let body: PatchSessionRequest;
  try {
    body = (await c.req.json()) as PatchSessionRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const wantsModel = body.model !== undefined;
  const wantsTitle = body.title !== undefined;
  const wantsProfile = body.profile !== undefined;
  const wantsOwner = body.teamId !== undefined;
  // A body with no field at all keeps the message this guard has always
  // sent. The model picker is still the only caller that can omit a field
  // by accident, and a contract test pins this exact response.
  if (!wantsModel && !wantsTitle && !wantsProfile && !wantsOwner) {
    return c.json({ error: "model is required" }, 400);
  }
  if (wantsModel && (typeof body.model !== "string" || body.model.length === 0)) {
    return c.json({ error: "model must be a non-empty string. Send a model id from GET /api/models." }, 400);
  }

  let nextTitle: string | undefined;
  if (wantsTitle) {
    if (typeof body.title !== "string") {
      return c.json({ error: "title must be a string. Send the new session name." }, 400);
    }
    nextTitle = body.title.trim();
    if (nextTitle.length === 0) {
      return c.json({ error: "title cannot be empty. Send a name with at least one character." }, 400);
    }
    if (nextTitle.length > MAX_SESSION_TITLE_CHARS) {
      return c.json(
        { error: `title is too long. Use ${MAX_SESSION_TITLE_CHARS} characters or fewer.` },
        400,
      );
    }
  }

  // A profile change recreates the sandbox, so it is refused mid-turn for
  // the same reason `POST /:id/sandbox/replace` is: the running turn would
  // lose the sandbox under it. An unchanged value is not a change and needs
  // no guard.
  let nextProfile: SandboxProfile | undefined;
  if (wantsProfile) {
    if (body.profile !== "headless" && body.profile !== "full") {
      return c.json({ error: "profile must be 'headless' or 'full'." }, 400);
    }
    if (body.profile !== row.profile) nextProfile = body.profile;
  }
  // Owner move (team-workspace-ui design, decision 5): a team id moves the
  // session to that team, `null` to the CALLER's own workspace — on a
  // team-owned session the mover is a team or org admin, and taking a
  // session personal makes it theirs. Validated like the create route:
  // membership of the target team, 404 for a non-member or unknown id.
  let nextOwner: Principal | undefined;
  if (wantsOwner) {
    if (body.teamId !== null && (typeof body.teamId !== "string" || body.teamId.length === 0)) {
      return c.json(
        { error: "teamId must be a team id, or null to move the session to your own workspace." },
        400,
      );
    }
    // An assistant's session is ADDRESSED by its owner (`assistant:{id}`):
    // the assistants table, the rail, and orchestrator resolution all answer
    // from that owner. Moving only the session row desyncs them — every
    // teammate keeps seeing the assistant but 404s opening it. The web UI
    // hides the action; the API is the contract, so it refuses too.
    if (parseAssistantSessionId(id) !== null) {
      return c.json(
        { error: "an assistant's session cannot be moved. It belongs to the assistant's owner." },
        400,
      );
    }
    // A child session is listed nowhere on its own — it nests under the
    // parent via child_watches, which a move does not touch. Moving one
    // strands it: gone from every workspace list, still nested under the
    // OLD owner's chat.
    const watch = await db
      .select({ childSessionId: childWatches.childSessionId })
      .from(childWatches)
      .where(eq(childWatches.childSessionId, id))
      .limit(1);
    if (watch.length > 0) {
      return c.json(
        { error: "a child session follows its parent and cannot be moved." },
        400,
      );
    }
    if (typeof body.teamId === "string") {
      if (!(await isTeamMember(db, body.teamId, userId))) {
        return c.json({ error: "team not found" }, 404);
      }
      nextOwner = { type: "team", id: body.teamId };
    } else {
      nextOwner = { type: "user", id: userId };
    }
    // An unchanged owner is not a change — no eviction, no mid-turn refusal.
    if (nextOwner.type === row.ownerType && nextOwner.id === row.ownerId) {
      nextOwner = undefined;
    }
  }
  // One busy gate for both mutation kinds: a profile change replaces the
  // sandbox, an owner move evicts the cached engine session (skills and
  // credential context bind to the owner at build) — neither may land under
  // a running turn.
  if (nextProfile !== undefined || nextOwner !== undefined) {
    const busy = await engineStore.listUnsettledSubmissions(id);
    if (busy.length > 0) {
      return c.json(
        { error: "a turn is running. Wait for it to finish, then retry the change." },
        409,
      );
    }
  }

  // Materialize the engine session only when the model changes. A rename
  // must not start a sandbox — the header renames hibernated sessions too.
  let model: string | undefined;
  if (wantsModel && typeof body.model === "string") {
    const engineSession = await engineHost.sessionFor(id, await loadSessionMeta(db, row));
    try {
      await engineSession.setModel(body.model);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    model = engineSession.options.modelSpec ?? engineSession.options.model.id;
  } else if (engineHost.isLive(id)) {
    // Report the model the GET route would report. Same best-effort rule:
    // do not wake a session to read it.
    const engineSession = await engineHost.sessionFor(id, await loadSessionMeta(db, row));
    model = engineSession.options.modelSpec ?? engineSession.options.model.id;
  }

  // A live session froze its profile into `SandboxCreateOpts` when it was
  // built, and the attachment reuses that object on every re-provision. So
  // read whether a sandbox exists BEFORE the cache entry goes away: that
  // answers whether a running container has to be replaced, or whether the
  // next provision picks the new profile up on its own.
  let hadSandbox = false;
  if (nextProfile !== undefined && engineHost.isLive(id)) {
    const live = await engineHost.sessionFor(id, await loadSessionMeta(db, row));
    hadSandbox = live.attachment.current() !== null;
  }

  // The writes land after every validation, so a rejected model never
  // leaves a half-applied patch behind.
  let effectiveRow = row;
  if (nextTitle !== undefined || nextProfile !== undefined || nextOwner !== undefined) {
    const now = Date.now();
    // A personal move also re-stamps `userId`: `canViewSession` and
    // `canAdministerSession` key user-owned rows off that column, so leaving
    // the original creator there would hand the session to somebody who no
    // longer owns it and lock out the mover. A team move leaves it alone —
    // on team rows the column only records the first actor.
    const ownerCols =
      nextOwner !== undefined
        ? {
            ownerType: nextOwner.type,
            ownerId: nextOwner.id,
            ...(nextOwner.type === "user" ? { userId: nextOwner.id } : {}),
          }
        : {};
    await db
      .update(agentSessions)
      .set({
        ...(nextTitle !== undefined ? { title: nextTitle } : {}),
        ...(nextProfile !== undefined ? { profile: nextProfile } : {}),
        ...ownerCols,
        updatedAt: now,
      })
      .where(eq(agentSessions.id, id));
    effectiveRow = {
      ...row,
      ...(nextTitle !== undefined ? { title: nextTitle } : {}),
      ...(nextProfile !== undefined ? { profile: nextProfile } : {}),
      ...ownerCols,
      updatedAt: now,
    };
  }

  // Drop the cached session so the next build reads the new row: the
  // profile is frozen into the sandbox opts, and the owner binds the skills
  // provider and credential context.
  if (nextOwner !== undefined || nextProfile !== undefined) {
    engineHost.evictCache(id);
  }

  if (nextProfile !== undefined) {
    if (hadSandbox) {
      // The old container still runs the old profile. Rebuild from the
      // updated row, then replace the sandbox so the change is live now
      // rather than at some later re-provision.
      const rebuilt = await engineHost.sessionFor(id, await loadSessionMeta(db, effectiveRow));
      // Re-check right before the replacement. A submission admitted while
      // the rebuild ran wins, the same TOCTOU rule `POST /:id/sandbox/replace`
      // applies. The row already carries the new profile, so say so.
      const recheck = await engineStore.listUnsettledSubmissions(id);
      if (recheck.length > 0) {
        return c.json({ error: profileSavedButSandboxFailed("a turn started") }, 409);
      }
      try {
        await rebuilt.attachment.replace();
      } catch (err) {
        return c.json({ error: profileSavedButSandboxFailed((err as Error).message) }, 502);
      }
      if (rebuilt.attachment.state !== "ready") {
        return c.json({ error: profileSavedButSandboxFailed("the new sandbox never became ready") }, 502);
      }
    }
  }

  const [{ n }] = await db
    .select({ n: count() })
    .from(messagesTable)
    .where(eq(messagesTable.sessionId, id));
  const unsettled = await engineStore.listUnsettledSubmissions(id);
  const detail: GetSessionResponse = {
    ...rowToSummary(effectiveRow, deriveRunFields(runStateRow(effectiveRow), unsettled)),
    messageCount: Number(n ?? 0),
    model,
    profile: effectiveRow.profile,
    docker: effectiveRow.docker,
  };
  return c.json(detail);
});

// ── Auto-title ────────────────────────────────────────────────────────────

/**
 * Generate + persist a title for this session (and optionally a thread)
 * from the opening messages. Fires from the client after the first
 * assistant reply settles; idempotent so replaying the trigger is safe.
 * Returns 200 with `{ sessionTitle, threadTitle }` even in the "nothing to
 * do" cases (`already_titled`, `no_messages`) — the client just treats
 * null title fields as "leave the row alone".
 */
sessionsRouter.post("/:id/auto-title", async (c) => {
  const { db, engineHost } = c.var.providers;
  const id = c.req.param("id");
  const userId = c.var.user.id;

  const url = new URL(c.req.url);
  const threadId = url.searchParams.get("threadId") ?? undefined;

  // The persistent `messages` table isn't the source of truth today — the
  // engine owns entries. Route the loader through the same engine session
  // the messages GET endpoint uses so we see what the UI sees.
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, id)).limit(1);
  const sessionRow = rows[0];
  // Session-not-found is handled inside `autoTitle` too, but bail early
  // here so we don't pay the cost of a sessionFor call on a bad id.
  if (!sessionRow) return c.json({ error: "session not found" }, 404);
  // Titling a thread is part of prompting, not administering — anyone who
  // can read and reply may title what they said. Gating this on ownership
  // left a team member's threads permanently untitled.
  if (!(await canViewSession(db, sessionRow, userId))) {
    return c.json({ error: "session not found" }, 404);
  }

  const engineSession = await engineHost.sessionFor(id, await loadSessionMeta(db, sessionRow));
  const defaultThread = await engineSession.ensureDefaultThread();

  const result = await autoTitle(
    {
      db,
      loadMessages: async (_sid, tid) => {
        const thread = tid ? engineSession.threadById(tid) ?? defaultThread : defaultThread;
        const entries = await thread.readEntries({ limit: 4 });
        const out: { role: string; content: string }[] = [];
        for (const e of entries) {
          if (e.type !== "message") continue;
          if (e.role !== "user" && e.role !== "assistant") continue;
          out.push({ role: e.role, content: e.content ?? "" });
        }
        return out;
      },
    },
    { sessionId: id, threadId },
  );
  if (!result.ok) {
    if (result.reason === "session_not_found") return c.json({ error: "session not found" }, 404);
    // already_titled / no_messages → 200 with nulls; client no-ops.
    return c.json({ sessionTitle: null, threadTitle: null });
  }
  return c.json({ sessionTitle: result.sessionTitle, threadTitle: result.threadTitle });
});

// ── Sandbox JWT ───────────────────────────────────────────────────────────

// Mints a short-lived service JWT the session's sandbox uses to call back
// into the API (Task 8, auth-v2 plan). Owner-gated like every other
// `/api/sessions/:id` route — unknown or not-owned ids 404.
sessionsRouter.post("/:id/sandbox-jwt", async (c) => {
  const { db, engineHost } = c.var.providers;
  const id = c.req.param("id");
  const userId = c.var.user.id;

  const rows = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.id, id), eq(agentSessions.userId, userId)))
    .limit(1);
  const row = rows[0];
  if (!row) return c.json({ error: "session not found" }, 404);

  const { token, expiresAt } = engineHost.mintSandboxJwtFor(id, userId);
  const body: SandboxJwtResponse = { token, expiresAt };
  return c.json(body);
});

// ── Pause (manual hibernation) ───────────────────────────────────────────

// Sandbox hibernation plan, Task 4: suspends the session's sandbox on
// demand (as opposed to the idle sweep's automatic suspend) and stamps the
// row `"hibernated"`. Administer-gated (`canAdministerSession`) — unknown
// ids, and ids the caller may not administer, both 404. Refuses (409) when
// a turn is running/gated (nothing to safely suspend mid-turn) or when the
// sandbox provider doesn't support hibernation at all. There is no explicit
// resume route (spec decision 4) — the next submission, a gateway touch, or
// a future wake all resume it and clear the status back to `"active"`
// (`EngineHost`'s `onWake`/`onSessionReady` hooks, wired in
// `providers/node.ts` and `integration/_setup.ts`).
sessionsRouter.post("/:id/pause", async (c) => {
  const { db, engineHost, engineStore, sandboxProvider } = c.var.providers;
  const id = c.req.param("id");
  const userId = c.var.user.id;

  // Status guard #1: the lookup itself requires `active` — an
  // archived/deleted session 404s exactly like a missing one, rather than
  // passing the authorization check and getting resurrected by the status
  // write below (`listStandaloneSessions` treats `hibernated` as visible).
  // Ownership is NOT in this query: `canAdministerSession` answers it in
  // application code, because a team-owned session's `user_id` names the
  // member who opened it first, not the members who may pause it.
  const rows = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.id, id), eq(agentSessions.status, "active")))
    .limit(1);
  const row = rows[0];
  if (!row || !(await canAdministerSession(db, row, userId))) return c.json({ error: "session not found" }, 404);

  if (!sandboxProvider.capabilities().hibernation) {
    return c.json({ error: "provider does not support hibernation" }, 409);
  }

  // ANY unsettled submission blocks — not just running/gated — matching the
  // idle sweep's own (stricter) `listUnsettledSubmissions.length > 0` check
  // in `maybeSuspendIdleSession` (`EngineHost`). A merely-queued item would
  // otherwise get orphaned by a pause that suspends the sandbox out from
  // under it before it's ever claimed.
  const unsettled = await engineStore.listUnsettledSubmissions(id);
  if (unsettled.length > 0) {
    return c.json({ error: "a turn is running" }, 409);
  }

  const session = await engineHost.sessionFor(id, await loadSessionMeta(db, row));
  await session.attachment.suspend();

  // `suspend()` silently no-ops unless the attachment was `ready` — only
  // stamp the row `hibernated` when it actually transitioned, so a pause hit
  // mid-provision doesn't lie about having suspended anything.
  if (session.attachment.state !== "suspended") {
    return c.json({ error: "sandbox is not ready to pause" }, 409);
  }

  // Status guard #2: conditioned `WHERE status='active'` (shared with the
  // engine's own hibernation hook — see `writeHibernated`) so a concurrent
  // archive/delete between the lookup above and this write still can't be
  // resurrected.
  await writeHibernated(db, id);

  const body: PauseSessionResponse = { status: "hibernated" };
  return c.json(body, 200);
});

// ── Replace sandbox ───────────────────────────────────────────────────────

/** POST /:id/sandbox/replace — tear down the session's sandbox and
 * re-provision a fresh one. Threads and history are untouched; prep steps
 * re-apply on the new sandbox. Same busy rule as pause: ANY unsettled
 * submission blocks, so a queued turn is never orphaned mid-replace. */
sessionsRouter.post("/:id/sandbox/replace", async (c) => {
  const { db, engineHost, engineStore } = c.var.providers;
  const id = c.req.param("id");
  const userId = c.var.user.id;

  const rows = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.id, id), eq(agentSessions.userId, userId), eq(agentSessions.status, "active")))
    .limit(1);
  const row = rows[0];
  if (!row) return c.json({ error: "session not found" }, 404);

  const unsettled = await engineStore.listUnsettledSubmissions(id);
  if (unsettled.length > 0) {
    return c.json({ error: "a turn is running. Wait for it to finish, then retry." }, 409);
  }

  const session = await engineHost.sessionFor(id, await loadSessionMeta(db, row));

  // Re-check immediately before replacing — a submission admitted while
  // sessionFor built the session wins (same TOCTOU rule as the idle
  // sweep's re-check before suspend).
  const recheck = await engineStore.listUnsettledSubmissions(id);
  if (recheck.length > 0) {
    return c.json({ error: "a turn is running. Wait for it to finish, then retry." }, 409);
  }

  try {
    await session.attachment.replace();
  } catch (err) {
    return c.json({ error: (err as Error).message }, 409);
  }

  // `replace()` resolves once the re-provision settles, but a provision
  // that fails lands in `error` state without throwing — don't report ok
  // for a sandbox that never came up.
  if (session.attachment.state !== "ready") {
    return c.json(
      { error: "sandbox replacement failed to provision. Check the sandbox backend, then retry." },
      502,
    );
  }

  return c.json({ ok: true }, 200);
});

// ── Delete ────────────────────────────────────────────────────────────────

// Administer-gated (`canAdministerSession`): a team-owned session is
// deleted by the team's admins, not by whichever member opened it first.
// Unknown ids, and ids the caller may not administer, both 404.
sessionsRouter.delete("/:id", async (c) => {
  const { db, engineHost } = c.var.providers;
  const id = c.req.param("id");
  const userId = c.var.user.id;

  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, id)).limit(1);
  const row = rows[0];
  if (!row || !(await canAdministerSession(db, row, userId))) return c.json({ error: "session not found" }, 404);

  // Tear down engine + sandbox first; even if it fails we still want to soft-delete.
  await engineHost.destroy(id).catch((err) => {
    console.error(`engineHost.destroy(${id}) failed:`, err);
  });

  await db
    .update(agentSessions)
    .set({ status: "deleted", updatedAt: Date.now() })
    .where(eq(agentSessions.id, id));

  return c.json({ ok: true });
});
