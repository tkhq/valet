import type { Model } from "@earendil-works/pi-ai/compat";
import { and, eq } from "drizzle-orm";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Engine,
  assistantSessionId,
  parseAssistantSessionId,
  NoCredentialsError,
  type BlobStore,
  type ChildReader,
  type ChildSender,
  type ChildSpawner,
  type ChildStatusReader,
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
  loadRoleFromMarkdown,
  type ActionPlugin,
  type CommandContext,
  type CommandDef,
  type PinnedActionSpec,
  type PluginCatalog,
  type RepoInstructions,
  type Sandbox,
  type SandboxStatus,
  type SkillSource,
} from "@valet/engine";
import { buildPolicyResolver, revokeSessionGrants } from "../policies/service.js";
import { withSlackOwnerMetadata } from "../channels/identity-links.js";
import type { RepoBinding } from "../wire/types.js";
import { makeCommandContext, makeWorkspaceSkillsProvider } from "./command-providers.js";
import { makeRepoInstructionsProvider } from "./repo-instructions.js";
import {
  GITHUB_INSTALLATION_CREDENTIAL_SERVICE,
  GitHubAuthError,
  resolveInstallationApiToken,
} from "../services/github-tokens.js";
import { primaryRepoBinding, resolveSessionGitHubToken } from "../services/session-github-token.js";
import { repoDockerFlag } from "../bakes/source-service.js";
import { loadSessionMeta } from "./session-meta.js";
import { resolveSnapshot } from "./resolve-snapshot.js";
import { computeSpec, specHash } from "./sandbox-spec.js";
import { buildPrepSteps } from "./prep-steps.js";
import type { PrebuildPreflightOpts } from "../prebuilds/registry.js";
import { getOrgModelPreferences } from "../services/org.js";
import { resolveModelSpec } from "../services/model-resolution.js";
import { resolveOpenAiCredential } from "../services/openai-key.js";
import { hasOrgKey } from "../services/model-catalog.js";
import { listLlmProviders, parseModelId, providerNamespace } from "../services/llm-providers.js";
import type { AppDb } from "../lib/drizzle.js";
import {
  agentSessions,
  orgs,
  securityCells,
  securityEngagements,
  users,
  type SecurityCellRow,
} from "../schema/index.js";
import { loadAssistant } from "../assistants/service.js";
import { internalToken } from "../lib/internal-auth.js";
import {
  deriveSandboxJwtSecret,
  mintSandboxToken,
  mintSandboxJwt,
  revokeSandboxTokens,
} from "../auth/sandbox-tokens.js";
import securityPlugin from "@valet/plugin-security/plugin";
import { orchestratorPersona } from "../orchestrator/persona.js";
import { buildMemoryTools } from "../orchestrator/memory-tools.js";
import { buildSecurityPersonaTools, buildSecurityRunnerTools } from "./security-tools.js";
import { securityCompactionHook } from "./security-compaction.js";
import { assembleMemorySnapshot } from "../orchestrator/snapshot.js";
import { ensureTodayJournal } from "../orchestrator/bootstrap.js";
import { journalCompactionHook } from "../orchestrator/compaction.js";
import { readOwnFile, type MemoryScope } from "../services/memory.js";
import { listSkillSourcesFor } from "../services/skills.js";
import { mergedSkillSources, pluginSessionExtras, type PluginSessionExtras } from "../plugins/assemble.js";
import { gateUnavailableActions, unavailableServiceSet } from "../services/integration-availability.js";
import { PINNED_ACTIONS } from "../plugins/pinned-actions.js";

/** Personality is capped at injection time (assistant-centered web UI
 * decision 5), independent of any cap the memory service itself applies. */
const PERSONALITY_INJECT_CAP = 500;

/**
 * The security roles to attach for a claimed cell's persona (dynamic-config
 * M-F1, repo-persona roles M-P2c). Returns the ONE role that matches the cell's
 * persona, so a `code-review` cell gets only the code-review role, not every
 * security role.
 *
 * Resolution order (repo wins):
 *   1. A bundled persona id (`code-review`, `architect`, `verifier`,
 *      `threat-model`, `attack-tree`, `sast`) → its bundled role.
 *   2. A repo-defined persona (a key in `.valet/security.yml`'s `personas` map)
 *      → a RoleSpec built from `repoRoleMarkdown`, the markdown fetched from the
 *      clone at create and stashed on the engagement. The RoleSpec's `name` is
 *      forced to the cell's persona id so the dispatch prompt's `role` overlay
 *      resolves, regardless of the markdown's own frontmatter name.
 *   3. No bundled role and no repo markdown → the code-review role, with a
 *      logged corrective note.
 *
 * `repoRoleMarkdown` is the resolved markdown for THIS persona (the caller looks
 * it up in the engagement's `config_persona_markdown` map). Absent means no repo
 * role was stashed for this persona; the function then falls back.
 */
export function securityRolesForCell(
  persona: string,
  repoRoleMarkdown?: string,
): NonNullable<typeof securityPlugin.roles> {
  const roles = securityPlugin.roles ?? [];
  const match = roles.find((r) => r.name === persona);
  if (match) return [match];

  if (repoRoleMarkdown && repoRoleMarkdown.trim() !== "") {
    try {
      const role = loadRoleFromMarkdown(repoRoleMarkdown, "session", persona);
      // Force the role name to the persona id: the dispatch prompt sets
      // `role: cell.persona`, so the overlay resolves by the config key, not by
      // whatever frontmatter name the repo file carries.
      return [{ ...role, name: persona }];
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(
        `security: repo persona "${persona}" role markdown failed to load (${detail}); ` +
          "attaching the code-review role. Fix the persona markdown in the repo.",
      );
    }
  }

  const fallback = roles.find((r) => r.name === "code-review");
  console.warn(
    `security: persona "${persona}" has no bundled role and no readable repo role; ` +
      "attaching the code-review role. Define the persona in .valet/security.yml's " +
      "personas map with a readable markdown path to run it under its own role.",
  );
  return fallback ? [fallback] : [];
}

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
   * Optional stock-image override. Single image lineage (2026-08-16
   * design): every session boots `defaultImages.full ?? defaultImage`
   * regardless of profile/docker shape. The `headless` key is legacy and
   * ignored — kept in the type so older callers/tests type-check and so
   * tests can prove it is NOT consulted.
   */
  defaultImages?: Partial<Record<"headless" | "full", string>>;
  /**
   * The app db handle — required by `assistantSessionFor` (the assistant
   * row lookup, memory snapshot assembly, journal bootstrap, and the
   * compaction hook). Every session builder also uses it
   * (when present) to mint/revoke the session's sandbox token (Task 8,
   * auth-v2 plan) — absent only in tests that don't wire one up, which
   * degrade gracefully to no sandbox env injection.
   */
  db?: AppDb;
  /**
   * This process's own base URL (e.g. `http://127.0.0.1:${port}`), handed
   * to orchestrator sessions as `toolConfig.apiBaseUrl` so the `mem_*`
   * tools can reach the memory HTTP routes (decision 15). Required for
   * `assistantSessionFor`.
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
   * Injected into every orchestrator session's `toolConfig.childSender`,
   * which is what the engine's `child_send` built-in calls. Completes the
   * child toolset (`task` spawns, `child_read` reads, `child_send`
   * steers); scoped exactly like the other two — children never get it.
   */
  childSender?: ChildSender;
  /**
   * Injected into every orchestrator session's `toolConfig.childStatusReader`,
   * the backend of the `child_status` built-in. Same authority note as
   * `childReader`: a session that can spawn children is exactly the
   * session that may check on them.
   */
  childStatusReader?: ChildStatusReader;
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
   * package (Task 3) only exposes the seam. `sandboxId` is the suspended
   * attachment's provider handle, recorded by the hibernated-sandbox reaper
   * as its destroy handle. Errors are caught and logged, never thrown into
   * the sweep loop.
   */
  onHibernate?: (sessionId: string, sandboxId?: string) => Promise<void> | void;
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
   * `buildAssistantSession`, `buildChildSession`, `buildWorkflowSession`),
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
  /** Request a rootless docker daemon inside this session's sandbox
   * (docker-in-sandbox). See docs/specs/2026-08-15-sandbox-docker-design.md. */
  docker?: boolean;
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
  "Your visible tool list is not your full capability set: integration " +
  "actions (code hosting, email, chat, and more) are reachable through " +
  "list_tools and call_tool, and installed skills through the skill tool " +
  "when one is listed. Before you tell the user that something is not " +
  "possible, call list_tools and check for a matching action. If the " +
  "needed integration is not connected, say so and name the fix — never " +
  "present a missing connection as a missing capability. Be concise.";

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
   * iterates the host's in-memory session cache ONLY. Sessions an api
   * restart evicted (boot-restore only rehydrates unsettled work) are the
   * `IdleHibernationSweep`'s jurisdiction — a DB-driven complement added
   * after 32 stranded active-but-idle assistant pods saturated a node
   * (2026-08-22; the original "hibernates only when next touched" Stage 1
   * limitation proved too expensive). Jurisdiction rule: cached or
   * mid-build sessions belong HERE (this sweep reads the gateway-touch
   * activity signal the DB sweep cannot); everything else belongs there.
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
      Promise.resolve(this.opts.onHibernate(sessionId, session.attachment.sandboxId)).catch((err) =>
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
        // Repo AGENTS.md instructions (agents-md spec, decision 1): re-read on
        // every ready transition — cold boot, wake, and warm rebuild — so
        // mid-session edits land at natural boundaries. A no-op when the
        // session has no `repoInstructionsProvider`. Best-effort, same as the
        // registry refresh above; a failure leaves the previous value serving.
        Promise.resolve(session.refreshRepoInstructions()).catch((err) =>
          console.error(`EngineHost: refreshRepoInstructions failed for session ${sessionId}:`, err),
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
    // Assistant ids must always wake through `assistantSessionFor` so they
    // get persona/memory-snapshot/mem_* tools/queueMode reconstructed from
    // configuration, never the generic `buildSession` path. Every caller of
    // `sessionFor` (messages.ts, ws.ts, sessions.ts, boot restore) can be
    // handed an assistant session id, so this dispatch lives here rather
    // than being duplicated at each call site. Delegating before touching
    // `this.cache`/`this.inflight` is deliberate: `assistantSessionFor`
    // does its own cache/inflight bookkeeping against the *same* maps
    // (keyed by the same `sessionId`), so checking here first would just be
    // a redundant, and potentially stale, read.
    const assistantId = parseAssistantSessionId(sessionId);
    if (assistantId) {
      return this.assistantSessionFor(assistantId, { actorUserId: meta.userId, orgId: meta.orgId });
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
    // Security runner wiring (Valet Security spec §Tools): a session whose
    // app row carries kind='security' gets the sec_* runner tools, the
    // engagement-runner skill, and the child read/send/status seams —
    // deliberately NOT the childSpawner, so the generic `task` tool answers
    // unavailable and every dispatch goes through sec_dispatch (Decision 3).
    // plugin-security is registry-enabled (M9), but `sessionExtras`/
    // `skillsProviderFor` filter it out of the base plugin set — plugin
    // skills attach globally, and the engagement-runner skill must reach
    // ONLY runner builds (spec implementation deviation 20). The directly
    // imported manifest, threaded as an extra plugin for this build only,
    // is the single attach path, so the skill lands exactly once.
    const isSecurityRunner = (await this.storedKind(sessionId)) === "security";
    // Persona child wiring (M4): a session a running security cell claims
    // gets the persona tool set, the persona role, and the tool endpoint
    // config — the post-restart rebuild path for dispatched cell children
    // (the first build goes through `buildChildSession`, same wiring).
    const personaCell = isSecurityRunner ? null : await this.claimedSecurityCell(sessionId);
    const extraPlugins = isSecurityRunner ? [securityPlugin] : [];
    // `SessionMeta` carries no principal, and this builder passes no `owner`
    // to the engine either — `Session`'s constructor then defaults the
    // principal to `{ type: "user", id: options.userId }`. So the acting
    // user IS this session's owner, and the same `{ user, meta.userId }`
    // scope the session's credentials already use is the honest one here.
    const extras = await this.sessionExtras({ type: "user", id: meta.userId }, meta.orgId, [], extraPlugins);
    const skillsProvider = this.skillsProviderFor({ type: "user", id: meta.userId }, meta.orgId, extraPlugins);

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
    // Docker flag: session-create opt OR repo `.valet/prebuild.yaml` docker
    // key. `resolveRepoDockerFlag` is best-effort — any failure resolves
    // false. Single image lineage: the flag only shapes SandboxCreateOpts
    // (caps/mounts/exec identity), never which image is resolved.
    const dockerFlag = meta.docker === true || (await this.resolveRepoDockerFlag(sessionId, meta));
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
    // Repo AGENTS.md instructions (agents-md spec, decision 5): same lazy
    // `builtSession` accessor as the command options above.
    const repoInstructionsProvider = this.buildRepoInstructionsProvider(
      () => builtSession,
      meta.repos,
      specProvider !== undefined,
    );
    // Initial sandbox image: the single-lineage stock default — every
    // session shape boots the full sandbox image (start scripts + docker
    // toolchain baked in; the profile only decides whether the interactive
    // services START). The specProvider closure may resolve a bake image
    // override at provision time — the engine applies
    // DesiredSandboxSpec.image when the specProvider returns one.
    const image = this.opts.defaultImages?.full ?? this.opts.defaultImage;
    const sandboxOpts = {
      workspace: meta.workspace,
      image,
      env: sandboxMint?.env,
      profile,
      ...(dockerFlag ? { docker: true } : {}),
      ...(sandboxMint ? { credsFiles: sandboxMint.credsFiles } : {}),
    };
    const policyResolver = this.getPolicyResolver();
    // Runner tools sit before the plugin tools so the loop surface reads
    // first in the tool list. The toolConfig mirrors the orchestrator's
    // (apiBaseUrl + internal token for the sec_* HTTP seam; child
    // read/send/status seams for steering dispatched personas) minus the
    // childSpawner — see the isSecurityRunner comment above.
    const sessionTools = isSecurityRunner
      ? [...buildSecurityRunnerTools(), ...extras.tools]
      : personaCell
        ? [...buildSecurityPersonaTools({ review: personaCell.review, persona: personaCell.persona }), ...extras.tools]
        : extras.tools;
    const securityToolConfig = isSecurityRunner
      ? {
          toolConfig: {
            ...(this.opts.apiBaseUrl ? { apiBaseUrl: this.opts.apiBaseUrl } : {}),
            internalToken: internalToken(),
            ...(this.opts.childReader ? { childReader: this.opts.childReader } : {}),
            ...(this.opts.childSender ? { childSender: this.opts.childSender } : {}),
            ...(this.opts.childStatusReader ? { childStatusReader: this.opts.childStatusReader } : {}),
          },
        }
      : personaCell
        ? {
            // The persona tools' HTTP seam only — no child seams and no
            // spawner (a persona child steers nothing and spawns nothing).
            toolConfig: {
              ...(this.opts.apiBaseUrl ? { apiBaseUrl: this.opts.apiBaseUrl } : {}),
              internalToken: internalToken(),
            },
            // Compaction is observable, not silent (M5, spec §Context
            // Discipline): stamp + staleness alert on the claiming cell.
            // `claimedSecurityCell` returned a row, so a db handle exists;
            // the guard narrows the type only.
            ...(this.opts.db ? { compactionHooks: [securityCompactionHook(this.opts.db)] } : {}),
          }
        : {};
    // The persona role registers on the session (roles registry) so the
    // dispatch prompt's per-turn `role` overlay resolves. Attach ONLY the role
    // matching the claimed cell's persona (not every security role) — the
    // engagement-runner SKILL stays off persona children. A repo-defined
    // persona loads its role from the engagement's stashed markdown (M-P2c).
    const personaRepoRoleMarkdown = personaCell
      ? await this.repoRoleMarkdownForCell(personaCell)
      : undefined;
    const sessionRoles = personaCell
      ? [...extras.roles, ...securityRolesForCell(personaCell.persona, personaRepoRoleMarkdown)]
      : extras.roles;
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
            tools: sessionTools.length ? sessionTools : undefined,
            skills: extras.skills.length ? extras.skills : undefined,
            roles: sessionRoles.length ? sessionRoles : undefined,
            ...securityToolConfig,
            ...(skillsProvider ? { skillsProvider } : {}),
            ...(specProvider ? { specProvider } : {}),
            ...(credentialResolver ? { credentialResolver } : {}),
            ...(commandOptions ?? {}),
            ...(repoInstructionsProvider ? { repoInstructionsProvider } : {}),
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
          tools: sessionTools.length ? sessionTools : undefined,
          skills: extras.skills.length ? extras.skills : undefined,
          roles: sessionRoles.length ? sessionRoles : undefined,
          ...securityToolConfig,
          ...(skillsProvider ? { skillsProvider } : {}),
          ...(specProvider ? { specProvider } : {}),
          ...(credentialResolver ? { credentialResolver } : {}),
          ...(commandOptions ?? {}),
          ...(repoInstructionsProvider ? { repoInstructionsProvider } : {}),
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
   * here seeds the session at build; `skillsProviderFor` (below) re-reads it
   * on registry refreshes so later skill edits reach a cached session too.
   *
   * `opts.db` is optional (tests that wire no db), so an absent db means
   * "plugin skills only" — the same graceful degradation `mintSandboxEnv`
   * applies. A stored skill whose name a plugin skill already holds is
   * shadowed inside `pluginSessionExtras`, never thrown: none of the four
   * callers has a try/catch, and a throw here would stop this owner from
   * starting any session.
   *
   * `pins` defaults to none, and each caller decides. This method is the one
   * funnel for FOUR session builders — `buildSession`, `buildAssistantSession`,
   * `buildChildSession` and `buildWorkflowSession` — so a pin list hard-coded
   * here would reach unattended, trigger-driven sessions. A pinned tool is
   * high-salience: it sits in the tool list with host guidance that tells the
   * model to call it in the same turn. Text that a webhook or an email put in
   * a workflow run's prompt must not meet that. Only the caller knows whether
   * a human is watching, so only the caller passes pins.
   */
  /**
   * The registry plugin set every session build starts from, with
   * plugin-security filtered OUT (spec implementation deviation 20).
   * Plugin skills have no scoping mechanism — `pluginSessionExtras`
   * attaches every plugin's skills to every session — and the
   * engagement-runner skill instructs a loop only `kind='security'`
   * runners have the sec_* tools for. The plugin stays registry-enabled
   * for discovery; the kind-gated build paths re-add the directly
   * imported manifest (`extraPlugins` for the runner skill, the
   * persona-cell `roles` concat for the code-review role), each exactly
   * once.
   */
  private basePlugins(): ValetPlugin[] {
    return (this.opts.plugins ?? []).filter((p) => p.name !== securityPlugin.name);
  }

  private async sessionExtras(
    owner: Principal,
    orgId: string,
    pins: readonly PinnedActionSpec[] = [],
    // Build-scoped plugin additions (the security runner's disabled-in-
    // registry manifest) — appended after the registry set so registry
    // plugins keep shadow priority.
    extraPlugins: readonly ValetPlugin[] = [],
  ): Promise<PluginSessionExtras> {
    const allPlugins = [...this.basePlugins(), ...extraPlugins];
    // Availability gate (integration-availability design): a service whose
    // deployment/org prerequisite is missing never reaches the catalog, so
    // `list_tools` has nothing to hide. Per-build, not process-static: the
    // org-credential half of availability changes when an admin connects or
    // removes the org app.
    const plugins = gateUnavailableActions(
      allPlugins,
      await unavailableServiceSet({
        plugins: allPlugins,
        orgId,
        credentials: this.opts.engineCredentials,
        env: process.env,
      }),
    );
    if (!this.opts.db) return pluginSessionExtras(plugins, [], pins);
    return pluginSessionExtras(
      plugins,
      await listSkillSourcesFor(this.opts.db, owner, orgId),
      pins,
    );
  }

  /**
   * The engine `skillsProvider` for a session owned by `owner`: re-reads the
   * stored skills that owner can reach and merges them under the plugin set
   * with the same shadow rule `sessionExtras` applies
   * (`mergedSkillSources`). `Session.refreshCommandRegistry()` invokes it —
   * on every `GET /:id/commands` and on each attachment `ready` transition —
   * so a skill created, edited, or deleted after the session was built
   * reaches a long-lived cached session (the orchestrator especially: it
   * lives in the host cache indefinitely, so without this it would only ever
   * see the skills that existed at its first build).
   *
   * `undefined` without a db — the session then keeps its construction-time
   * skill set, the same graceful degradation `sessionExtras` applies.
   */
  private skillsProviderFor(
    owner: Principal,
    orgId: string,
    // Must match the `extraPlugins` the build's `sessionExtras` got, or a
    // registry refresh silently DROPS the extras' skills (the refresh
    // replaces the session's whole skill map from this provider).
    extraPlugins: readonly ValetPlugin[] = [],
  ): (() => Promise<SkillSource[]>) | undefined {
    const db = this.opts.db;
    if (!db) return undefined;
    const plugins = [...this.basePlugins(), ...extraPlugins];
    return async () =>
      mergedSkillSources(plugins, await listSkillSourcesFor(db, owner, orgId)).skills;
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
    // Single image lineage: one stock image for every session shape. Must
    // agree with the create-opts image in `buildSession`/`buildChild` or the
    // `spec.image !== stockImage` comparison below misreports the stock
    // case as an override.
    const stockImage =
      this.opts.defaultImages?.full ??
      this.opts.defaultImage ??
      "";

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
   *  - `github:installation` → `resolveInstallationApiToken`, the explicit
   *    installation-tier request (the binding's owner, else the org's sole
   *    installation). `null` when no installation resolves.
   *  - `slack` → user credential first (personal `plugin-slack-user` token),
   *    then org credential (`plugin-slack` bot token) as fallback. When a
   *    credential is found and the session user has a `slack` identity link,
   *    `metadata.owner_slack_user_id` is injected, activating plugin-slack's
   *    private-channel check. No enrichment when no link is found or no
   *    credential is stored (returns `null` or the bare stored credential).
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
      if (service === GITHUB_INSTALLATION_CREDENTIAL_SERVICE) {
        // Explicit installation-tier request (github.list_repos with
        // `scope: "installation"`): mint the App installation token directly
        // instead of reusing whatever tier default `github` resolution
        // picked — a user token 403s on `GET /installation/repositories`.
        // `null` (no installation) stays `null`; the action names the
        // corrective step in its own error.
        const binding = await primaryRepoBinding(db, sessionId);
        const token = await resolveInstallationApiToken(
          {
            db,
            credentials,
            key: tokenDeps.key,
            apiUrl: tokenDeps.apiUrl,
            githubUrl: tokenDeps.githubUrl,
            fetchImpl: tokenDeps.fetchImpl,
            now: tokenDeps.now,
          },
          orgId,
          binding?.repo.owner,
        );
        return token === null ? null : { type: "app_install", accessToken: token };
      }
      if (service === "openai") {
        // plugin-openai's key probe: org OpenAI LLM-provider key → stored
        // "openai" credential → OPENAI_API_KEY env. `null` keeps the openai
        // tools hidden in list_tools (requiresCredential gating).
        return resolveOpenAiCredential(db, credentials, owner, orgId);
      }
      if (service !== "github") {
        if (service === "slack") {
          // The Slack bot token is org-shared: `PUT
          // /api/credentials/slack?scope=org` stores it under
          // `{ type: "org", id: orgId }`. The engine's session always calls
          // the resolver with a user owner, so a plain exact-owner read would
          // return null for every production session. Read the user credential
          // first (a personal `plugin-slack-user` token takes precedence);
          // when absent, escalate to the org owner.
          const stored =
            (await credentials.get(owner, service)) ??
            (await credentials.get({ type: "org", id: orgId }, service));
          // Activates plugin-slack's private-channel check: the identity
          // link is the single source of truth for the owner's Slack user
          // id, regardless of how the link was created. Shared with the
          // workflow action invoker (`plugins/action-invoker.ts`).
          if (stored) return withSlackOwnerMetadata(db, userId, stored);
          return null;
        }
        return await credentials.get(owner, service);
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
   * Best-effort: reads `.valet/prebuild.yaml`'s `docker` key for the session's
   * primary repo. Returns `false` on any failure (no token, no repos, non-GitHub
   * host, network error, bad YAML) — the session still starts without docker.
   *
   * Mirrors the guard structure of `buildCredentialResolver`: exits early when
   * `githubTokenDeps`/`db` are not wired (db-less test environments).
   */
  private async resolveRepoDockerFlag(sessionId: string, meta: SessionMeta): Promise<boolean> {
    const tokenDeps = this.opts.githubTokenDeps;
    const db = this.opts.db;
    if (!tokenDeps || !db) return false;
    try {
      const primaryRepo = meta.repos?.[0];
      if (!primaryRepo) return false;
      const host = primaryRepo.host ?? "github.com";
      if (host !== "github.com") return false;
      const [owner, repoName] = primaryRepo.fullName.split("/");
      if (!owner || !repoName) return false;
      const ref = primaryRepo.ref ?? "HEAD";
      const fullDeps = {
        db,
        credentials: this.opts.engineCredentials,
        key: tokenDeps.key,
        apiUrl: tokenDeps.apiUrl,
        githubUrl: tokenDeps.githubUrl,
        fetchImpl: tokenDeps.fetchImpl,
        now: tokenDeps.now,
      };
      const resolved = await resolveSessionGitHubToken(
        fullDeps,
        { orgId: meta.orgId, sessionId, purpose: "api" },
      );
      const TIMEOUT_MS = 5_000;
      const timedOut = Symbol("timedOut");
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<typeof timedOut>((resolve) => {
        timeoutId = setTimeout(() => resolve(timedOut), TIMEOUT_MS);
        // Unref so the timer does not keep the process alive after all real work ends.
        if (timeoutId && typeof (timeoutId as NodeJS.Timeout).unref === "function") {
          (timeoutId as NodeJS.Timeout).unref();
        }
      });
      const result = await Promise.race([
        repoDockerFlag(fullDeps, resolved.token, owner, repoName, ref),
        timeoutPromise,
      ]);
      clearTimeout(timeoutId);
      if (result === timedOut) {
        // Do not cache — a timeout is not a repo answer.
        console.error(
          `EngineHost: resolveRepoDockerFlag timed out for session ${sessionId}`,
        );
        return false;
      }
      return result;
    } catch (err) {
      console.error(
        `EngineHost: resolveRepoDockerFlag failed for session ${sessionId}:`,
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
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
   * Builds the `repoInstructionsProvider` for a session build (agents-md
   * spec, decision 5). Wired only when the session has BOTH a prepared
   * workspace (`hasPrep`, same gate as `workspaceSkillsProvider`) and at
   * least one repo binding — a credential-only prep clones nothing, so
   * there is no AGENTS.md to scan. The sandbox accessor mirrors
   * `buildCommandOptions`: it reaches for the sandbox only once the
   * attachment is `ready`, so a refresh never provisions one.
   */
  private buildRepoInstructionsProvider(
    getSession: () => Session | undefined,
    repos: SessionMeta["repos"],
    hasPrep: boolean,
  ): (() => Promise<RepoInstructions | null>) | undefined {
    if (!hasPrep || !repos || repos.length === 0) return undefined;
    return makeRepoInstructionsProvider(() => {
      const session = getSession();
      if (!session || session.attachment.state !== "ready") return undefined;
      return session.sandbox as Sandbox;
    }, repos[0].targetDir);
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
   * The session kind stored on the app session row. Answers `"code"` (the
   * column default) when the host has no db handle or no row exists —
   * db-less builds never get the security wiring.
   */
  private async storedKind(sessionId: string): Promise<string> {
    const db = this.opts.db;
    if (!db) return "code";
    const rows = await db
      .select({ kind: agentSessions.kind })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1);
    return rows[0]?.kind ?? "code";
  }

  /**
   * The running security cell (if any) that claims this session id as its
   * dispatched child (Valet Security M4). The claim exists BEFORE the child
   * session is built — `dispatchCell` stamps `child_session_id` pre-spawn —
   * so both first builds and post-restart rebuilds see it. One indexed
   * query (`security_cells_child_session`); non-security sessions pay a
   * single miss. `null` without a db, the usual graceful degradation.
   */
  private async claimedSecurityCell(sessionId: string): Promise<SecurityCellRow | null> {
    const db = this.opts.db;
    if (!db) return null;
    const rows = await db
      .select()
      .from(securityCells)
      .where(and(eq(securityCells.childSessionId, sessionId), eq(securityCells.status, "running")))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The repo-defined role markdown for a claimed cell's persona (M-P2c). Reads
   * the cell's engagement `config_persona_markdown` map (id → markdown, stashed
   * at create from the clone) and returns the entry for the cell's persona.
   * Returns undefined for a bundled persona (no repo markdown), a preset-seeded
   * engagement (no map), or a persona the map does not name. `securityRolesForCell`
   * uses the result to attach a repo persona's own role, repo wins.
   */
  private async repoRoleMarkdownForCell(cell: SecurityCellRow): Promise<string | undefined> {
    const db = this.opts.db;
    if (!db) return undefined;
    const rows = await db
      .select({ md: securityEngagements.configPersonaMarkdown })
      .from(securityEngagements)
      .where(eq(securityEngagements.id, cell.engagementId))
      .limit(1);
    const raw = rows[0]?.md;
    if (!raw) return undefined;
    let map: unknown;
    try {
      map = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (typeof map !== "object" || map === null || Array.isArray(map)) return undefined;
    const value = (map as Record<string, unknown>)[cell.persona];
    return typeof value === "string" ? value : undefined;
  }

  /**
   * The sandbox profile stored on the app session row. Answers `"headless"`
   * when the host has no db handle (tests that wire none) and when no row
   * exists yet, which is the column's own default.
   */
  private async storedProfile(sessionId: string): Promise<"headless" | "full"> {
    const db = this.opts.db;
    if (!db) return "headless";
    const rows = await db
      .select({ profile: agentSessions.profile })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1);
    return rows[0]?.profile ?? "headless";
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
   * Resolve (or lazily create) the session of one assistant (Phase 4
   * decision 17, retargeted by the assistants design). Wakes instantly and
   * sandbox-less: the sandbox is a `SandboxCreateOpts` template, never a
   * pre-created/warm sandbox — cold attachment is an assistant's steady
   * state.
   *
   * Takes an assistant id, not a principal: a principal owns any number of
   * assistants, so only the id says which session is meant. Callers that
   * hold a principal go through `resolveDefaultAssistant`
   * (`assistants/service.ts`) first, which is the one place a principal
   * becomes an assistant.
   *
   * `CreateSessionOptions` is reconstructed from configuration on every
   * wake (persona, memory snapshot, tools, toolConfig), not from whatever
   * was persisted at creation time, per the orchestrator spec's "instant
   * wake" section — so a restored session gets a freshly-assembled snapshot
   * and today's journal, same as a brand-new one.
   */
  async assistantSessionFor(
    assistantId: string,
    meta: { actorUserId: string; orgId: string },
    opts?: {
      /** The assistant row's stored `session_id`. Callers holding the row
       * pass it so the STORED id stays authoritative — rows migrated from
       * `orchestrator_identities` keep their legacy `orchestrator:*`
       * session (and its history). Fresh rows store
       * `assistantSessionId(id)` at creation, so passing it is a no-op
       * there; omitted, the derived id is the fallback. */
      sessionId?: string;
    },
  ): Promise<Session> {
    const sessionId = opts?.sessionId ?? assistantSessionId(assistantId);
    const cached = this.cache.get(sessionId);
    if (cached) return cached.session;
    const pending = this.inflight.get(sessionId);
    if (pending) return pending;

    const promise = this.buildAssistantSession(sessionId, assistantId, meta).finally(() => {
      this.inflight.delete(sessionId);
    });
    this.inflight.set(sessionId, promise);
    return promise;
  }

  private async buildAssistantSession(
    sessionId: string,
    assistantId: string,
    meta: { actorUserId: string; orgId: string },
  ): Promise<Session> {
    if (!this.opts.db) {
      throw new Error("EngineHost: assistantSessionFor requires opts.db");
    }
    if (!this.opts.apiBaseUrl) {
      throw new Error("EngineHost: assistantSessionFor requires opts.apiBaseUrl");
    }
    const db = this.opts.db;
    const apiBaseUrl = this.opts.apiBaseUrl;

    const assistant = await loadAssistant(db, assistantId);
    if (!assistant) {
      throw new Error(
        `EngineHost: no assistant ${assistantId}. Create one through POST /api/assistants, ` +
          `or resolve the owner's default with resolveDefaultAssistant, before waking its session.`,
      );
    }
    // The OWNER, not the assistant: memory, journal and skills belong to the
    // principal and are shared by every assistant it owns. Only the
    // workspace directory below is per-assistant.
    const principal: Principal = { type: assistant.ownerType, id: assistant.ownerId };

    const workspace = join(homedir(), ".valet", "assistants", assistantId);
    await mkdir(workspace, { recursive: true });

    const scope: MemoryScope = { owner: principal, actorUserId: meta.actorUserId };
    await ensureTodayJournal(db, scope);
    const snapshotContent = await assembleMemorySnapshot(db, scope);
    const personaPrefix = await this.resolvePersonaPrefix(db, scope, assistant.name);

    const existing = await this.opts.engineStore.getSession(sessionId);
    const { model, spec: modelSpec } = await this.resolveModelForBuild(existing, meta.actorUserId, meta.orgId);
    const queueMode: "steer" | "followup" = principal.type === "user" ? "steer" : "followup";
    // `principal`, not `meta.actorUserId`: an assistant session belongs to
    // the principal and is shared by everyone who can reach it, exactly like
    // the memory snapshot this method assembles from `scope.owner`. Scoping
    // to the actor instead would put whoever woke a team assistant's
    // personal skills in front of every other member of that team.
    //
    // Pins go to a USER-owned assistant only. A team assistant's session is
    // cached on the assistant id, and `sessionOptions.userId` below freezes
    // to the FIRST person who woke it. `workflows.patch_workflow` authorizes
    // on that frozen `userId`, which reaches that person's own workflows and
    // every team they belong to. So a pinned save tool in a team assistant
    // would let the second member drive the first member's principal. The
    // workflow editor panel always opens the caller's OWN default assistant
    // (`use-workflow-assistant.ts`), so this scope costs the panel nothing.
    const pins = principal.type === "user" ? PINNED_ACTIONS : [];
    const extras = await this.sessionExtras(principal, meta.orgId, pins);

    // The profile comes from the app row, not from the caller's meta. An
    // assistant session is woken by many callers — the web, a channel
    // message, a workflow — and the first one to touch it decides the
    // cached build. Only one of them holds the app row, so reading the row
    // here is what makes "Terminal and VS Code are on for this assistant"
    // survive a wake from Slack. No row (an assistant woken before its
    // first web visit) means headless, the same value the column defaults
    // to. See `PATCH /api/sessions/:id`.
    const profile = await this.storedProfile(sessionId);
    const sandboxMint = await this.mintSandboxEnv(sessionId, meta.actorUserId, meta.orgId, profile);
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
    const skillsProvider = this.skillsProviderFor(principal, meta.orgId);
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
        // Single-lineage stock default, the same fall-through a REST-created
        // session and a child both use. This path pinned `defaultImage`,
        // which is the wrong image for a `full` assistant: `/start-full.sh`
        // is baked into the full lineage only.
        image: this.opts.defaultImages?.full ?? this.opts.defaultImage,
        env: sandboxMint?.env,
        profile,
        ...(sandboxMint ? { credsFiles: sandboxMint.credsFiles } : {}),
      },
      model,
      modelSpec,
      resolveModel: this.makeResolveModel(meta.orgId),
      systemPrompt: personaPrefix + orchestratorPersona(principal),
      tools: [...buildMemoryTools(), ...extras.tools],
      skills: extras.skills.length ? extras.skills : undefined,
      roles: extras.roles.length ? extras.roles : undefined,
      // The orchestrator lives in the host cache indefinitely, so this
      // refresh seam is what lets skills created after its first wake show
      // up in its slash-command list.
      ...(skillsProvider ? { skillsProvider } : {}),
      toolConfig: {
        apiBaseUrl,
        internalToken: internalToken(),
        ...(this.opts.childSpawner ? { childSpawner: this.opts.childSpawner } : {}),
        ...(this.opts.childReader ? { childReader: this.opts.childReader } : {}),
        ...(this.opts.childSender ? { childSender: this.opts.childSender } : {}),
        ...(this.opts.childStatusReader ? { childStatusReader: this.opts.childStatusReader } : {}),
      },
      // Assembled once, here, at wake time — not per-turn. This snapshot is
      // frozen for the cached session's lifetime; the only way to see a
      // fresher snapshot is a cache eviction (session destroy/restart),
      // which forces the next `assistantSessionFor` call back through
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

    return session;
  }

  /**
   * `You are {name}. {personality}` prefix for the assistant's
   * `systemPrompt` (assistant-centered web UI decision 5): `name` from
   * `assistants.name`, `personality` from the `assistant/personality.md`
   * memory file, capped at `PERSONALITY_INJECT_CAP` chars. Absent name →
   * `""` (neutral persona, unchanged) regardless of whether a personality
   * file exists — the identity step always sets name first, so an orphaned
   * personality file without a name shouldn't happen, but if it ever does
   * we don't want a prefix with no name in it.
   */
  private async resolvePersonaPrefix(
    db: AppDb,
    scope: MemoryScope,
    name: string | null,
  ): Promise<string> {
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
   * decision 4/5): the next `assistantSessionFor` call misses the cache
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
   * Cached OR currently mid-build (`inflight`). The stranded-session
   * sweep's jurisdiction test: a session being restored right now is not
   * yet in the cache, but suspending its sandbox out from under the build
   * would hand the new attachment a scaled-down pod — mid-build counts as
   * live.
   */
  sessionLiveOrBuilding(sessionId: string): boolean {
    return this.cache.has(sessionId) || this.inflight.has(sessionId);
  }

  /**
   * Flip a `hibernated` row back to `active` because the session is about
   * to be USED — a prompt, a channel delivery, a child_send, an explicit
   * open. Callers at those intent points invoke this after materializing
   * the session; read-only paths (GET messages, WS attach, gateway
   * proxying) must NOT — a view of a hibernated session is not a wake,
   * and flipping the row on views would un-park suspended sandboxes from
   * the reaper's retention indefinitely. Chat-only wakes never make a
   * `ready` attachment transition, so neither `onWake` nor
   * `onSessionReady` would fire for them — this is their heal path.
   * Awaited (unlike the attachment-transition hooks) so a caller that
   * immediately re-stamps status — the pause route — cannot be reordered
   * against it. Guarded no-op for rows in any other status.
   */
  async markSessionUsed(sessionId: string): Promise<void> {
    if (!this.opts.onWake) return;
    try {
      await this.opts.onWake(sessionId);
    } catch (err) {
      console.error(`EngineHost: markSessionUsed failed for session ${sessionId}:`, err);
    }
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

  /** The cached session's org, or null when uncached — the capacity
   * gate's org-resolution seam (`gated-sandbox-provider.ts`). A
   * provisioning attachment always belongs to a cached session, so a null
   * here means the create did not come from a session at all. */
  sessionOrgId(sessionId: string): string | null {
    return this.cache.get(sessionId)?.session.options.orgId ?? null;
  }

  /**
   * How many cached sessions of this org hold (or are building) a live
   * sandbox: attachment `provisioning` or `ready`. The capacity gate
   * subtracts its own waiters from this count — their attachments already
   * read `provisioning` while they hold no pod — so an admitted create
   * stays counted through provider.create AND the post-create prep window
   * (a live pod is never invisible to the gate). `suspended` is excluded
   * because a suspended sandbox holds no pod; `error` frees the slot.
   */
  countLiveSandboxSessions(orgId: string): number {
    let count = 0;
    for (const entry of this.cache.values()) {
      if (entry.session.options.orgId !== orgId) continue;
      const state = entry.session.attachment.state;
      if (state === "provisioning" || state === "ready") count += 1;
    }
    return count;
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
   * Whether the sandbox backend can suspend/resume (hibernation). The
   * child retention path consults this at settle time: capable backends
   * park a settled child's sandbox for later revival; the rest destroy it
   * eagerly, exactly as before retention existed.
   */
  sandboxHibernationCapable(): boolean {
    return this.opts.sandboxProvider.capabilities().hibernation;
  }

  /**
   * Destroy one sandbox by its provider id, without touching any session
   * state. The child retention sweep uses this for a parked child whose
   * session is no longer cached (an api restart evicted it) — the
   * `child_watches.parkedSandboxId` recorded at park time is the only
   * remaining handle.
   */
  async destroySandbox(sandboxId: string): Promise<void> {
    await this.opts.sandboxProvider.destroy(sandboxId);
  }

  /**
   * Suspend one sandbox by its provider id, without touching any session
   * state. The stranded-session sweep (`idle-hibernation-sweep.ts`) uses
   * this for an idle ACTIVE session an api restart evicted from the cache
   * — there is no live attachment to call `suspend()` on. Throws when the
   * backend has no hibernation seam; callers gate on
   * `sandboxHibernationCapable()` first.
   */
  async suspendSandbox(sandboxId: string): Promise<void> {
    const suspend = this.opts.sandboxProvider.suspend;
    if (!suspend) {
      throw new Error(
        `EngineHost.suspendSandbox: the ${this.opts.sandboxProvider.backend} backend has no suspend seam. ` +
          "Gate callers on sandboxHibernationCapable().",
      );
    }
    await suspend.call(this.opts.sandboxProvider, sandboxId);
  }

  /** The provider's view of one sandbox — `state: "released"` means the
   * backing resource does not exist. */
  async sandboxStatus(sandboxId: string): Promise<SandboxStatus> {
    return this.opts.sandboxProvider.status(sandboxId);
  }

  /** Recompute the sandbox id a workspace would provision under
   * (`SandboxProvider.deriveId`); null for backend-assigned ids. */
  deriveSandboxId(sessionKey: string): string | null {
    return this.opts.sandboxProvider.deriveId?.(sessionKey) ?? null;
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
   * has no `db` (only `assistantSessionFor` requires `db`; the other
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
      /** Interactive-service profile (default "headless"). */
      profile?: "headless" | "full";
      /** Rootless docker daemon in the child's sandbox (docker-in-sandbox). */
      docker?: boolean;
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
      /** Interactive-service profile (default "headless"). */
      profile?: "headless" | "full";
      /** Rootless docker daemon in the child's sandbox (docker-in-sandbox). */
      docker?: boolean;
    },
  ): Promise<Session> {
    // `opts.owner` is the child's own principal: the `task` tool reads the
    // parent session's principal and hands it to the spawner, which passes
    // it here and on to `createSession` below. A child of a team-owned
    // session gets that team's skills, not the spawning user's.
    const extras = await this.sessionExtras(opts.owner, opts.orgId);
    const skillsProvider = this.skillsProviderFor(opts.owner, opts.orgId);
    // Persona child wiring (Valet Security M4): the security dispatch
    // stamps its cell claim (`child_session_id`) BEFORE the spawn builds
    // this session, so this first build already sees it and attaches the
    // persona tool set, the persona role, and the tool endpoint config.
    // One indexed query; ordinary task children pay a single miss.
    const personaCell = await this.claimedSecurityCell(childSessionId);
    const childTools = personaCell
      ? [...buildSecurityPersonaTools({ review: personaCell.review, persona: personaCell.persona }), ...extras.tools]
      : extras.tools;
    // The persona role registers on the session (roles registry) so the
    // dispatch prompt's per-turn `role` overlay resolves. Attach ONLY the role
    // matching the claimed cell's persona — the engagement-runner SKILL stays
    // off persona children. A repo-defined persona loads its role from the
    // engagement's stashed markdown (M-P2c).
    const childRepoRoleMarkdown = personaCell
      ? await this.repoRoleMarkdownForCell(personaCell)
      : undefined;
    const childRoles = personaCell
      ? [...extras.roles, ...securityRolesForCell(personaCell.persona, childRepoRoleMarkdown)]
      : extras.roles;

    const existing = await this.opts.engineStore.getSession(childSessionId);
    const { model, spec: modelSpec } = await this.resolveModelForBuild(existing, opts.actorUserId, opts.orgId, opts.modelId);

    const profile = opts.profile ?? "headless";
    const sandboxMint = await this.mintSandboxEnv(childSessionId, opts.actorUserId, opts.orgId, profile);
    const credentialResolver = this.buildCredentialResolver(childSessionId, opts.actorUserId, opts.orgId);
    const policyResolver = this.getPolicyResolver();
    // A child spawned with a repo binding (the spawner inserts the
    // `session_repos` row before calling in here) gets the same declarative
    // clone prep a REST-created session gets. Only this first build decides —
    // later cache hits ignore meta (see `loadSessionMeta`'s module doc). No
    // start-ref sink: a child session records no start-ref today. An absent
    // `opts.db` (tests that wire no db) degrades to empty bindings, same as
    // `sessionExtras`/`mintSandboxEnv`.
    // `profile`/`docker` MUST reach the meta: `buildSpecProvider` resolves
    // the sandbox image per-profile from it. Dropping them here resolved a
    // full/docker child against the HEADLESS base bake — an image without
    // /start-full.sh or the docker toolchain — while the manifest ran the
    // full-profile command, so the pod crash-looped (dev-v2 DinD outage).
    const meta = this.opts.db
      ? await loadSessionMeta(this.opts.db, {
          id: childSessionId,
          userId: opts.actorUserId,
          orgId: opts.orgId,
          workspace: opts.workspace,
          profile,
          ...(opts.docker !== undefined ? { docker: opts.docker } : {}),
        })
      : {
          userId: opts.actorUserId,
          orgId: opts.orgId,
          workspace: opts.workspace,
          profile,
          ...(opts.docker !== undefined ? { docker: opts.docker } : {}),
        };
    const specProvider = await this.buildSpecProvider(childSessionId, meta);
    // Repo AGENTS.md instructions (agents-md spec, decision 5): a child
    // spawned with a repo binding reads its AGENTS.md exactly like a
    // REST-created session. `builtSession` is assigned below, after the
    // engine builds the session — the provider resolves it lazily.
    let builtSession: Session | undefined;
    const repoInstructionsProvider = this.buildRepoInstructionsProvider(
      () => builtSession,
      "repos" in meta ? meta.repos : undefined,
      specProvider !== undefined,
    );
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
        // Single-lineage stock default, same fall-through as a REST-created
        // session (`sessionFor`).
        image: this.opts.defaultImages?.full ?? this.opts.defaultImage,
        env: sandboxMint?.env,
        profile,
        ...(opts.docker ? { docker: true } : {}),
        ...(sandboxMint ? { credsFiles: sandboxMint.credsFiles } : {}),
      },
      model,
      modelSpec,
      resolveModel: this.makeResolveModel(opts.orgId),
      systemPrompt: SYSTEM_PROMPT,
      tools: childTools.length ? childTools : undefined,
      skills: extras.skills.length ? extras.skills : undefined,
      roles: childRoles.length ? childRoles : undefined,
      // The persona tools' HTTP seam only — still NO childSpawner (the
      // depth-limit contract) and no child seams.
      ...(personaCell
        ? {
            toolConfig: {
              ...(this.opts.apiBaseUrl ? { apiBaseUrl: this.opts.apiBaseUrl } : {}),
              internalToken: internalToken(),
            },
            // Compaction is observable, not silent (M5, spec §Context
            // Discipline) — same hook as the post-restart rebuild path in
            // `buildSession`. Db guard narrows the type only (the claim
            // lookup already required one).
            ...(this.opts.db ? { compactionHooks: [securityCompactionHook(this.opts.db)] } : {}),
          }
        : {}),
      ...(skillsProvider ? { skillsProvider } : {}),
      ...(specProvider ? { specProvider } : {}),
      ...(repoInstructionsProvider ? { repoInstructionsProvider } : {}),
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

    builtSession = session;
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
    const skillsProvider = this.skillsProviderFor(opts.owner, opts.orgId);

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
      // Tier 0 (sandbox-tiering spec, 2026-08-22): workflow sessions are
      // sandbox-less by default, like orchestrators. A session-node turn
      // that only calls the LLM and api-side plugin actions never
      // provisions a pod; the lazy PolicySandbox attachment provisions on
      // the first tool that actually touches the filesystem. The
      // saturation incident's triage workflow (slack read + LLM, 11-way
      // foreach, every 10 minutes) would have provisioned ZERO sandboxes
      // under this flag.
      warmSandboxOnClaim: false,
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
      ...(skillsProvider ? { skillsProvider } : {}),
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
