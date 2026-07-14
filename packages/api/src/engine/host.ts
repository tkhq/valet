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
  type SessionStore,
} from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { orchestratorIdentities } from "../schema/index.js";
import { internalToken } from "../lib/internal-auth.js";
import { orchestratorPersona } from "../orchestrator/persona.js";
import { buildMemoryTools } from "../orchestrator/memory-tools.js";
import { assembleMemorySnapshot } from "../orchestrator/snapshot.js";
import { ensureTodayJournal } from "../orchestrator/bootstrap.js";
import { journalCompactionHook } from "../orchestrator/compaction.js";
import type { MemoryScope } from "../services/memory.js";

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
   * The app db handle — needed only by `orchestratorSessionFor` (memory
   * snapshot assembly, journal bootstrap, the compaction hook, and the
   * `orchestrator_identities` upsert). Regular `sessionFor` sessions never
   * touch it.
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
   * Injected into every orchestrator session's `toolConfig.childSpawner`
   * (Phase 4 decision 10/17). Absent in tests that don't need `task` to
   * work; regular (non-orchestrator) sessions never receive it — only
   * orchestrators spawn children, and children themselves never do
   * (depth limit 1, decision 10) since `childSessionFor` never sets it.
   */
  childSpawner?: ChildSpawner;
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
    const model = this.resolveModel();

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
    const session = existing
      ? await engine.restoreSession({
          sessionId,
          options: {
            userId: meta.userId,
            orgId: meta.orgId,
            workspace: meta.workspace,
            sandbox: { workspace: meta.workspace, image: this.opts.defaultImage },
            model,
            systemPrompt: SYSTEM_PROMPT,
          },
        })
      : await engine.createSession({
          id: sessionId,
          userId: meta.userId,
          orgId: meta.orgId,
          workspace: meta.workspace,
          sandbox: { workspace: meta.workspace, image: this.opts.defaultImage },
          model,
          systemPrompt: SYSTEM_PROMPT,
        });

    this.cache.set(sessionId, { engine, session });
    // Retention: after a successful restore of an existing session, prune
    // durable events for submissions that settled outside the retention
    // window. Fire-and-forget — never block or fail the restore.
    if (existing) this.pruneExpiredEvents(sessionId);
    return session;
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

    const model = this.resolveModel();
    const queueMode: "steer" | "followup" = principal.type === "user" ? "steer" : "followup";

    const sessionOptions = {
      userId: meta.actorUserId,
      orgId: meta.orgId,
      workspace,
      purpose: "orchestrator" as const,
      owner: principal,
      queueMode,
      sandbox: { workspace, image: this.opts.defaultImage },
      model,
      systemPrompt: orchestratorPersona(principal),
      tools: buildMemoryTools(),
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

    const existing = await this.opts.engineStore.getSession(sessionId);
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

  /** The shared per-process EventStream. Engine sessions and WS handlers fan out through this one instance. */
  eventStream(): EventStream {
    return this.opts.eventStream;
  }

  /** Tear down a single session: destroy engine + sandbox, drop the cache entry. */
  async destroy(sessionId: string): Promise<void> {
    const entry = this.cache.get(sessionId);
    if (!entry) return;
    try {
      await entry.session.destroy();
    } finally {
      this.cache.delete(sessionId);
    }
  }

  /** Tear down every live session. Call from process shutdown handlers. */
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
    const model = this.resolveModel(opts.modelId);

    const sessionOptions = {
      userId: opts.actorUserId,
      orgId: opts.orgId,
      workspace: opts.workspace,
      purpose: "child" as const,
      owner: opts.owner,
      parentSessionId: opts.parentSessionId,
      parentThreadId: opts.parentThreadId,
      sandbox: { workspace: opts.workspace, image: this.opts.defaultImage },
      model,
      systemPrompt: SYSTEM_PROMPT,
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

    const existing = await this.opts.engineStore.getSession(childSessionId);
    const session = existing
      ? await engine.restoreSession({ sessionId: childSessionId, options: sessionOptions })
      : await engine.createSession({ id: childSessionId, ...sessionOptions });

    this.cache.set(childSessionId, { engine, session });
    if (existing) this.pruneExpiredEvents(childSessionId);
    return session;
  }
}
