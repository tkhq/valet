import type { Model } from "@mariozechner/pi-ai";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Engine,
  orchestratorSessionId,
  parseOrchestratorSessionId,
  NoCredentialsError,
  type BlobStore,
  type ChildReader,
  type ChildSpawner,
  type CredentialStore,
  type EventStream,
  type Principal,
  type CredentialOwner,
  type SandboxProvider,
  type Session,
  type SessionData,
  type SessionStartRef,
  type SessionStore,
  type StoredCredential,
  type ResolvedModel,
  type PolicyResolver,
} from "@valet/engine";
import type { ValetPlugin } from "@valet/engine";
import {
  buildPluginCatalog,
  type ActionPlugin,
  type CommandContext,
  type CommandDef,
  type PluginCatalog,
  type Sandbox,
  type SkillSource,
} from "@valet/engine";
import { buildPolicyResolver, revokeSessionGrants } from "../policies/service.js";
import type { RepoBinding } from "../wire/types.js";
import { makeCommandContext, makeWorkspaceSkillsProvider } from "./command-providers.js";
import { GitHubAuthError } from "../services/github-tokens.js";
import { resolveSessionGitHubToken } from "../services/session-github-token.js";
import { resolveSnapshot } from "./resolve-snapshot.js";
import { computeSpec, specHash } from "./sandbox-spec.js";
import { buildPrepSteps } from "./prep-steps.js";
import type { PrebuildPreflightOpts } from "../prebuilds/registry.js";
import { getOrgModelPreferences } from "../services/org.js";
import { resolveModelSpec } from "../services/model-resolution.js";
import { hasOrgKey } from "../services/model-catalog.js";
import { listLlmProviders, parseModelId, providerNamespace } from "../services/llm-providers.js";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, orchestratorIdentities, orgs, users } from "../schema/index.js";
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
import { listSkillSourcesFor } from "../services/skills.js";
import { pluginSessionExtras, type PluginSessionExtras } from "../plugins/assemble.js";

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
   * Injected into every orchestrator session's `toolConfig.childReader`,
   * which is what the engine's `child_read` built-in calls. Paired with
   * `childSpawner`: a session that can spawn children is exactly the
   * session that may read them back.
   */
  childReader?: ChildReader;
  /**
   * Assembled plugin set (plugin-system-v2 Task 4's `assemblePlugins`
   * output). Every session builder goes through `sessionExtras`, which
   * builds the extras FRESH per build and never caches them on the host
   * instance.
   */
  plugins?: ValetPlugin[];
  /**
   * Assembled service→ActionPlugin index (plugin-system-v2 Task 4's
   * `assemblePlugins` output). Used only to look up a plugin's
   * `defaultApprovalMode` inside the policy resolver (action-policies plan,
   * Task 3) — org policies/grants apply regardless, so an absent map just
   * means the plugin-default rung falls through to the risk default.
   */
  actionPluginByService?: Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>;
  /**
   * Deps for resolving a session's `github` credential through the canonical
   * token service (`services/github-tokens.ts`'s `resolveGitHubToken`, via
   * `resolveSessionGitHubToken`) instead of a raw `CredentialStore` read
   * (GH-T10 fix). When present (with `db`), every session build gets a
   * `credentialResolver` that routes `github` through the token service —
   * honoring the session's primary repo binding auth — and delegates every
   * other service to the raw store (byte-identical). Absent === no resolver
   * at all: sessions read credentials straight from the store as before.
   * Same shape/`key` `ActionInvokerOpts.githubTokenDeps` uses.
   */
  githubTokenDeps?: {
    key: Buffer;
    apiUrl?: string;
    githubUrl?: string;
    fetchImpl?: typeof fetch;
    now?: () => number;
  };
  /**
   * Idle window (minutes) before a `ready` sandbox is hibernated (sandbox
   * hibernation plan, Task 3). `resolveIdleMinutes` (sandbox-backend.ts)
   * parses `VALET_SANDBOX_IDLE_MINUTES`; default `30`, `0`/invalid → `0`
   * (disabled). The idle sweep's `setInterval` only starts when this is
   * `> 0` AND `sandboxProvider.capabilities().hibernation === true`.
   */
  idleMinutes?: number;
  /**
   * Best-effort hook (sandbox hibernation plan, Task 3/4 seam): invoked
   * after the idle sweep successfully suspends a session's sandbox. Task 4
   * wires this to stamp `agent_sessions.status = "hibernated"` — this
   * package (Task 3) only exposes the seam. Errors are caught and logged,
   * never thrown into the sweep loop.
   */
  onHibernate?: (sessionId: string) => Promise<void> | void;
  /**
   * Best-effort hook (sandbox hibernation plan, Task 3/4 seam): invoked the
   * first time a previously-suspended session's attachment reaches `ready`
   * again (a `suspended → provisioning → ready` wake sequence, tracked via
   * the attachment's own `onStatus`). Task 4 wires this to clear the
   * hibernated status back to `"active"`. Errors are caught and logged,
   * never thrown into the attachment's status-listener path.
   */
  onWake?: (sessionId: string) => Promise<void> | void;
  /**
   * Cross-restart hibernation-clear seam (sandbox hibernation plan, Task 4
   * review carry-forward): `onWake` above is gated on an IN-MEMORY
   * `wasSuspended` flag, so it never fires for a session that hibernated,
   * then had this process restart, then got rebuilt on its next touch — a
   * rebuilt attachment starts `detached` and goes straight to
   * `provisioning`/`ready` without ever passing through `suspended` in this
   * process's lifetime. `onSessionReady` closes that gap: invoked on EVERY
   * `ready` transition of EVERY session build (`buildSession`,
   * `buildOrchestratorSession`, `buildChildSession`, `buildWorkflowSession`),
   * regardless of `wasSuspended`. Task 4 wires this to the same
   * "clear `hibernated` -> `active`" write `onWake` performs — the write is
   * conditioned on the row currently being `"hibernated"` (a no-op
   * otherwise), so firing on every ordinary cold-start is harmless. Errors
   * are caught and logged, never thrown into the attachment's status-
   * listener path.
   */
  onSessionReady?: (sessionId: string) => Promise<void> | void;
  /**
   * Test-only injection point for the idle sweep's race rule: a submission
   * admitted between the idleness check and the actual `suspend()` call
   * must win (the sweep must NOT suspend a session a caller just woke).
   * `beforeSuspend` fires after the idle sweep's first idleness check but
   * BEFORE its mandatory re-check of `listUnsettledSubmissions` — a test
   * can use it to admit a submission mid-sweep and assert the re-check
   * catches it. Never set outside tests.
   */
  idleSweepTestHooks?: {
    beforeSuspend?: (sessionId: string) => Promise<void> | void;
  };
  /**
   * Registry pull-preflight config for prebuilt-image resolution (sandbox
   * images v2 final-review Fix 3). When set, `resolvePrebuildImage` HEADs a
   * resolved kubernetes-backend image ref against the registry before booting
   * from it — a down registry / pruned image degrades to a COLD start instead
   * of an `ImagePullBackOff`. Absent (docker/local dev, tests) === no
   * preflight; the resolution proceeds as before. Threaded from
   * `VALET_PREBUILD_REGISTRY_INSECURE`/`VALET_PREBUILD_REGISTRY_PUSH` in
   * `providers/node.ts`, mirroring `resolveImageBuilder`'s own registry env.
   */
  prebuildPreflight?: PrebuildPreflightOpts;
}

export interface SessionMeta {
  userId: string;
  orgId: string;
  workspace: string;
  /** Interactive-service profile (sandbox auth gateway plan, Task 5).
   * Defaults to "headless" when omitted. */
  profile?: "headless" | "full";
  /**
   * Repo bindings for this session (GitHub/repo integration plan, Task 9),
   * in position order. When non-empty, `buildSession` wires a `specProvider`
   * that clones them via the credential helper on first cold boot. Absent/empty
   * === credential-only prep: the helper + `gh` shim still install (so ad-hoc
   * git/gh in any sandbox authenticates), but nothing clones.
   *
   * `targetDir` is the workspace-relative clone destination, computed ONCE at
   * bind time and persisted on `session_repos.target_dir` (spec decision 15).
   * `loadSessionMeta` supplies it; callers that build `SessionMeta` directly
   * (tests, orchestrator/child paths) must include it.
   */
  repos?: (RepoBinding & { targetDir: string })[];
  /**
   * Git identity (`user.name`/`user.email`) configured sandbox-global by
   * workspace prep, from the session owner's profile. Only consulted when
   * `repos` is non-empty; falls back to a generic identity when unset.
   */
  userName?: string;
  userEmail?: string;
}

/** A session build's model pair: the wire-ready pi-ai model object plus the
 * canonical spec the session persists (`CreateSessionOptions.modelSpec`). */
interface BuildModel {
  model: Model<any>;
  spec: string;
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

  /**
   * Idle-sweep interval handle (sandbox hibernation plan, Task 3), or
   * `null` when disabled (`idleMinutes <= 0` or the provider doesn't
   * report `hibernation` capability). ONE interval for the whole host,
   * 60s cadence, `.unref()`'d so it never keeps the process alive on its
   * own. Cleared in `evictAll()` (the shutdown path).
   */
  private sweepInterval: NodeJS.Timeout | null = null;

  /**
   * In-memory `sessionId -> Date.now()` of the last gateway-proxy touch
   * (final-review fix wave, hibernation arc): interactive Terminal/VS Code
   * traffic through `routes/gateway-proxy.ts` generates zero engine queue
   * activity (no submission is ever admitted), so without this map the idle
   * sweep would suspend a sandbox out from under a live terminal/editor tab.
   * Host-local, matching the sweep's own in-memory scope (`this.cache`) — a
   * gateway touch on process A never counts toward process B's sweep, same
   * limitation the sweep already accepts for its cache. Stamped by
   * `touchGatewayActivity` on every proxied HTTP request and WS open/
   * client-to-backend message; read by `maybeSuspendIdleSession` alongside
   * `latestActivityAt`, taking whichever is more recent.
   */
  private gatewayTouch = new Map<string, number>();

  /**
   * In-memory `sessionId -> Date.now()` of the last sandbox-token mint for
   * that session (sandbox-reconciliation plan, Task 12). Stamped by
   * `mintSandboxEnv` on every session build (create/restore). Read by
   * `startRotateSweep` to decide whether a token is older than the rotation
   * threshold (default 12 h). Cleared in `evictAll` alongside the rest of
   * the session state.
   */
  private tokenMintedAt = new Map<string, number>();

  /**
   * Lazily-built, host-wide policy resolver (action-policies plan, Task 3).
   * ONE instance shared by every session build — all per-invocation context
   * (org/user/session/service/params) rides in on the engine's
   * `PolicyResolveInput`, so the resolver holds no session state. Present
   * whenever an app `db` is wired (org policies/grants/audit all need it);
   * absent in db-less tests, which then get the engine's byte-identical
   * pre-policy approval path.
   */
  private policyResolverInstance: PolicyResolver | null = null;

  constructor(private readonly opts: EngineHostOpts) {
    const idleMinutes = opts.idleMinutes ?? 0;
    if (idleMinutes > 0 && opts.sandboxProvider.capabilities().hibernation) {
      this.sweepInterval = setInterval(() => {
        this.runIdleSweep().catch((err) => console.error("EngineHost: idle sweep failed:", err));
      }, 60_000);
      this.sweepInterval.unref?.();
    }
  }

  /**
   * Idle sweep tick (sandbox hibernation plan, Task 3, decision 3/6):
   * iterates the host's in-memory session cache ONLY — a session evicted
   * from cache, or never restored after an api restart, keeps a running
   * pod/sandbox that this sweep cannot see or suspend. Boot-restore only
   * rehydrates sessions with unsettled submissions, so an idle-but-running
   * sandbox from before a restart hibernates only when the session is next
   * touched (accepted Stage 1 limitation — decision 6 rejected a second,
   * cluster-side expiry authority).
   */
  private async runIdleSweep(): Promise<void> {
    const idleMs = (this.opts.idleMinutes ?? 0) * 60_000;
    if (idleMs <= 0) return;
    const now = Date.now();
    for (const [sessionId, entry] of this.cache) {
      try {
        await this.maybeSuspendIdleSession(sessionId, entry.session, now, idleMs);
      } catch (err) {
        console.error(`EngineHost: idle sweep failed for session ${sessionId}:`, err);
      }
    }
  }

  /**
   * Idleness (spec decision 3): no unsettled submissions AND the sandbox
   * has been `ready` with no queue activity for at least `idleMs`, judged
   * against `max(latestActivityAt ?? createdAt, gatewayTouch ?? 0)` — see
   * `touchGatewayActivity`'s doc comment for why the gateway side is
   * needed — AND the attachment is currently `ready` (never touches
   * `detached`/`provisioning`/`suspended`/`error`/`released` attachments).
   *
   * Race rule: `listUnsettledSubmissions` is checked once here, then
   * RE-CHECKED immediately before calling `suspend()` — a submission
   * admitted in between wins and the suspend is skipped.
   * `idleSweepTestHooks.beforeSuspend` fires between the two checks so
   * tests can inject that race deterministically.
   */
  private async maybeSuspendIdleSession(
    sessionId: string,
    session: Session,
    now: number,
    idleMs: number,
  ): Promise<void> {
    if (session.attachment.state !== "ready") return;

    const unsettled = await this.opts.engineStore.listUnsettledSubmissions(sessionId);
    if (unsettled.length > 0) return;

    let sinceMs = await this.opts.engineStore.latestActivityAt(sessionId);
    if (sinceMs == null) {
      const data = await this.opts.engineStore.getSession(sessionId);
      // No queue activity ever recorded and no session row (shouldn't
      // happen for a cached session, but fail safe) — treat as just-active
      // so we never suspend on missing data.
      sinceMs = data?.createdAt ?? now;
    }
    const gatewayTouchMs = this.gatewayTouch.get(sessionId) ?? 0;
    if (gatewayTouchMs > sinceMs) sinceMs = gatewayTouchMs;
    if (sinceMs >= now - idleMs) return;

    await this.opts.idleSweepTestHooks?.beforeSuspend?.(sessionId);

    // Re-check immediately before suspending — a submission admitted since
    // the check above wins.
    const recheck = await this.opts.engineStore.listUnsettledSubmissions(sessionId);
    if (recheck.length > 0) return;
    if (session.attachment.state !== "ready") return;

    await session.attachment.suspend();

    if (this.opts.onHibernate) {
      Promise.resolve(this.opts.onHibernate(sessionId)).catch((err) =>
        console.error(`EngineHost: onHibernate failed for session ${sessionId}:`, err),
      );
    }
  }

  /**
   * Wires the attachment's `onStatus` listener that drives `opts.onWake`
   * (sandbox hibernation plan, Task 3/4 seam): tracks a per-attachment
   * `wasSuspended` flag, firing `onWake` the first time the attachment
   * reaches `ready` after having been `suspended` (a
   * `suspended → provisioning → ready` wake sequence). Called once per
   * cached session build, right after `this.cache.set(...)` — the listener
   * lives as long as that `Session`'s attachment instance does.
   */
  private trackHibernationWake(sessionId: string, session: Session): void {
    let wasSuspended = false;
    session.attachment.onStatus((status) => {
      if (status.state === "suspended") {
        wasSuspended = true;
        return;
      }
      if (status.state === "ready") {
        if (wasSuspended) {
          wasSuspended = false;
          if (this.opts.onWake) {
            Promise.resolve(this.opts.onWake(sessionId)).catch((err) =>
              console.error(`EngineHost: onWake failed for session ${sessionId}:`, err),
            );
          }
        }
        // Unconditional (regardless of wasSuspended) — see
        // `EngineHostOpts.onSessionReady`'s doc comment for why this exists
        // separately from `onWake` above.
        if (this.opts.onSessionReady) {
          Promise.resolve(this.opts.onSessionReady(sessionId)).catch((err) =>
            console.error(`EngineHost: onSessionReady failed for session ${sessionId}:`, err),
          );
        }
        // Prep-completion seam for slash commands (Task 10): repo templates
        // under `/workspace/.valet/prompts` are only readable once workspace
        // prep has run, which happens by the time the attachment reaches
        // `ready`. Refresh the command registry so those templates land. A
        // no-op when the session has no `workspaceSkillsProvider`. Best-effort — a
        // refresh failure never breaks the ready transition.
        Promise.resolve(session.refreshCommandRegistry()).catch((err) =>
          console.error(`EngineHost: refreshCommandRegistry failed for session ${sessionId}:`, err),
        );
      }
    });
  }

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
    // `SessionMeta` carries no principal, and this builder passes no `owner`
    // to the engine either — `Session`'s constructor then defaults the
    // principal to `{ type: "user", id: options.userId }`. So the acting
    // user IS this session's owner, and the same `{ user, meta.userId }`
    // scope the session's credentials already use is the honest one here.
    const extras = await this.sessionExtras({ type: "user", id: meta.userId }, meta.orgId);

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
    const { model, spec: modelSpec } = await this.resolveModelForBuild(existing, meta.userId, meta.orgId);
    const resolveModel = this.makeResolveModel(meta.orgId);
    const profile = meta.profile ?? "headless";
    const sandboxMint = await this.mintSandboxEnv(sessionId, meta.userId, meta.orgId, profile);
    // Start-ref sink (engine traces spec, change 2 — host pattern B): the
    // specProvider closure resolves the primary clone's ref inside the sandbox
    // and calls this callback. The callback can fire before create/restore
    // returns (attachment provisioning races the build), so a ref that arrives
    // early is parked and flushed right after the session exists. Best-effort
    // throughout: a session that already carries a start-ref keeps it (start
    // conditions are immutable; a later epoch's re-clone may legitimately sit
    // at a newer SHA and must not overwrite).
    let builtSession: Session | undefined;
    let pendingStartRef: SessionStartRef | undefined;
    const onStartRef = async (ref: SessionStartRef) => {
      const target = builtSession;
      if (!target) {
        pendingStartRef = ref;
        return;
      }
      if (target.options.startRef) return;
      await target.setStartRef(ref).catch((err: unknown) => {
        console.error(
          `EngineHost: recording start-ref for session ${sessionId} failed:`,
          err instanceof Error ? err.message : String(err),
        );
      });
    };
    const specProvider = await this.buildSpecProvider(sessionId, meta, onStartRef);
    const credentialResolver = this.buildCredentialResolver(sessionId, meta.userId, meta.orgId);
    // Slash-command options (Task 10). The workspace-skills provider's sandbox
    // accessor closes over `builtSession` — resolved lazily, so it is safe that
    // the session doesn't exist yet at this point. `hasPrep` is true only when
    // a specProvider exists: without prep there is no `/workspace/.valet/prompts`
    // to scan (skills-as-commands plan, Task 4).
    const commandOptions = await this.buildCommandOptions(
      meta.orgId,
      sessionId,
      () => builtSession,
      specProvider !== undefined,
    );
    // Initial sandbox image: the stock default. The specProvider closure may
    // resolve a prebuild image override at provision time — the engine applies
    // DesiredSandboxSpec.image when the specProvider returns one.
    const image = this.opts.defaultImage;
    const sandboxOpts = {
      workspace: meta.workspace,
      image,
      env: sandboxMint?.env,
      profile,
      ...(sandboxMint ? { credsFiles: sandboxMint.credsFiles } : {}),
    };
    const policyResolver = this.getPolicyResolver();
    const session = existing
      ? await engine.restoreSession({
          sessionId,
          options: {
            userId: meta.userId,
            orgId: meta.orgId,
            workspace: meta.workspace,
            sandbox: sandboxOpts,
            model,
            modelSpec,
            resolveModel,
            systemPrompt: SYSTEM_PROMPT,
            tools: extras.tools.length ? extras.tools : undefined,
            skills: extras.skills.length ? extras.skills : undefined,
            roles: extras.roles.length ? extras.roles : undefined,
            ...(specProvider ? { specProvider } : {}),
            ...(credentialResolver ? { credentialResolver } : {}),
            ...(commandOptions ?? {}),
            ...(policyResolver ? { policyResolver } : {}),
          },
        })
      : await engine.createSession({
          id: sessionId,
          userId: meta.userId,
          orgId: meta.orgId,
          workspace: meta.workspace,
          sandbox: sandboxOpts,
          model,
          modelSpec,
          resolveModel,
          systemPrompt: SYSTEM_PROMPT,
          tools: extras.tools.length ? extras.tools : undefined,
          skills: extras.skills.length ? extras.skills : undefined,
          roles: extras.roles.length ? extras.roles : undefined,
          ...(specProvider ? { specProvider } : {}),
          ...(credentialResolver ? { credentialResolver } : {}),
          ...(commandOptions ?? {}),
          ...(policyResolver ? { policyResolver } : {}),
        });

    builtSession = session;
    if (pendingStartRef) {
      await onStartRef(pendingStartRef);
      pendingStartRef = undefined;
    }

    this.cache.set(sessionId, { engine, session });
    this.trackHibernationWake(sessionId, session);
    // Retention: after a successful restore of an existing session, prune
    // durable events for submissions that settled outside the retention
    // window. Fire-and-forget — never block or fail the restore.
    if (existing) this.pruneExpiredEvents(sessionId);
    return session;
  }

  /**
   * The tools/skills/roles a session build gets: the plugin set, plus the
   * stored skills the session's `owner` can reach (`skills` table).
   *
   * Built FRESH per session build, never cached on the host: the plugin
   * catalog's dynamic-action-resolution cache lives on the `Catalog`
   * instance `pluginCatalogTools` returns, so it must stay scoped to this
   * one session's credential context — a shared/cached catalog would leak
   * one user's resolved tool list into every other session. The skill read
   * is per-build for the same reason a session's memory snapshot is: an
   * edit reaches a session at its next build, not mid-run.
   *
   * `opts.db` is optional (tests that wire no db), so an absent db means
   * "plugin skills only" — the same graceful degradation `mintSandboxEnv`
   * applies. A stored skill whose name a plugin skill already holds is
   * shadowed inside `pluginSessionExtras`, never thrown: none of the four
   * callers has a try/catch, and a throw here would stop this owner from
   * starting any session.
   */
  private async sessionExtras(owner: Principal, orgId: string): Promise<PluginSessionExtras> {
    const plugins = this.opts.plugins ?? [];
    if (!this.opts.db) return pluginSessionExtras(plugins, []);
    return pluginSessionExtras(
      plugins,
      await listSkillSourcesFor(this.opts.db, owner, orgId),
    );
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
   * Mints a fresh long-lived sandbox bearer token (an ADDITIONAL token — it
   * does NOT revoke prior live ones, so a rebuild while an earlier build's
   * sandbox is still running never 401s that sandbox; see `mintSandboxToken`)
   * and derives this session's JWT secret, returning the five env vars every
   * sandbox
   * gets at provision time: `VALET_SANDBOX_TOKEN`, `VALET_API_URL`,
   * `VALET_SANDBOX_JWT_SECRET` (Task 8, auth-v2 plan), plus `VALET_SESSION_ID`
   * and `VALET_SANDBOX_PROFILE` (sandbox auth gateway plan, Task 5).
   * `VALET_SESSION_ID` must equal `sessionId` — it's the same id
   * `mintSandboxJwt` puts in the JWT's `sid` claim, and the gateway daemon
   * inside "full"-profile sandboxes enforces `sid === VALET_SESSION_ID`.
   * Called once per session BUILD (create or restore) — not per sandbox
   * re-provision within a build's lifetime, since the `SandboxCreateOpts`
   * object handed to `engine.createSession`/`restoreSession` is captured
   * once and reused by the attachment for every (re-)provision until the
   * next build.
   *
   * Returns `undefined` when `opts.db` is absent (tests that don't wire a
   * db up) — sandboxes then provision with no extra env, same as before
   * this wiring existed.
   */
  private async mintSandboxEnv(
    sessionId: string,
    userId: string,
    orgId: string,
    profile: "headless" | "full",
  ): Promise<{ env: Record<string, string>; credsFiles: Record<string, string> } | undefined> {
    if (!this.opts.db) return undefined;
    const { token } = await mintSandboxToken(this.opts.db, { sessionId, userId, orgId });
    this.tokenMintedAt.set(sessionId, Date.now());
    const secret = deriveSandboxJwtSecret(this.resolveSandboxJwtMaster(), sessionId);
    return {
      env: {
        // Keep env var for fallback: old sandboxes and non-credsMount providers
        // read VALET_SANDBOX_TOKEN from the process environment.
        VALET_SANDBOX_TOKEN: token,
        VALET_API_URL: this.opts.sandboxApiUrl ?? "http://localhost:8788",
        VALET_SANDBOX_JWT_SECRET: secret,
        VALET_SESSION_ID: sessionId,
        VALET_SANDBOX_PROFILE: profile,
      },
      credsFiles: { token },
    };
  }

  /**
   * Builds the `SpecProvider` closure for a session (sandbox-reconciliation
   * plan, Task 6). Returns `undefined` when the sandbox provider is not
   * isolated — local/virtual sandboxes exec against the host process, so
   * credential-only prep would rewrite the developer's real git config.
   *
   * The returned closure: calls `resolveSnapshot` (Task 2) + `computeSpec`
   * (Task 1) on every invocation (lazy staleness read), pairs the resulting
   * `StepSpec[]` with apply closures via `buildPrepSteps` (Task 6 prep-steps),
   * and returns the fully populated `DesiredSandboxSpec`. The image field
   * overrides the initial stock image the sandbox was provisioned with when a
   * fresh prebuild is available; the engine applies it at provision time.
   *
   * Prebuild recording (`agent_sessions.prebuild_id`) is best-effort: the
   * closure records the bake id whenever the snapshot resolves a fresh
   * repoBake, mirroring the old eager-recording behavior.
   */
  private async buildSpecProvider(
    sessionId: string,
    meta: SessionMeta,
    onStartRef?: (ref: SessionStartRef) => void | Promise<void>,
  ): Promise<import("@valet/engine").SpecProvider | undefined> {
    const hasRepos = meta.repos && meta.repos.length > 0;
    // Non-isolated providers (local/virtual) exec against the host process.
    // Credential-only prep (unbound sessions) would rewrite the developer's
    // real git config and drop a `gh` shim into the host's /usr/local/bin —
    // so skip it when not isolated. Repo-bound sessions always get prep
    // regardless of isolation, same as the old `buildWorkspacePrep` behavior.
    if (!hasRepos && this.opts.sandboxProvider.capabilities().isolated !== true) return undefined;

    const host = this;
    const apiUrl = this.opts.sandboxApiUrl ?? "http://localhost:8788";
    const stockImage = this.opts.defaultImage ?? "";

    return async () => {
      const snap = await resolveSnapshot({
        db: host.opts.db,
        provider: host.opts.sandboxProvider,
        meta,
        apiUrl,
        stockImage,
        preflight: host.opts.prebuildPreflight,
      });

      // Best-effort prebuild-id recording — same as the old eager path.
      if (snap.repoBake) {
        await host.recordPrebuildId(sessionId, snap.repoBake.bakeId);
      }

      const spec = computeSpec(snap);
      const steps = buildPrepSteps(snap, spec.steps, onStartRef);

      return {
        image: spec.image !== stockImage ? spec.image : undefined,
        specHash: specHash(spec),
        steps,
      };
    };
  }

  /**
   * Persist `agent_sessions.bake_id` for a session that resolved to a
   * prebuilt image (sandbox images v2, Task 4). Best-effort: a write failure
   * is logged, never thrown — the sandbox already points at the right image
   * regardless of whether the bookkeeping row updates, and session build must
   * never fail on prebuild resolution. Skipped when no app db is wired.
   */
  private async recordPrebuildId(sessionId: string, bakeId: string): Promise<void> {
    if (!this.opts.db) return;
    try {
      await this.opts.db
        .update(agentSessions)
        .set({ bakeId })
        .where(eq(agentSessions.id, sessionId));
    } catch (err) {
      console.error(`EngineHost: recording bake_id for session ${sessionId} failed:`, err);
    }
  }

  /**
   * Builds the `credentialResolver` (engine `CreateSessionOptions` seam,
   * GH-T10 fix) for a session, or `undefined` when `githubTokenDeps`/`db`
   * aren't wired — callers must conditionally spread the result so an
   * unresolved session's options stay byte-identical to before this fix (no
   * `credentialResolver` key at all → the engine reads the raw store).
   *
   * The resolver is the SINGLE decision point for this session's credentials:
   *  - `github` → `resolveSessionGitHubToken` (`purpose: "api"`), which honors
   *    the session's primary `session_repos` binding auth when it has one and
   *    resolves repo-less `auto` otherwise. A `GitHubAuthError` propagates
   *    unchanged — the engine surfaces it as the tool's error result, hint
   *    text intact. Synthesizes a `StoredCredential` the engine's
   *    `credentialProvider` maps to `{ accessToken }`.
   *  - every OTHER service → the raw `engineCredentials.get(owner, service)`
   *    read, byte-identical to the engine's default (store-backed) path.
   *
   * DEVIATION (for T12): workflow tool-node invocations
   * (`workflows/engine-deps.ts`'s `invokeAction`) carry no `sessionId`, so
   * their `github` actions resolve repo-less `auto` — the session-bound
   * branch of `resolveSessionGitHubToken` is exercised only from a real
   * session build (this resolver) today, not from the shipped workflow
   * engine, until workflow runs gain session context.
   *
   * PROBE COST (for T12): `plugin-catalog.ts`'s `list_tools` discovery calls
   * `credentials.get("github")` once per listing to emit a "not connected"
   * warning — and for `github` that `.get` is THIS resolver, so a cold-cache
   * tool listing can trigger a token mint/refresh over the network. It's the
   * `purpose: "api"` path, bounded by the token service's 5-minute mint cache
   * and single-flight refresh (a warm cache re-listing pays nothing), so the
   * cost is accepted/documented rather than engineered around here. A cheaper
   * probe would use `CredentialProvider.list` (a raw store read, no mint) to
   * answer the "is github connected" question discovery actually asks; that's
   * a follow-up seam, not new surface built in this wave.
   */
  /**
   * The host-wide `PolicyResolver` (action-policies plan, Task 3), or
   * `undefined` when no app `db` is wired (db-less tests keep the engine's
   * built-in risk→approval fallback, byte-identical to pre-policy behavior).
   * Built once and memoized — the resolver is session-agnostic.
   */
  private getPolicyResolver(): PolicyResolver | undefined {
    if (!this.opts.db) return undefined;
    if (!this.policyResolverInstance) {
      this.policyResolverInstance = buildPolicyResolver({
        db: this.opts.db,
        actionPluginByService: this.opts.actionPluginByService ?? new Map(),
      });
    }
    return this.policyResolverInstance;
  }

  private buildCredentialResolver(
    sessionId: string,
    userId: string,
    orgId: string,
  ): ((owner: CredentialOwner, service: string) => Promise<StoredCredential | null>) | undefined {
    const tokenDeps = this.opts.githubTokenDeps;
    const db = this.opts.db;
    const credentials = this.opts.engineCredentials;
    if (!tokenDeps || !db) return undefined;
    return async (owner, service) => {
      if (service !== "github") {
        // Byte-identical to the engine's default store-backed read.
        return credentials.get(owner, service);
      }
      const resolved = await resolveSessionGitHubToken(
        {
          db,
          credentials,
          key: tokenDeps.key,
          apiUrl: tokenDeps.apiUrl,
          githubUrl: tokenDeps.githubUrl,
          fetchImpl: tokenDeps.fetchImpl,
          now: tokenDeps.now,
        },
        { orgId, userId, sessionId, purpose: "api" },
      );
      // `purpose: "api"` throws (`GitHubAuthError`, with the connect hint)
      // rather than returning a null token; a null here would be a contract
      // violation upstream, so surface it as the same unconnected gap.
      if (resolved.token === null) {
        throw new GitHubAuthError(
          "no GitHub credential is available; connect your GitHub account or install the GitHub App for this organization",
        );
      }
      return { type: "oauth2", accessToken: resolved.token };
    };
  }

  /**
   * Assembles the slash-command options for a session build (slash-commands
   * plan, Task 10; skills-as-commands plan, Task 4): `workspaceSkillsProvider`,
   * `commandContext`, `bareSkillNames`, and the plugin-command pair
   * (`pluginCommands` + `pluginCatalog`).
   *
   * `getSession` returns the built `Session` once it exists (parked in a local
   * by the caller, same pattern as `onStartRef`). The workspace-skills
   * provider's sandbox accessor uses it to reach `session.sandbox` — but ONLY
   * when the attachment is already `ready`, so listing commands never
   * provisions a sandbox. Repo prompt skills become readable once workspace
   * prep finishes; the host calls `session.refreshCommandRegistry()` on each
   * `ready` transition (see `trackHibernationWake`) so the registry picks them
   * up then.
   *
   * `hasPrep` (skills-as-commands plan, Task 4): the workspace-skills provider
   * is wired ONLY when the session has a prepared workspace (a `specProvider`
   * exists). Without prep, `/workspace/.valet/prompts` is meaningless — a
   * non-isolated, repo-less session (and every sandbox-less orchestrator) execs
   * against a workspace that no prep ever created — so the provider, and its
   * `===VALET-TMPL` scan on the `ready` refresh, must not fire. When `hasPrep`
   * is false, `workspaceSkillsProvider` is omitted and `refreshCommandRegistry`
   * runs an empty scan. DB-stored prompt skills still reach the session through
   * `sessionExtras` regardless of prep.
   *
   * `bareSkillNames` reads `orgs.bareSkillCommands` (Task 3): when the org sets
   * it, stored/repo skills also register under their bare name in addition to
   * the always-present `skill:<name>` entry.
   *
   * `pluginCommands` and `pluginCatalog` are wired TOGETHER from the SAME
   * `ActionPlugin[]` that backs the LLM `call_tool` tool (via
   * `pluginSessionExtras`) — a command entry resolves through the registry, and
   * its backing action runs against this catalog, so approval policy and arg
   * validation stay identical to the tool path. Wiring one without the other
   * makes every plugin command fail with "no plugin catalog is configured".
   *
   * No `commandRequestDecision` is supplied: a slash command is not a claimed
   * turn, so it cannot suspend one on a decision gate, and the host has no
   * synchronous approve path (approvals resolve asynchronously over REST).
   * An approval-requiring plugin command therefore denies by default (Task 7
   * behavior), which is the safe outcome until a command-scoped async approval
   * flow exists.
   *
   * Returns `undefined` when the host has no `db` (tests that don't wire one) —
   * the session then builds with no command providers, same as before.
   */
  /**
   * `hasPrep` gates the workspace-skills provider — see the doc block above.
   * Pass `true` only when the caller wired a `specProvider` for this build.
   */
  private async buildCommandOptions(
    orgId: string,
    sessionId: string,
    getSession: () => Session | undefined,
    hasPrep: boolean,
  ): Promise<
    | {
        workspaceSkillsProvider?: () => Promise<SkillSource[]>;
        commandContext: CommandContext;
        bareSkillNames: boolean;
        pluginCommands: Array<{ pluginName: string; def: CommandDef }>;
        pluginCatalog: PluginCatalog;
      }
    | undefined
  > {
    const db = this.opts.db;
    if (!db) return undefined;

    // Task 3: moved bareSkillCommands to org level; read from orgs table.
    // (Was per-user users.bareSkillCommands — column removed in that task.)
    const bareRows = await db
      .select({ bareSkillCommands: orgs.bareSkillCommands })
      .from(orgs)
      .where(eq(orgs.id, orgId))
      .limit(1);
    const bareSkillNames = bareRows[0]?.bareSkillCommands ?? false;

    // Only a prepared workspace has a `/workspace/.valet/prompts` to scan; a
    // non-isolated repo-less session and every sandbox-less orchestrator have
    // none, so omit the provider (and its `===VALET-TMPL` exec) for them.
    const workspaceSkillsProvider = hasPrep
      ? makeWorkspaceSkillsProvider(() => {
          const session = getSession();
          // Only reach for the sandbox once it is provisioned — listing
          // commands must never trigger a cold start just to read repo prompts.
          if (!session || session.attachment.state !== "ready") return undefined;
          return session.sandbox as Sandbox;
        })
      : undefined;
    const commandContext = makeCommandContext(db, this.opts.engineCredentials, orgId, sessionId);

    const plugins = this.opts.plugins ?? [];
    const pluginCommands = plugins.flatMap((p) =>
      (p.commands ?? []).map((def) => ({ pluginName: p.name, def })),
    );
    const actionPlugins: ActionPlugin[] = plugins.flatMap((p) => p.actions ?? []);
    const pluginCatalog = buildPluginCatalog(actionPlugins);

    return {
      ...(workspaceSkillsProvider ? { workspaceSkillsProvider } : {}),
      commandContext,
      bareSkillNames,
      pluginCommands,
      pluginCatalog,
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
    const { model, spec: modelSpec } = await this.resolveModelForBuild(existing, meta.actorUserId, meta.orgId);
    const queueMode: "steer" | "followup" = principal.type === "user" ? "steer" : "followup";
    // `principal`, not `meta.actorUserId`: an orchestrator session belongs to
    // the principal and is shared by everyone who can reach it, exactly like
    // the memory snapshot this method assembles from `scope.owner`. Scoping
    // to the actor instead would put whoever woke a team orchestrator's
    // personal skills in front of every other member of that team.
    const extras = await this.sessionExtras(principal, meta.orgId);

    const sandboxMint = await this.mintSandboxEnv(sessionId, meta.actorUserId, meta.orgId, "headless");
    const credentialResolver = this.buildCredentialResolver(sessionId, meta.actorUserId, meta.orgId);
    // Slash-command options: same wiring as the interactive path, so the
    // orchestrator answers /model and /sessions instead of the no-context
    // fallback. The getter closes over `builtSession`, assigned below.
    // Orchestrators are sandbox-less (no specProvider), so `hasPrep` is false —
    // no `/workspace/.valet/prompts` scan. `bareSkillNames` comes from the org
    // row; DB-stored skills reach the orchestrator through `sessionExtras`,
    // scoped by the principal (skills-as-commands plan, Task 4).
    let builtSession: Session | undefined;
    const commandOptions = await this.buildCommandOptions(
      meta.orgId,
      sessionId,
      () => builtSession,
      false,
    );
    const policyResolver = this.getPolicyResolver();
    const sessionOptions = {
      userId: meta.actorUserId,
      orgId: meta.orgId,
      workspace,
      purpose: "orchestrator" as const,
      ...(credentialResolver ? { credentialResolver } : {}),
      ...(policyResolver ? { policyResolver } : {}),
      owner: principal,
      queueMode,
      sandbox: {
        workspace,
        image: this.opts.defaultImage,
        env: sandboxMint?.env,
        profile: "headless" as const,
        ...(sandboxMint ? { credsFiles: sandboxMint.credsFiles } : {}),
      },
      model,
      modelSpec,
      resolveModel: this.makeResolveModel(meta.orgId),
      systemPrompt: personaPrefix + orchestratorPersona(principal),
      tools: [...buildMemoryTools(), ...extras.tools],
      skills: extras.skills.length ? extras.skills : undefined,
      roles: extras.roles.length ? extras.roles : undefined,
      toolConfig: {
        apiBaseUrl,
        internalToken: internalToken(),
        ...(this.opts.childSpawner ? { childSpawner: this.opts.childSpawner } : {}),
        ...(this.opts.childReader ? { childReader: this.opts.childReader } : {}),
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
      ...(commandOptions ?? {}),
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
    builtSession = session;

    this.cache.set(sessionId, { engine, session });
    this.trackHibernationWake(sessionId, session);
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
    const existingRows = await db
      .select()
      .from(orchestratorIdentities)
      .where(
        and(
          eq(orchestratorIdentities.orgId, orgId),
          eq(orchestratorIdentities.ownerType, principal.type),
          eq(orchestratorIdentities.ownerId, principal.id),
        ),
      )
      .limit(1);
    if (existingRows[0]) return;

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
      .onConflictDoNothing();
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
    const identityRows = await db
      .select()
      .from(orchestratorIdentities)
      .where(
        and(
          eq(orchestratorIdentities.orgId, orgId),
          eq(orchestratorIdentities.ownerType, principal.type),
          eq(orchestratorIdentities.ownerId, principal.id),
        ),
      )
      .limit(1);
    const identity = identityRows[0];
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
      if (this.opts.db) {
        await revokeSandboxTokens(this.opts.db, sessionId);
        // Grant expiry (action-policies plan, Task 3): a stopped session's
        // runtime grants must not survive to quiet a future action on a
        // rebuilt session reusing the same id. Idempotent (guarded on
        // `revoked_at IS NULL`); best-effort — a failure here must not mask
        // the destroy, so it's logged, not thrown.
        try {
          await revokeSessionGrants(this.opts.db, sessionId);
        } catch (err) {
          console.error(`EngineHost: revoking session grants for ${sessionId} failed:`, err);
        }
      }
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
    this.tokenMintedAt.delete(sessionId);
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
    this.clearSweepInterval();
  }

  /** Shared by `evictAll()`/`destroyAll()` — both are terminal, whole-host
   * teardown paths and neither should leave the sweep `setInterval` running
   * against an emptied cache. */
  private clearSweepInterval(): void {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
  }

  /**
   * Tear down every live session INCLUDING their durable rows
   * (`store.deleteSession`). NOT for shutdown handlers — that's
   * `evictAll()`. Kept for tests and true delete-everything flows.
   */
  async destroyAll(): Promise<void> {
    const ids = [...this.cache.keys()];
    await Promise.allSettled(ids.map((id) => this.destroy(id)));
    this.clearSweepInterval();
  }

  /** True if a session is currently cached in this process. */
  isLive(sessionId: string): boolean {
    return this.cache.has(sessionId);
  }

  /**
   * Narrow accessor for the rotate sweep (sandbox-reconciliation plan, Task
   * 12). Returns a snapshot of every cached session whose attachment is in a
   * state the sweep can act on (`ready` or `suspended`). Exposes only the
   * fields the sweep needs — does NOT export raw cache entries or the
   * attachment object itself.
   *
   * `mintedAt` is the wall-clock ms of the last `mintSandboxEnv` call for
   * that session (0 when the host has no record — should not happen for a
   * cached session, but defensive).
   */
  listRotatableSessions(): Array<{
    sessionId: string;
    sandboxId: string | undefined;
    state: "ready" | "suspended";
    mintedAt: number;
    userId: string;
    orgId: string;
  }> {
    const result: Array<{
      sessionId: string;
      sandboxId: string | undefined;
      state: "ready" | "suspended";
      mintedAt: number;
      userId: string;
      orgId: string;
    }> = [];
    for (const [sessionId, entry] of this.cache) {
      const state = entry.session.attachment.state;
      if (state !== "ready" && state !== "suspended") continue;
      result.push({
        sessionId,
        sandboxId: entry.session.attachment.sandboxId,
        state,
        mintedAt: this.tokenMintedAt.get(sessionId) ?? 0,
        userId: entry.session.options.userId,
        orgId: entry.session.options.orgId,
      });
    }
    return result;
  }

  /**
   * Records a fresh mint time for a session — called by the rotate sweep
   * after it mints and pushes a new token via `updateCreds`, so a second
   * sweep pass within the rotation window is a no-op.
   */
  recordTokenMintedAt(sessionId: string, mintedAt: number): void {
    this.tokenMintedAt.set(sessionId, mintedAt);
  }

  /**
   * Stamps `sessionId`'s last-gateway-touch time to `Date.now()` (final-
   * review fix wave, hibernation arc). Called by `routes/gateway-proxy.ts`
   * at the cheapest correct points that prove a human is actively using the
   * "full"-profile Terminal/VS Code tab: HTTP proxy entry (every request),
   * WS `onOpen` (connection established), and WS client-to-backend
   * `onMessage` (keystrokes/input) — deliberately NOT every backend-to-
   * client frame, which would count idle terminal output/heartbeats as
   * activity. A plain `Map.set` — cheap enough to call unconditionally,
   * including per WS message. Never evicted/pruned: a stale entry for a
   * long-gone session is a few bytes in a `Map` and is harmless, since
   * `maybeSuspendIdleSession` only ever reads it for sessions currently in
   * `this.cache`.
   */
  touchGatewayActivity(sessionId: string): void {
    this.gatewayTouch.set(sessionId, Date.now());
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

  /**
   * The host `resolveModel` seam (engine `ResolvedModel`, Task 1) bound to one
   * org's provider config — passed into every `createSession`/`restoreSession`
   * options object so the engine resolves the effective model spec + per-turn
   * API key through the org catalog on every turn. Built per session build,
   * capturing `orgId`; keys are read fresh on each call (never cached) so a
   * rotated org credential applies on the next turn.
   */
  private makeResolveModel(orgId: string): (spec: string) => Promise<ResolvedModel | null> {
    return (spec: string) => resolveModelSpec(this.opts.db, this.opts.engineCredentials, orgId, spec);
  }

  /**
   * Resolve a model spec to a concrete `Model` for `options.model` at build
   * time, via the same catalog-aware bridge the per-turn seam uses. A `null`
   * return means the spec names no known model — surfaced as an error so a
   * session never silently boots on the wrong model.
   */
  private async resolveModelObject(orgId: string, spec: string): Promise<BuildModel> {
    // Session builds need the model OBJECT plus the canonical spec the
    // session should persist (`CreateSessionOptions.modelSpec` — the wire
    // `model.id` may differ for namespaced specs). NoCredentialsError means
    // the spec is valid but no key exists yet — accept via the attached
    // model so a keyless org can still open sessions (turns get the
    // engine's bounded credential-release path instead of a failed build).
    let resolved: ResolvedModel | null;
    try {
      resolved = await resolveModelSpec(this.opts.db, this.opts.engineCredentials, orgId, spec);
    } catch (err) {
      if (err instanceof NoCredentialsError) return { model: err.model, spec };
      throw err;
    }
    if (!resolved) {
      throw new Error(`EngineHost: unknown model "${spec}" — not in the org catalog or pi-ai registry`);
    }
    return { model: resolved.model, spec: resolved.canonicalId ?? resolved.model.id };
  }

  /**
   * `orgs.modelPreferences`, walked in preference order to find the first
   * entry backed by an ACTIVE provider, or `undefined` when unset, the host
   * has no `db`, or every preference's provider is inactive (disabled, or
   * deleted/unknown for custom namespaces). Uncached — a preferences change
   * applies on the very next session build (split-settings decision 9).
   *
   * Spec: new sessions must never resolve to an inactive provider (llm-
   * providers design doc decision 6) — disabling the provider behind
   * `orgPreferences[0]` must fall through to the next preference, not throw.
   * This only guards the new-session default tier; `overrideId` and the
   * user's explicit `defaultModel` still resolve straight through to
   * `resolveModelObject` and throw on a disabled provider, per the spec's
   * failure semantics for an explicit pick. Restore is untouched — it never
   * consults preferences at all (persisted model always wins).
   *
   * One `listLlmProviders` query total (not one per preference / no full
   * catalog build), plus one credential read per CUSTOM-namespaced
   * preference entry (acceptable — preference lists are short and this only
   * runs at session-build time, never per turn). "Active" mirrors the
   * catalog's own `resolvable` definition (`services/model-catalog.ts`),
   * which in turn mirrors `resolveModelSpec`'s throw condition:
   *   - known kind (anthropic/openai/google), no row → always active
   *     (zero-config path, same as `resolveModelSpec`'s no-row branch).
   *   - known kind WITH a row → active iff `row.enabled`. A row with
   *     neither an org key nor an env key is still "active" here even
   *     though `resolveModelSpec` now throws `NoCredentialsError` for that
   *     case — session build goes through `resolveModelObject`, which
   *     swallows `NoCredentialsError` and returns the attached model, so a
   *     keyless org still builds; keylessness is a turn-time concern (the
   *     engine's pre-run release/cap path), not a reason to skip this
   *     preference entry.
   *   - custom (`openai_compatible`) row → active iff `row.enabled` AND an
   *     org credential exists at `llm:{row.id}` — custom providers have NO
   *     env fallback, so a keyless custom row is exactly the case
   *     `resolveModelSpec` throws `provider {name} has no API key` for, and
   *     must not be treated as active here either (this is the key-delete
   *     bug this fell through: an admin could delete the key backing
   *     `orgPreferences[0]`, leaving new sessions with no key AND no
   *     fallback until the array was rewritten).
   */
  private async orgPreferredModel(orgId: string): Promise<string | undefined> {
    if (!this.opts.db) return undefined;
    const prefs = await getOrgModelPreferences(this.opts.db, orgId);
    if (prefs.length === 0) return undefined;
    const rows = await listLlmProviders(this.opts.db, orgId);
    for (const pref of prefs) {
      const { namespace } = parseModelId(pref);
      const row = rows.find((r) => providerNamespace(r) === namespace);
      let active: boolean;
      if (!row) {
        active = namespace === "anthropic" || namespace === "openai" || namespace === "google";
      } else if (row.kind === "openai_compatible") {
        active = row.enabled && (await hasOrgKey(this.opts.engineCredentials, orgId, row.id));
      } else {
        active = row.enabled;
      }
      if (active) return pref;
    }
    return undefined;
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
    const rows = await this.opts.db
      .select({ defaultModel: users.defaultModel })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0]?.defaultModel ?? undefined;
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
    orgId: string,
    overrideId?: string,
  ): Promise<BuildModel> {
    if (existing?.model) return this.resolveModelObject(orgId, existing.model);
    const id =
      overrideId ??
      (await this.userDefaultModel(userId)) ??
      (await this.orgPreferredModel(orgId)) ??
      this.opts.defaultModelId ??
      "claude-haiku-4-5";
    return this.resolveModelObject(orgId, id);
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
    // `opts.owner` is the child's own principal: the `task` tool reads the
    // parent session's principal and hands it to the spawner, which passes
    // it here and on to `createSession` below. A child of a team-owned
    // session gets that team's skills, not the spawning user's.
    const extras = await this.sessionExtras(opts.owner, opts.orgId);

    const existing = await this.opts.engineStore.getSession(childSessionId);
    const { model, spec: modelSpec } = await this.resolveModelForBuild(existing, opts.actorUserId, opts.orgId, opts.modelId);

    const sandboxMint = await this.mintSandboxEnv(childSessionId, opts.actorUserId, opts.orgId, "headless");
    const credentialResolver = this.buildCredentialResolver(childSessionId, opts.actorUserId, opts.orgId);
    const policyResolver = this.getPolicyResolver();
    const sessionOptions = {
      userId: opts.actorUserId,
      orgId: opts.orgId,
      workspace: opts.workspace,
      purpose: "child" as const,
      ...(credentialResolver ? { credentialResolver } : {}),
      ...(policyResolver ? { policyResolver } : {}),
      owner: opts.owner,
      parentSessionId: opts.parentSessionId,
      parentThreadId: opts.parentThreadId,
      sandbox: {
        workspace: opts.workspace,
        image: this.opts.defaultImage,
        env: sandboxMint?.env,
        profile: "headless" as const,
        ...(sandboxMint ? { credsFiles: sandboxMint.credsFiles } : {}),
      },
      model,
      modelSpec,
      resolveModel: this.makeResolveModel(opts.orgId),
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
    this.trackHibernationWake(childSessionId, session);
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
    // `opts.owner` is the run's own principal (`WorkflowRun.owner`, which
    // the scheduler and the event dispatcher copy from the definition row).
    // A run started from a team-owned workflow therefore reads the team's
    // skills, not those of whoever last edited the workflow.
    const extras = await this.sessionExtras(opts.owner, opts.orgId);

    const existing = await this.opts.engineStore.getSession(sessionId);
    const { model, spec: modelSpec } = await this.resolveModelForBuild(existing, opts.actorUserId, opts.orgId, opts.modelId);

    const sandboxMint = await this.mintSandboxEnv(sessionId, opts.actorUserId, opts.orgId, "headless");
    const credentialResolver = this.buildCredentialResolver(sessionId, opts.actorUserId, opts.orgId);
    const policyResolver = this.getPolicyResolver();
    const sessionOptions = {
      userId: opts.actorUserId,
      orgId: opts.orgId,
      workspace: opts.workspace,
      purpose: "workflow" as const,
      ...(credentialResolver ? { credentialResolver } : {}),
      ...(policyResolver ? { policyResolver } : {}),
      owner: opts.owner,
      sandbox: {
        workspace: opts.workspace,
        image: this.opts.defaultImage,
        env: sandboxMint?.env,
        profile: "headless" as const,
        ...(sandboxMint ? { credsFiles: sandboxMint.credsFiles } : {}),
      },
      model,
      modelSpec,
      resolveModel: this.makeResolveModel(opts.orgId),
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
    this.trackHibernationWake(sessionId, session);
    if (existing) this.pruneExpiredEvents(sessionId);
    return session;
  }
}
