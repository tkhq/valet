import { getModel, type Model } from "@mariozechner/pi-ai";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Engine,
  orchestratorSessionId,
  parseOrchestratorSessionId,
  type BlobStore,
  type ChildSpawner,
  type CredentialStore,
  type EventStream,
  type Principal,
  type SandboxProvider,
  type Session,
  type SessionData,
  type SessionStore,
} from "@valet/engine";
import type { ValetPlugin } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { orchestratorIdentities, users } from "../schema/index.js";
import { internalToken } from "../lib/internal-auth.js";
import {
  deriveSandboxJwtSecret,
  mintSandboxToken,
  mintSandboxJwt,
  revokeSandboxTokens,
} from "../auth/sandbox-tokens.js";
import { orchestratorPersona } from "../orchestrator/persona.js";
import { buildMemoryTools } from "../orchestrator/memory-tools.js";
import { assembleMemorySnapshot } from "../orchestrator/snapshot.js";
import { ensureTodayJournal } from "../orchestrator/bootstrap.js";
import { journalCompactionHook } from "../orchestrator/compaction.js";
import { readOwnFile, type MemoryScope } from "../services/memory.js";
import { pluginSessionExtras } from "../plugins/assemble.js";

/** Personality is capped at injection time (assistant-centered web UI
 * decision 5), independent of any cap the memory service itself applies. */
const PERSONALITY_INJECT_CAP = 500;

export interface EngineHostOpts {
  engineStore: SessionStore;
  sandboxProvider: SandboxProvider;
  eventStream: EventStream;
  engineCredentials: CredentialStore;
  blobs?: BlobStore;
  /** Anthropic API key required for prompts. Without it, prompts fail. */
  anthropicApiKey?: string;
  /** pi-ai model id; defaults to claude-haiku-4-5 for fast dogfooding. */
  defaultModelId?: string;
  /** Default Docker image for new sandboxes. */
  defaultImage?: string;
  /**
   * The app db handle — required by `orchestratorSessionFor` (memory
   * snapshot assembly, journal bootstrap, the compaction hook, and the
   * `orchestrator_identities` upsert). Every session builder also uses it
   * (when present) to mint/revoke the session's sandbox token (Task 8,
   * auth-v2 plan) — absent only in tests that don't wire one up, which
   * degrade gracefully to no sandbox env injection.
   */
  db?: AppDb;
  /**
   * This process's own base URL (e.g. `http://127.0.0.1:${port}`), handed
   * to orchestrator sessions as `toolConfig.apiBaseUrl` so the `mem_*`
   * tools can reach the memory HTTP routes (decision 15). Required for
   * `orchestratorSessionFor`.
   */
  apiBaseUrl?: string;
  /**
   * Master key `deriveSandboxJwtSecret`/`mintSandboxJwt` derive per-session
   * secrets from (Task 8, auth-v2 plan). `AuthConfig.sandboxJwtMaster` when
   * real auth is configured; falls back to `internalToken()` in stub mode
   * so dev keeps working without `BETTER_AUTH_SECRET`.
   */
  sandboxJwtMaster?: string;
  /**
   * The API's own externally-reachable base URL, injected into every
   * sandbox's env as `VALET_API_URL` (Task 8, auth-v2 plan) —
   * `AuthConfig.baseUrl` when configured, else the local dev default. NOT
   * the same as `apiBaseUrl` above, which is this process's own
   * `http://127.0.0.1:{port}` used for internal orchestrator tool calls.
   */
  sandboxApiUrl?: string;
  /**
   * Injected into every orchestrator session's `toolConfig.childSpawner`
   * (Phase 4 decision 10/17). Absent in tests that don't need `task` to
   * work; regular (non-orchestrator) sessions never receive it — only
   * orchestrators spawn children, and children themselves never do
   * (depth limit 1, decision 10) since `childSessionFor` never sets it.
   */
  childSpawner?: ChildSpawner;
  /**
   * Assembled plugin set (plugin-system-v2 Task 4's `assemblePlugins`
   * output). Every session builder calls `pluginSessionExtras(plugins)`
   * FRESH — see the call sites below — never cached on the host instance.
   */
  plugins?: ValetPlugin[];
}

export interface SessionMeta {
  userId: string;
  orgId: string;
  workspace: string;
}

interface CacheEntry {
  engine: Engine;
  session: Session;
}

/** Durable events for submissions settled longer ago than this are pruned on restore. */
const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const SYSTEM_PROMPT =
  "You are a helpful coding assistant running inside a Docker sandbox. " +
  "Your workspace is /workspace (the only mounted directory). " +
  "All read/write/edit/bash tools operate against /workspace — use absolute " +
  "paths under /workspace or relative paths (which resolve there). " +
  "You have built-in tools: read, write, edit, bash, thread_read. Be concise.";

/**
 * Per-process cache of live `Engine`/`Session` pairs keyed by app session id.
 * One Engine instance per session keeps the engine's internal lifecycle
 * simple. Calling `sessionFor` multiple times for the same id returns the
 * same Session.
 */
export class EngineHost {
  private cache = new Map<string, CacheEntry>();
  /**
   * Single-flight gate for `sessionFor`. Two concurrent requests for the
   * same fresh session id used to each create their own Engine + Session
   * and each call `ensureDefaultThread`, which persisted two distinct
   * `web:default` thread rows into the store. Subsequent rehydrations
   * loaded both, breaking thread identity (DB had duplicates with the
   * same key). De-duping in-flight calls collapses the race.
   */
  private inflight = new Map<string, Promise<Session>>();

  constructor(private readonly opts: EngineHostOpts) {}

  /**
   * Resolve (or lazily create) the Session for an app session id. If the
   * engine store already has a row for this id, restore it. Otherwise create
   * a new engine session and persist it via the store.
   */
  async sessionFor(sessionId: string, meta: SessionMeta): Promise<Session> {
    // Orchestrator ids must always wake through `orchestratorSessionFor` so
    // they get persona/memory-snapshot/mem_* tools/queueMode reconstructed
    // from configuration, never the generic `buildSession` path. Every
    // caller of `sessionFor` (messages.ts, ws.ts, sessions.ts, boot
    // restore) can be handed an orchestrator session id, so this dispatch
    // lives here rather than being duplicated at each call site. Delegating
    // before touching `this.cache`/`this.inflight` is deliberate:
    // `orchestratorSessionFor` does its own cache/inflight bookkeeping
    // against the *same* maps (keyed by the same `sessionId`), so checking
    // here first would just be a redundant, and potentially stale, read.
    const principal = parseOrchestratorSessionId(sessionId);
    if (principal) {
      return this.orchestratorSessionFor(principal, { actorUserId: meta.userId, orgId: meta.orgId });
    }

    const cached = this.cache.get(sessionId);
    if (cached) return cached.session;
    const pending = this.inflight.get(sessionId);
    if (pending) return pending;

    const promise = this.buildSession(sessionId, meta).finally(() => {
      this.inflight.delete(sessionId);
    });
    this.inflight.set(sessionId, promise);
    return promise;
  }

  private async buildSession(sessionId: string, meta: SessionMeta): Promise<Session> {
    // Built FRESH per session build, never cached on the host: the plugin
    // catalog's dynamic-action-resolution cache lives on the `Catalog`
    // instance `pluginCatalogTools` returns, so it must stay scoped to this
    // one session's credential context — a shared/cached catalog would leak
    // one user's resolved tool list into every other session.
    const extras = pluginSessionExtras(this.opts.plugins ?? []);

    const engine = new Engine({
      providers: {
        store: this.opts.engineStore,
        stream: this.opts.eventStream,
        credentials: this.opts.engineCredentials,
        sandboxProvider: this.opts.sandboxProvider,
        blobs: this.opts.blobs,
      },
    });

    const existing = await this.opts.engineStore.getSession(sessionId);
    const model = await this.resolveModelForBuild(existing, meta.userId);
    const sandboxEnv = this.mintSandboxEnv(sessionId, meta.userId, meta.orgId);
    const session = existing
      ? await engine.restoreSession({
          sessionId,
          options: {
            userId: meta.userId,
            orgId: meta.orgId,
            workspace: meta.workspace,
            sandbox: { workspace: meta.workspace, image: this.opts.defaultImage, env: sandboxEnv },
            model,
            systemPrompt: SYSTEM_PROMPT,
            tools: extras.tools.length ? extras.tools : undefined,
            skills: extras.skills.length ? extras.skills : undefined,
            roles: extras.roles.length ? extras.roles : undefined,
          },
        })
      : await engine.createSession({
          id: sessionId,
          userId: meta.userId,
          orgId: meta.orgId,
          workspace: meta.workspace,
          sandbox: { workspace: meta.workspace, image: this.opts.defaultImage, env: sandboxEnv },
          model,
          systemPrompt: SYSTEM_PROMPT,
          tools: extras.tools.length ? extras.tools : undefined,
          skills: extras.skills.length ? extras.skills : undefined,
          roles: extras.roles.length ? extras.roles : undefined,
        });

    this.cache.set(sessionId, { engine, session });
    // Retention: after a successful restore of an existing session, prune
    // durable events for submissions that settled outside the retention
    // window. Fire-and-forget — never block or fail the restore.
    if (existing) this.pruneExpiredEvents(sessionId);
    return session;
  }

  /**
   * Master key `deriveSandboxJwtSecret`/`mintSandboxJwt` derive per-session
   * secrets from (Task 8, auth-v2 plan): `opts.sandboxJwtMaster` (from
   * `AuthConfig.sandboxJwtMaster`) when real auth is configured, else
   * `internalToken()` so stub-only dev keeps working.
   */
  private resolveSandboxJwtMaster(): string {
    return this.opts.sandboxJwtMaster ?? internalToken();
  }

  /**
   * Mints a fresh long-lived sandbox bearer token (revoking any prior live
   * one for this session — `mintSandboxToken`'s own contract) and derives
   * this session's JWT secret, returning the three env vars every sandbox
   * gets at provision time: `VALET_SANDBOX_TOKEN`, `VALET_API_URL`,
   * `VALET_SANDBOX_JWT_SECRET` (Task 8, auth-v2 plan). Called once per
   * session BUILD (create or restore) — not per sandbox re-provision within
   * a build's lifetime, since the `SandboxCreateOpts` object handed to
   * `engine.createSession`/`restoreSession` is captured once and reused by
   * the attachment for every (re-)provision until the next build.
   *
   * Returns `undefined` when `opts.db` is absent (tests that don't wire a
   * db up) — sandboxes then provision with no extra env, same as before
   * this wiring existed.
   */
  private mintSandboxEnv(sessionId: string, userId: string, orgId: string): Record<string, string> | undefined {
    if (!this.opts.db) return undefined;
    const { token } = mintSandboxToken(this.opts.db, { sessionId, userId, orgId });
    const secret = deriveSandboxJwtSecret(this.resolveSandboxJwtMaster(), sessionId);
    return {
      VALET_SANDBOX_TOKEN: token,
      VALET_API_URL: this.opts.sandboxApiUrl ?? "http://localhost:8788",
      VALET_SANDBOX_JWT_SECRET: secret,
    };
  }

  /**
   * Mints a short-lived service JWT (`{ sub: userId, sid: sessionId }`) for
   * `POST /api/sessions/:id/sandbox-jwt` (Task 8, auth-v2 plan) — the same
   * master/derivation the sandbox's own `VALET_SANDBOX_JWT_SECRET` uses, so
   * a route-minted JWT and a sandbox-minted one verify against the same
   * secret.
   */
  mintSandboxJwtFor(sessionId: string, userId: string, ttlMs?: number): { token: string; expiresAt: number } {
    return mintSandboxJwt(this.resolveSandboxJwtMaster(), { sessionId, userId, ttlMs });
  }

  /**
   * Fire-and-forget prune of durable events belonging to submissions that
   * settled before the retention cutoff. Errors are logged, never thrown.
   */
  private pruneExpiredEvents(sessionId: string): void {
    const cutoff = Date.now() - EVENT_RETENTION_MS;
    void (async () => {
      try {
        const settled = await this.opts.engineStore.listSettledSubmissionsBefore(sessionId, cutoff);
        const ids = settled.map((i) => i.id);
        if (ids.length > 0) await this.opts.eventStream.prune(sessionId, ids);
      } catch (err) {
        console.error(`event retention prune failed for session ${sessionId}:`, err);
      }
    })();
  }

  /**
   * Resolve (or lazily create) the well-known orchestrator session for
   * `principal` (Phase 4 decision 17). Wakes instantly and sandbox-less: the
   * sandbox is a `SandboxCreateOpts` template, never a pre-created/warm
   * sandbox — cold attachment is the orchestrator's steady state.
   *
   * `CreateSessionOptions` is reconstructed from configuration on every
   * wake (persona, memory snapshot, tools, toolConfig), not from whatever
   * was persisted at creation time, per the orchestrator spec's "instant
   * wake" section — so a restored session gets a freshly-assembled snapshot
   * and today's journal, same as a brand-new one.
   */
  async orchestratorSessionFor(principal: Principal, meta: { actorUserId: string; orgId: string }): Promise<Session> {
    const sessionId = orchestratorSessionId(principal);
    const cached = this.cache.get(sessionId);
    if (cached) return cached.session;
    const pending = this.inflight.get(sessionId);
    if (pending) return pending;

    const promise = this.buildOrchestratorSession(sessionId, principal, meta).finally(() => {
      this.inflight.delete(sessionId);
    });
    this.inflight.set(sessionId, promise);
    return promise;
  }

  private async buildOrchestratorSession(
    sessionId: string,
    principal: Principal,
    meta: { actorUserId: string; orgId: string },
  ): Promise<Session> {
    if (!this.opts.db) {
      throw new Error("EngineHost: orchestratorSessionFor requires opts.db");
    }
    if (!this.opts.apiBaseUrl) {
      throw new Error("EngineHost: orchestratorSessionFor requires opts.apiBaseUrl");
    }
    const db = this.opts.db;
    const apiBaseUrl = this.opts.apiBaseUrl;

    const workspace = join(homedir(), ".valet", "orchestrator", `${principal.type}-${principal.id}`);
    await mkdir(workspace, { recursive: true });

    const scope: MemoryScope = { owner: principal, actorUserId: meta.actorUserId };
    await ensureTodayJournal(db, scope);
    const snapshotContent = await assembleMemorySnapshot(db, scope);
    const personaPrefix = await this.resolvePersonaPrefix(db, scope, meta.orgId, principal);

    const existing = await this.opts.engineStore.getSession(sessionId);
    const model = await this.resolveModelForBuild(existing, meta.actorUserId);
    const queueMode: "steer" | "followup" = principal.type === "user" ? "steer" : "followup";
    // Built FRESH per session build, never cached on the host — see the
    // comment on `EngineHostOpts.plugins` and `buildSession`'s call site.
    const extras = pluginSessionExtras(this.opts.plugins ?? []);

    const sandboxEnv = this.mintSandboxEnv(sessionId, meta.actorUserId, meta.orgId);
    const sessionOptions = {
      userId: meta.actorUserId,
      orgId: meta.orgId,
      workspace,
      purpose: "orchestrator" as const,
      owner: principal,
      queueMode,
      sandbox: { workspace, image: this.opts.defaultImage, env: sandboxEnv },
      model,
      systemPrompt: personaPrefix + orchestratorPersona(principal),
      tools: [...buildMemoryTools(), ...extras.tools],
      skills: extras.skills.length ? extras.skills : undefined,
      roles: extras.roles.length ? extras.roles : undefined,
      toolConfig: {
        apiBaseUrl,
        internalToken: internalToken(),
        ...(this.opts.childSpawner ? { childSpawner: this.opts.childSpawner } : {}),
      },
      // Assembled once, here, at wake time — not per-turn. This snapshot is
      // frozen for the cached session's lifetime; the only way to see a
      // fresher snapshot is a cache eviction (session destroy/restart),
      // which forces the next `orchestratorSessionFor` call back through
      // this method to reassemble it.
      systemContext: [{ name: "memory-snapshot", content: snapshotContent, order: 10 }],
      compactionHooks: [journalCompactionHook(db, scope)],
      // Orchestrator sessions are sandbox-less by default (orchestrator
      // spec, "Sandbox-less by default"): the sandbox must provision only
      // when a turn actually touches the filesystem, via the lazy
      // PolicySandbox attachment's first-touch contract — never a
      // proactive warm-on-claim kick just because a turn was claimed.
      warmSandboxOnClaim: false,
    };

    const engine = new Engine({
      providers: {
        store: this.opts.engineStore,
        stream: this.opts.eventStream,
        credentials: this.opts.engineCredentials,
        sandboxProvider: this.opts.sandboxProvider,
        blobs: this.opts.blobs,
      },
    });

    const session = existing
      ? await engine.restoreSession({ sessionId, options: sessionOptions })
      : await engine.createSession({ id: sessionId, ...sessionOptions });

    this.cache.set(sessionId, { engine, session });
    if (existing) this.pruneExpiredEvents(sessionId);

    await this.ensureOrchestratorIdentity(db, principal, meta.orgId, sessionId);

    return session;
  }

  /** Upserts the `orchestrator_identities` row on first creation of a
   * principal's orchestrator (decision 17/20) — a no-op past the first
   * successful wake since the unique index on (org, ownerType, ownerId)
   * never changes for a durable, never-rotated orchestrator identity.
   *
   * Concurrent first-ensure calls (e.g. two tabs waking the same
   * orchestrator simultaneously) can both see `existing` as undefined and
   * both attempt the insert — `onConflictDoNothing` on the unique index
   * makes the loser's insert a no-op instead of an uncaught unique-constraint
   * throw that would 500 the request. */
  private async ensureOrchestratorIdentity(
    db: AppDb,
    principal: Principal,
    orgId: string,
    sessionId: string,
  ): Promise<void> {
    const existing = await db
      .select()
      .from(orchestratorIdentities)
      .where(
        and(
          eq(orchestratorIdentities.orgId, orgId),
          eq(orchestratorIdentities.ownerType, principal.type),
          eq(orchestratorIdentities.ownerId, principal.id),
        ),
      )
      .get();
    if (existing) return;

    await db
      .insert(orchestratorIdentities)
      .values({
        id: randomUUID(),
        orgId,
        ownerType: principal.type,
        ownerId: principal.id,
        sessionId,
        createdAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();
  }

  /**
   * `You are {name}. {personality}` prefix for the orchestrator's
   * `systemPrompt` (assistant-centered web UI decision 5): `name` from
   * `orchestrator_identities.handle`, `personality` from the
   * `assistant/personality.md` memory file, capped at
   * `PERSONALITY_INJECT_CAP` chars. Absent name → `""` (neutral persona,
   * unchanged) regardless of whether a personality file exists — the
   * identity step always sets name first, so an orphaned personality file
   * without a name shouldn't happen, but if it ever does we don't want a
   * prefix with no name in it.
   */
  private async resolvePersonaPrefix(
    db: AppDb,
    scope: MemoryScope,
    orgId: string,
    principal: Principal,
  ): Promise<string> {
    const identity = await db
      .select()
      .from(orchestratorIdentities)
      .where(
        and(
          eq(orchestratorIdentities.orgId, orgId),
          eq(orchestratorIdentities.ownerType, principal.type),
          eq(orchestratorIdentities.ownerId, principal.id),
        ),
      )
      .get();
    const name = identity?.handle;
    if (!name) return "";

    // Own-scope only (never a team member's file — `readOwnFile` bypasses
    // `readFile`'s team read-union entirely): the persona prefix is
    // per-user, so a team `assistant/personality.md` must never substitute
    // for the caller's own (missing) one.
    const row = await readOwnFile(db, scope, "assistant/personality.md");
    const personality = row ? row.content.slice(0, PERSONALITY_INJECT_CAP) : "";

    const sentence = personality ? `You are ${name}. ${personality}` : `You are ${name}.`;
    return `${sentence}\n\n`;
  }

  /** The shared per-process EventStream. Engine sessions and WS handlers fan out through this one instance. */
  eventStream(): EventStream {
    return this.opts.eventStream;
  }

  /**
   * Tear down a single session: destroy engine + sandbox, drop the cache
   * entry, and revoke the session's live sandbox tokens (Task 8, auth-v2
   * plan) — a stopped session's sandbox must not be able to keep calling
   * back into the API with a token minted for a build that no longer
   * exists.
   */
  async destroy(sessionId: string): Promise<void> {
    const entry = this.cache.get(sessionId);
    if (!entry) return;
    try {
      await entry.session.destroy();
    } finally {
      this.cache.delete(sessionId);
      if (this.opts.db) revokeSandboxTokens(this.opts.db, sessionId);
    }
  }

  /**
   * Drop a session's in-process cache entry WITHOUT tearing down engine
   * state — unlike `destroy()`, this never calls `session.destroy()` (which
   * deletes the underlying engine session row via
   * `SessionStore.deleteSession`). Used when an identity/persona change
   * needs picking up on the next wake (PATCH /api/orchestrator/info,
   * decision 4/5): the next `orchestratorSessionFor` call misses the cache
   * and rebuilds `systemPrompt`/`systemContext` from current configuration,
   * restoring the same durable session (same transcript) rather than
   * creating a new one. Safe to call on an id that isn't cached — no-op.
   *
   * Calls `session.suspendTimers()` before dropping the cache entry: the
   * evicted `Session` would otherwise be rooted forever by its two
   * unref'd intervals (heartbeat 10s, sweep 5s — each interval closure
   * captures `this`), permanently leaking the object and continuing to
   * sweep/heartbeat against the store even though nothing references it
   * through the cache anymore. `unref()` only keeps the *process* from
   * staying alive on these timers; it does nothing to stop them from
   * keeping this *object* alive or from continuing to fire. Suspending
   * them first means the evicted instance is a normal orphan, collected
   * once its last reference (this method's local `entry`) goes away.
   */
  evictCache(sessionId: string): void {
    this.cache.get(sessionId)?.session.suspendTimers();
    this.cache.delete(sessionId);
  }

  /**
   * Evict every cached session WITHOUT touching durable state — the
   * process-shutdown path. `Session.destroy()` calls
   * `store.deleteSession()`, so a shutdown that "destroys" live sessions
   * erases their threads/queue items/history; kill-mid-turn recovery
   * (reconciliation on next boot) is the designed restart story, and it
   * needs those rows. Sandboxes are left as-is — the workspace survives,
   * the sandbox is disposable (Phase 3), and the next boot re-attaches or
   * re-provisions.
   */
  evictAll(): void {
    for (const id of [...this.cache.keys()]) this.evictCache(id);
  }

  /**
   * Tear down every live session INCLUDING their durable rows
   * (`store.deleteSession`). NOT for shutdown handlers — that's
   * `evictAll()`. Kept for tests and true delete-everything flows.
   */
  async destroyAll(): Promise<void> {
    const ids = [...this.cache.keys()];
    await Promise.allSettled(ids.map((id) => this.destroy(id)));
  }

  /** True if a session is currently cached in this process. */
  isLive(sessionId: string): boolean {
    return this.cache.has(sessionId);
  }

  /**
   * The live in-memory Session for an id, or null if not cached. Unlike
   * `sessionFor`, this never builds/restores — callers use it to act on a
   * session's in-process state (GateManager waiters, running items) that only
   * exists while the session is live.
   */
  liveSession(sessionId: string): Session | null {
    return this.cache.get(sessionId)?.session ?? null;
  }

  private resolveModel(overrideId?: string): Model<any> {
    const id = overrideId ?? this.opts.defaultModelId ?? "claude-haiku-4-5";
    // pi-ai's getModel is typed against its compile-time MODELS table; we
    // accept user-configurable ids and cast at the boundary. The engine
    // accepts Model<any> so the api-level type stays open.
    const model = getModel("anthropic", id as "claude-haiku-4-5");
    if (!model) {
      throw new Error(
        `EngineHost: unknown anthropic model "${id}" — check pi-ai MODELS or VALET_MODEL env`,
      );
    }
    return model;
  }

  /**
   * `users.default_model` for `userId`, or `undefined` if unset or the host
   * has no `db` (only `orchestratorSessionFor` requires `db`; the other
   * builders degrade gracefully to the hardcoded default when it's absent,
   * e.g. in tests that don't wire one up). Deliberately uncached — split-
   * settings decision 9 requires a settings change to apply on the very next
   * session build, not after some TTL.
   */
  private async userDefaultModel(userId: string): Promise<string | undefined> {
    if (!this.opts.db) return undefined;
    const row = await this.opts.db
      .select({ defaultModel: users.defaultModel })
      .from(users)
      .where(eq(users.id, userId))
      .get();
    return row?.defaultModel ?? undefined;
  }

  /**
   * Resolve the `Model` to build/restore a session with. Spec-pinned
   * restore-no-clobber constraint: `Session.rehydrate`
   * (`packages/engine/src/session.ts`) always takes `options.model` as
   * handed to it by the caller — it never falls back to the persisted
   * `SessionData.model` on its own. That means if the host passed a fresh
   * "current user default" on every restore, an explicit per-session
   * `session.setModel(...)` override would get silently clobbered the next
   * time the session's cache entry is evicted and rebuilt (e.g.
   * `evictAll()` on shutdown, or an idle sweep). So on restore
   * (`existing` present), the *persisted* model always wins over both
   * `overrideId` and the user default — that persisted value already
   * reflects whatever `setModel` (or the original create-time model) set.
   * Only on create does `overrideId ?? userDefault ?? hardcoded-default`
   * apply.
   */
  private async resolveModelForBuild(
    existing: SessionData | null,
    userId: string,
    overrideId?: string,
  ): Promise<Model<any>> {
    if (existing?.model) return this.resolveModel(existing.model);
    const id = overrideId ?? (await this.userDefaultModel(userId));
    return this.resolveModel(id);
  }

  /**
   * Resolve (or lazily create) a child session (Phase 4 decision 10/11).
   * Purpose 'child', linked to its parent via `parentSessionId`/
   * `parentThreadId`. Deliberately gets NO `toolConfig.childSpawner` — the
   * `task` tool's absence-of-spawner contract is the engine's depth limit
   * (children can't spawn grandchildren).
   */
  async childSessionFor(
    childSessionId: string,
    opts: {
      parentSessionId: string;
      parentThreadId: string;
      actorUserId: string;
      orgId: string;
      owner: Principal;
      workspace: string;
      modelId?: string;
    },
  ): Promise<Session> {
    const cached = this.cache.get(childSessionId);
    if (cached) return cached.session;
    const pending = this.inflight.get(childSessionId);
    if (pending) return pending;

    const promise = this.buildChildSession(childSessionId, opts).finally(() => {
      this.inflight.delete(childSessionId);
    });
    this.inflight.set(childSessionId, promise);
    return promise;
  }

  private async buildChildSession(
    childSessionId: string,
    opts: {
      parentSessionId: string;
      parentThreadId: string;
      actorUserId: string;
      orgId: string;
      owner: Principal;
      workspace: string;
      modelId?: string;
    },
  ): Promise<Session> {
    // Built FRESH per session build, never cached on the host — see the
    // comment on `EngineHostOpts.plugins` and `buildSession`'s call site.
    const extras = pluginSessionExtras(this.opts.plugins ?? []);

    const existing = await this.opts.engineStore.getSession(childSessionId);
    const model = await this.resolveModelForBuild(existing, opts.actorUserId, opts.modelId);

    const sandboxEnv = this.mintSandboxEnv(childSessionId, opts.actorUserId, opts.orgId);
    const sessionOptions = {
      userId: opts.actorUserId,
      orgId: opts.orgId,
      workspace: opts.workspace,
      purpose: "child" as const,
      owner: opts.owner,
      parentSessionId: opts.parentSessionId,
      parentThreadId: opts.parentThreadId,
      sandbox: { workspace: opts.workspace, image: this.opts.defaultImage, env: sandboxEnv },
      model,
      systemPrompt: SYSTEM_PROMPT,
      tools: extras.tools.length ? extras.tools : undefined,
      skills: extras.skills.length ? extras.skills : undefined,
      roles: extras.roles.length ? extras.roles : undefined,
    };

    const engine = new Engine({
      providers: {
        store: this.opts.engineStore,
        stream: this.opts.eventStream,
        credentials: this.opts.engineCredentials,
        sandboxProvider: this.opts.sandboxProvider,
        blobs: this.opts.blobs,
      },
    });

    const session = existing
      ? await engine.restoreSession({ sessionId: childSessionId, options: sessionOptions })
      : await engine.createSession({ id: childSessionId, ...sessionOptions });

    this.cache.set(childSessionId, { engine, session });
    if (existing) this.pruneExpiredEvents(childSessionId);
    return session;
  }

  /**
   * Resolve (or lazily create) a workflow-owned session (Phase 5 plan
   * decision 15) for a `session` node's `wf:{runId}:{nodeId}` id. Mirrors
   * `childSessionFor`/`buildChildSession`: Docker sandbox template, `owner`
   * passed straight through by the caller (the run's principal owner, per
   * `WorkflowRun.owner`), NO `toolConfig.childSpawner` — a workflow session
   * can't spawn children, same depth-limit contract as a child session.
   * Unlike a child session it has no `parentSessionId`/`parentThreadId`
   * (workflow runs aren't a parent/child engine relationship).
   */
  async workflowSessionFor(
    sessionId: string,
    opts: {
      actorUserId: string;
      orgId: string;
      owner: Principal;
      workspace: string;
      title?: string;
      modelId?: string;
    },
  ): Promise<Session> {
    const cached = this.cache.get(sessionId);
    if (cached) return cached.session;
    const pending = this.inflight.get(sessionId);
    if (pending) return pending;

    const promise = this.buildWorkflowSession(sessionId, opts).finally(() => {
      this.inflight.delete(sessionId);
    });
    this.inflight.set(sessionId, promise);
    return promise;
  }

  private async buildWorkflowSession(
    sessionId: string,
    opts: {
      actorUserId: string;
      orgId: string;
      owner: Principal;
      workspace: string;
      title?: string;
      modelId?: string;
    },
  ): Promise<Session> {
    // Built FRESH per session build, never cached on the host — see the
    // comment on `EngineHostOpts.plugins` and `buildSession`'s call site.
    const extras = pluginSessionExtras(this.opts.plugins ?? []);

    const existing = await this.opts.engineStore.getSession(sessionId);
    const model = await this.resolveModelForBuild(existing, opts.actorUserId, opts.modelId);

    const sandboxEnv = this.mintSandboxEnv(sessionId, opts.actorUserId, opts.orgId);
    const sessionOptions = {
      userId: opts.actorUserId,
      orgId: opts.orgId,
      workspace: opts.workspace,
      purpose: "workflow" as const,
      owner: opts.owner,
      sandbox: { workspace: opts.workspace, image: this.opts.defaultImage, env: sandboxEnv },
      model,
      systemPrompt: SYSTEM_PROMPT,
      tools: extras.tools.length ? extras.tools : undefined,
      skills: extras.skills.length ? extras.skills : undefined,
      roles: extras.roles.length ? extras.roles : undefined,
      ...(opts.title ? { metadata: { title: opts.title } } : {}),
    };

    const engine = new Engine({
      providers: {
        store: this.opts.engineStore,
        stream: this.opts.eventStream,
        credentials: this.opts.engineCredentials,
        sandboxProvider: this.opts.sandboxProvider,
        blobs: this.opts.blobs,
      },
    });

    const session = existing
      ? await engine.restoreSession({ sessionId, options: sessionOptions })
      : await engine.createSession({ id: sessionId, ...sessionOptions });

    this.cache.set(sessionId, { engine, session });
    if (existing) this.pruneExpiredEvents(sessionId);
    return session;
  }
}
