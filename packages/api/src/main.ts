/**
 * Node server boot.
 *
 *   ANTHROPIC_API_KEY=sk-... VALET_LOCAL_AUTH=1 pnpm --filter @valet/api dev
 *
 * `startServer()` boots the API on `PORT` (default 8787) reading all effective
 * values from `process.env`, and returns a handle whose `close()` performs the
 * graceful shutdown. Importing this module has NO side effects — the server
 * only boots when this file is run as the direct entry (`tsx src/main.ts`), or
 * when a caller (e.g. the `valet serve` command) invokes `startServer()`.
 */
import { eq } from "drizzle-orm";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createApp, type AuthWiring } from "./app.js";
import { selectServerAdapter } from "./server-adapter.js";
import { buildNodeProviders, shouldSeedLocalIdentity } from "./providers/node.js";
import { getAttachmentRefStore } from "./services/attachment-refs.js";
import { parseSandboxBackend } from "./providers/sandbox-backend.js";
import { agentSessions } from "./schema/index.js";
import { loadSessionMeta } from "./engine/session-meta.js";
import type { Providers } from "./providers/types.js";
import { authModeConflict, loadAuthConfig } from "./auth/config.js";
import { buildAuthHooks } from "./auth/provisioning.js";
import { buildAuth } from "./auth/index.js";
import {
  loadInstanceConfig,
  resolveAllowedEmailDomains,
  resolveSsoTeamMapping,
  InstanceConfigError,
  type InstanceConfig,
} from "./config/instance-config.js";
import { reconcileInstanceConfig } from "./services/config-reconcile.js";
import { findOrg, getOrgFeatures, getSsoTeamGroups } from "./services/org.js";
import { reportTeamSyncState } from "./services/team-sync.js";
import { syncAllAppWebhookUrls } from "./services/github-app.js";
import { publicUrlFromEnv } from "./channels/host.js";
import { wireAttentionRouter } from "./orchestrator/attention-wiring.js";
import { initTelemetry } from "./observability/otel.js";
import { ensureWorkflowSession } from "./workflows/engine-deps.js";
import { restoreOneSession, runBoundedRestore, type RestoreSessionDeps } from "./boot-restore.js";
import { ensureEnvProviders } from "./proxy/upstream.js";
import { resolveOrgId } from "./lib/org.js";
import { webDistPath } from "./assets/base.js";
import { startRotateSweep, type RotateSweepHandle } from "./engine/rotate-sweep.js";
import {
  startInstallationSweep,
  type InstallationSweepHandle,
} from "./services/github-installation-sweep.js";
import { deriveSecretKey } from "./lib/secret-crypto.js";

/** Handle returned by `startServer`: a graceful `close()` plus the resolved
 * values the boot actually used. */
export interface ServerHandle {
  /** Graceful shutdown: stop hosts, evict sandboxes, close the http server.
   * Idempotent; leaves the durable store intact for boot-time reconciliation. */
  close(): Promise<void>;
  /** The port the server is listening on. */
  port: number;
  /** The resolved sandbox backend (`docker` | `local` | `kubernetes`). */
  backend: string;
}

/** Per-session boot-restore wait budget. A session past it stops blocking
 * the restore pass (and therefore readiness); its restore keeps running in
 * the background and `sessionFor`'s single-flight map dedupes later access.
 * Sized for a warm sandbox re-attach plus a `git fetch` on a large repo. */
const BOOT_RESTORE_SESSION_TIMEOUT_MS = 60_000;
/** How many sessions the boot-restore pass works on at once — bounds total
 * pass time to ~`ceil(n / 4) * timeout` in the worst case, and stops one
 * wedged sandbox from serializing every other session behind it. */
const BOOT_RESTORE_CONCURRENCY = 4;

/**
 * Eager restore of sessions with unsettled submissions. On boot the store may
 * hold in-flight submissions from a previous process; materializing their
 * engine sessions lets the claim loop pick the work back up. Per-session
 * failures are isolated so one bad row can't stall the rest of the boot.
 *
 * Runs in the background boot chain, AFTER the HTTP listener binds (see
 * `startServer`): a restore pass that touches sandboxes can stall on a
 * wedged exec, and that stall must cost readiness at most, never liveness.
 */
async function restoreUnsettledSessions(providers: Providers, shouldStop: () => boolean): Promise<void> {
  let ids: string[] = [];
  try {
    ids = await providers.engineStore.listSessionIdsWithUnsettledSubmissions();
  } catch (err) {
    console.error("boot restore: failed to list unsettled sessions:", err);
    return;
  }
  const deps: RestoreSessionDeps = {
    ensureWorkflowSession: (sessionId) =>
      ensureWorkflowSession(
        {
          host: providers.engineHost,
          store: providers.workflowStore,
          db: providers.db,
          engineStore: providers.engineStore,
          actionPluginByService: providers.actionPluginByService,
          credentials: providers.engineCredentials,
        },
        sessionId,
      ),
    lookupAgentSession: async (sessionId) => {
      // Keep this lookup call sited INSIDE the per-session try below: a
      // lookup that rejects (bad row, transient store error) must isolate
      // to this one session, not abort the whole restore pass and
      // crash-loop boot.
      const rows = await providers.db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .limit(1);
      const row = rows[0];
      if (!row) return undefined;

      // Repo bindings + git identity (GitHub/repo integration plan, Task 9)
      // — assembled centrally via `loadSessionMeta` so a restarted process
      // that rehydrates a session with unsettled submissions still runs prep
      // on the first cold sandbox boot. `profile` is always present here
      // (the app row column is non-null), satisfying `RestoreSessionMeta`.
      return { ...(await loadSessionMeta(providers.db, row)), profile: row.profile };
    },
    sessionFor: async (sessionId, meta) => {
      const session = await providers.engineHost.sessionFor(sessionId, meta);
      // A timed-out restore keeps running after the pass abandons it, so it
      // can resolve AFTER close() already ran evictAll() — re-inserting a
      // live session (timers, claim loop) into the host cache on a closed
      // server. Evict it on arrival; evictCache is a no-op for uncached ids
      // and never touches durable state, so the next boot restores it.
      if (shouldStop()) providers.engineHost.evictCache(sessionId);
      return session;
    },
  };
  const result = await runBoundedRestore(ids, (id) => restoreOneSession(id, deps), {
    concurrency: BOOT_RESTORE_CONCURRENCY,
    timeoutMs: BOOT_RESTORE_SESSION_TIMEOUT_MS,
    shouldStop,
  });
  console.log(
    `boot restore: restored ${result.restored} sessions with unsettled submissions` +
      (result.failed ? `, ${result.failed} failed` : "") +
      (result.timedOut ? `, ${result.timedOut} timed out (still restoring in the background)` : "") +
      (result.stopped ? " — stopped early for shutdown" : ""),
  );
}

/**
 * Boot the API server. Reads every effective value from `process.env` (a
 * caller such as `valet serve` sets those BEFORE calling), starts listening,
 * and returns a `ServerHandle`. Boot-time reconciliation (session restore,
 * instance-config reconcile, service hosts) continues in a background chain
 * AFTER the listener binds; `GET /api/ready` reports 503 until it completes.
 *
 * This function does NOT register signal handlers — the caller owns process
 * lifecycle (see the direct-entry guard at the bottom of this file, and
 * `cli/commands/serve.ts`). It DOES `process.exit(1)` on fatal
 * misconfiguration: synchronously for pre-bind checks (missing API key,
 * auth-mode conflict, invalid config file), and from the background chain
 * when the instance-config reconcile fails — that exit fires before the
 * ready flip, so in Kubernetes the pod dies NotReady.
 */
export async function startServer(): Promise<ServerHandle> {
const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const dataDir = process.env.VALET_DATA_DIR ?? resolve(homedir(), ".valet");
const databaseUrl = process.env.DATABASE_URL;
const pgDataDir = process.env.VALET_PG_DATA_DIR ?? resolve(dataDir, "pg");
const blobsRoot = process.env.VALET_BLOBS_DIR ?? resolve(dataDir, "blobs");
if (!process.env.VALET_ENCRYPTION_KEY) {
  console.warn("VALET_ENCRYPTION_KEY is unset — using an insecure default. Set it before storing real credentials.");
}
const encryptionKey = process.env.VALET_ENCRYPTION_KEY ?? "dev-key-not-secure";
const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

if (!anthropicApiKey) {
  console.error(
    "ANTHROPIC_API_KEY is required for prompts to run. Set it before starting the server.",
  );
  process.exit(1);
}

// Stub auth next to real auth is a privilege escalation, not a preference:
// the stub identity is an admin, so the ladder's stub rung would answer every
// credential-less request with admin access. Refuse the pair at boot.
const authConflict = authModeConflict(process.env);
if (authConflict) {
  console.error(authConflict);
  process.exit(1);
}

const workflowCrashAt = process.env.WF_CRASH_AT === "terminalizing" ? "terminalizing" : undefined;

// Instance config (`valet.yaml`): load and validate before anything else
// so a misconfigured file fails boot loudly instead of silently degrading.
// Fail-fast: print the message only (no stack spam for config mistakes),
// then exit. `InstanceConfigError` carries a corrective-action message.
let instanceConfig: InstanceConfig | null;
try {
  instanceConfig = loadInstanceConfig(process.env);
} catch (e) {
  if (e instanceof InstanceConfigError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}

// Real auth (auth-v2 design): only wired when BETTER_AUTH_SECRET resolves a
// config. Absent → stub-only mode. Loaded before `buildNodeProviders` so
// `EngineHost` can be constructed with the sandbox JWT master / API base
// URL it needs at session-provision time — not after boot.
const authConfig = loadAuthConfig(process.env);

// Both-set guard + merge for allowedEmailDomains and for the sso team
// mapping. Must run after authConfig is loaded (we need the env-parsed
// values) and after instanceConfig (we need the config-declared ones), and
// before `buildAuth` below, which reads `oidc.teamClaim` to declare the extra
// claim fields the sso plugin passes through. Throws InstanceConfigError with
// the corrective-action message if both sources set the same field.
if (authConfig) {
  try {
    authConfig.allowedEmailDomains = resolveAllowedEmailDomains(
      instanceConfig,
      process.env,
      authConfig.allowedEmailDomains,
    );

    const oidc = authConfig.oidc;
    if (oidc) {
      const mapping = resolveSsoTeamMapping(instanceConfig, process.env, {
        claim: oidc.teamClaim,
        assertedClaim: oidc.teamAssertedClaim,
        adminSubGroup: oidc.teamAdminGroup,
      });
      oidc.teamClaim = mapping.claim;
      oidc.teamAssertedClaim = mapping.assertedClaim;
      oidc.teamAdminGroup = mapping.adminSubGroup;
      // `mapping.groups` is not copied anywhere: the boot reconciler writes
      // `auth.sso.teams.groups` onto the org row, and every reader takes the
      // column (`services/config-reconcile.ts`).
    }
  } catch (e) {
    if (e instanceof InstanceConfigError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

// The URL injected into every sandbox as `VALET_API_URL` (Task 8, auth-v2
// plan) must be reachable FROM the sandbox, which `BETTER_AUTH_URL` is not
// guaranteed to be: in the k8s deployment BETTER_AUTH_URL is the public
// ingress hostname (e.g. https://valet.localdev), which doesn't resolve
// from inside a cluster-internal sandbox pod. `VALET_SANDBOX_API_URL` is a
// dedicated env var for the pod-reachable value — the Helm chart sets it to
// the api Service's in-cluster DNS name (see deploy/chart/valet). Falls
// back to `authConfig.baseUrl` (the pre-existing behavior) when unset, so
// deployments that haven't set the dedicated var yet (or don't need to,
// e.g. sandbox-docker on localhost) keep working unchanged.
const sandboxApiUrl = process.env.VALET_SANDBOX_API_URL ?? authConfig?.baseUrl;

// OTel bootstrap (env-gated: null without an OTLP endpoint). Registered
// BEFORE providers/app construction so the global tracer + context manager
// are live for everything built below — HTTP spans, engine spans, store
// spans all resolve through this one registration.
const telemetry = initTelemetry();
if (telemetry) console.log(`otel: exporting traces to ${telemetry.endpoint}`);

// `buildNodeProviders` can throw `InstanceConfigError` (e.g. the plugins
// both-set guard). Fail boot with the corrective-action message only — no
// stack spam for a config mistake. Rethrow anything else.
let providers: Awaited<ReturnType<typeof buildNodeProviders>>;
try {
  providers = await buildNodeProviders({
    databaseUrl,
    pgDataDir,
    blobsRoot,
    encryptionKey,
    anthropicApiKey,
    apiBaseUrl: `http://127.0.0.1:${port}`,
    workflowCrashAt,
    sandboxJwtMaster: authConfig?.sandboxJwtMaster,
    sandboxApiUrl,
    // Real auth configured → skip seeding the local-dev identity so the
    // "zero users → first signup becomes admin" provisioning rule can fire
    // (see `NodeProviderOpts.seedLocalIdentity`). The stub rung cannot be on
    // here — the boot check above refuses that pair.
    seedLocalIdentity: shouldSeedLocalIdentity(!!authConfig),
    instanceConfig: instanceConfig ?? undefined,
  });
} catch (e) {
  if (e instanceof InstanceConfigError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}

// Attention router (Phase 4 decision 19): subscribes submission_stuck →
// escalation and child-session decision_gate → approval onto the shared
// EventStream. Wired BEFORE the boot-reconciliation passes below — both
// restoreUnsettledSessions and childWatcher.rearm() can themselves emit
// submission_stuck during reconciliation, and a subscriber wired after them
// would miss those boot-time events entirely. Lives for the process; no
// explicit unsubscribe at shutdown needed (the stream itself goes away with
// the process).
wireAttentionRouter({
  db: providers.db,
  engineStore: providers.engineStore,
  eventStream: providers.eventStream,
  channels: [providers.channelHost.attentionDeliverer()],
});

// `authConfig` was loaded above (before `buildNodeProviders`, which needs
// it); wire up the real auth instance now that `providers` exists.
const authWiring: AuthWiring = authConfig
  ? {
      auth: buildAuth({
        db: providers.db,
        cfg: authConfig,
        hooks: buildAuthHooks({
          db: providers.db,
          cfg: authConfig,
          credentialStore: providers.engineCredentials,
          instanceConfig,
          configPath: process.env.VALET_CONFIG,
          sourceService: providers.prebuildService,
        }),
      }),
      authConfig,
    }
  : {};

// Bundled single-binary (`VALET_BUNDLED=1`) → the SPA baked beside the bundle
// at `dist/assets/web`. Dev/tsx → `VALET_WEB_DIST_DIR` (unset in
// `make dev-local`, where Vite's own dev server serves the web app), or the
// baked-in `packages/web/dist` in the legacy docker image. See
// `static-web.ts` and `assets/base.ts`.
const webDistDir = webDistPath();
// Runtime seam: Node (`serve` + `injectWebSocket`) by default, Bun
// (`Bun.serve` + `hono/bun`) inside a `bun --compile` binary. See
// server-adapter.ts.
const adapter = await selectServerAdapter();
// Attachment ref store initialization: start the TTL sweep that cleans up
// expired refs every 60 seconds. The interval is `.unref()`'d inside.
getAttachmentRefStore().startSweep();

// Boot state shared by the readiness route, the background boot chain, and
// `close()`. `closed` lives up here (not next to `close()`) because the
// chain checks it between steps: a shutdown during boot must stop the chain
// from starting more services.
let closed = false;
let bootReady = false;
let rotateSweep: RotateSweepHandle | undefined;
let installationSweep: InstallationSweepHandle | undefined;

// `startServer` from createApp is renamed at the destructure so it can't
// shadow this module's exported `startServer()` (we're inside its body).
// `isReady` includes `!closed`: the chain's ready flip sits several awaits
// past its last `closed` check, so without the conjunction a shutdown racing
// the chain tail could flip /api/ready to 200 on a torn-down server.
const { startServer: startListening, webServed } = createApp(
  providers,
  authWiring,
  { webDistDir, isReady: () => bootReady && !closed },
  adapter,
);
// A set-but-unmounted dist means the bundled image shipped without a valid
// build (missing/incomplete web/dist/index.html) — the api would boot and
// silently 404 JSON at `/` instead of serving the SPA. Fail loud at boot.
if (webDistDir && !webServed) {
  console.error(
    `FATAL: VALET_WEB_DIST_DIR="${webDistDir}" is set but has no index.html — the web build is missing from the image.`,
  );
  process.exit(1);
}

const server = startListening({
  port,
  onListen: (boundPort) => {
    console.log(`@valet/api listening on http://localhost:${boundPort}`);
    console.log(`  data dir: ${dataDir}`);
    console.log(`  db:       ${databaseUrl ? databaseUrl.replace(/:[^:@]*@/, ":***@") : `pglite:${pgDataDir}`}`);
    console.log(`  blobs:    ${blobsRoot}`);
    console.log(
      `  auth:     ${authConfig ? "real (BETTER_AUTH_SECRET set)" : process.env.VALET_LOCAL_AUTH === "1" ? "stub (VALET_LOCAL_AUTH=1)" : "DISABLED — set VALET_LOCAL_AUTH=1 for /api/* access"}`,
    );
    console.log(`  config:   ${process.env.VALET_CONFIG ?? "none (VALET_CONFIG unset)"}`);
    console.log(`  web:      ${webServed ? `serving ${webDistDir}` : "not served (VALET_WEB_DIST_DIR unset — dev mode)"}`);
  },
});

// ── Background boot chain ──────────────────────────────────────────────────
//
// Everything below used to run in front of `startListening`, so `/api/health`
// was unreachable until the LAST awaited step finished. The sha-a6eadbe
// rollout showed why that ordering is fatal: `restoreUnsettledSessions` ran a
// `git fetch` inside a wedged sandbox, boot crossed the 300s startup budget,
// and the kubelet killed the pod before the port ever bound. The invariant
// now: the listener binds within seconds of process start, and boot work
// costs READINESS only (`/api/ready` stays 503, the pod stays NotReady) —
// never liveness. `syncAllAppWebhookUrls` below was already deliberately off
// the port's critical path for exactly this reason; the whole chain now
// follows it.
//
// The chain has two halves around the `bootReady` flip:
//   1. Traffic-protecting steps — session restore, child-watch re-arm, the
//      config reconcile (fail-fast `process.exit(1)`: a bad config dies
//      while still NotReady and never takes traffic), team-sync report.
//   2. Best-effort service starts — channel host, webhook sync, workflow
//      hosts, prebuild, token/installation sweeps. These tolerate failure
//      (logged-and-continue), so readiness does not wait on them: a hanging
//      provider must not stall a rollout for work the pod serves fine
//      without.
//
// `closed` is checked after every await: a shutdown mid-chain must not start
// services that `close()` already swept.
async function runBootChain(): Promise<void> {
  // Eager boot restore: pick up any submissions left unsettled by a prior
  // process. A restore failure must never prevent `serve` — any unexpected
  // rejection is logged and boot continues so a single bad row can't
  // crash-loop the process. Bounded (per-session timeout + concurrency cap in
  // `runBoundedRestore`) so one wedged sandbox exec can't hold readiness
  // forever.
  await restoreUnsettledSessions(providers, () => closed).catch((err) => {
    console.error("boot restore: unexpected failure (continuing to serve):", err);
  });

  if (closed) return;

  // Re-arm every unsettled child_watches row (Phase 4 decision 11) — the
  // restart-mid-child-run survival mechanism. Alongside
  // restoreUnsettledSessions above; a failure here must likewise never block
  // boot.
  await providers.childWatcher.rearm().catch((err) => {
    console.error("boot restore: childWatcher.rearm failed (continuing to serve):", err);
  });

  if (closed) return;

  // Parked-child retention (child_send arc): destroy suspended child
  // sandboxes whose retention window has passed. No-op when retention is
  // off; the interval is unref'd so it never holds the process open.
  providers.childWatcher.startRetentionSweep();

  // Destroys sandboxes hibernated past the retention window (default 72h,
  // VALET_SANDBOX_HIBERNATED_RETENTION_MINUTES).
  providers.hibernationReaper.start();

  // Settled-run sandbox reclaim retry sweep: picks up runs settled while the
  // api was down and on-settle reclaims that failed. The on-settle path
  // itself runs from the `onRunSettled` hook, not this interval.
  providers.workflowSandboxReclaimer.start();

  // Provider-side reconciler: destroys orphaned sandboxes (owning session
  // gone). Sandboxes past VALET_SANDBOX_AGE_REPORT_HOURS are REPORTED, not
  // destroyed (CLAUDE.md: alert, don't auto-repair). No-op on providers
  // without a list() seam (docker/local).
  providers.sandboxReconcileSweep.start();

  // Hibernates idle ACTIVE sessions an api restart evicted from the host
  // cache — the in-memory idle sweep only walks the cache, and the reaper
  // only reaps hibernated rows, so these were stranded with running pods.
  providers.idleHibernationSweep.start();

  // Instance config reconciliation: apply the declarative config to the live
  // database (org name, members, teams, skill sources, etc.). Runs after the
  // restore passes so the db is settled before we write to it, and BEFORE the
  // ready flip so a bad config exits a still-NotReady pod: the rollout
  // crash-loops with the corrective message and traffic never moves. It only
  // needs `prebuildService` as a passive collaborator (`seedDefaultBasesIfMissing`
  // is plain DB writes), so it does not wait for the service starts below.
  if (instanceConfig) {
    // Reconcile can throw `InstanceConfigError` (e.g. org.members would leave
    // no admin, or duplicate skill sources). Exit with the corrective-action
    // message only — no stack spam; an unexpected error exits with its detail.
    // The pre-reorder code rethrew non-InstanceConfigError and relied on the
    // direct-entry guard to exit 1; the chain has no such guard, so both
    // shapes exit here directly — same outcome, done locally.
    try {
      await reconcileInstanceConfig(
        { db: providers.db, configPath: process.env.VALET_CONFIG, sourceService: providers.prebuildService },
        instanceConfig,
      );
    } catch (e) {
      console.error(e instanceof InstanceConfigError ? e.message : `FATAL: instance config reconcile failed: ${e}`);
      process.exit(1);
    }
    // Config rows are inserted pending and due. Poll once here so they do
    // not wait for `skillSync.start()` later in this chain.
    void providers.skillSync.pollOnce();
  }

  if (closed) return;

  // Team mirroring is off unless an operator asks for it, so say once what it
  // will do. This runs AFTER the reconcile above, which is what applies
  // `org.features.ssoTeamSync` from the file. It reads and prints; it never
  // creates an org and never deletes a team.
  {
    const org = await findOrg(providers.db);
    if (org) {
      const features = await getOrgFeatures(providers.db, org.id);
      await reportTeamSyncState(providers.db, {
        orgId: org.id,
        enabled: features.ssoTeamSync,
        ssoConfigured: authConfig?.oidc !== undefined,
        // The column, not the file: the reconcile above already wrote the
        // file's list over it, and Settings edits land here too.
        mirroredGroups: (await getSsoTeamGroups(providers.db, org.id)) ?? [],
        configPath: process.env.VALET_CONFIG,
      });
    }
  }

  if (closed) return;

  // Ready flips here, after the steps that protect traffic (session restore,
  // child-watch re-arm, config reconcile) and BEFORE the best-effort service
  // starts below. Those tolerate failure (logged-and-continue), so gating
  // readiness on them bought no guarantee — but a HANGING one (a webhook
  // registration against a slow provider) would stall every rolling pod's
  // readiness for work the pod serves fine without.
  bootReady = true;
  console.log("boot chain: traffic-critical steps complete — /api/ready now reports ready");

  // Channel ingress (Task 8): resolves credentials into transports, then
  // starts webhook registration or the long-poll loop per transport. A
  // failure here must never block boot — channels are best-effort.
  await providers.channelHost.start().catch((err) => {
    console.error("boot restore: channelHost.start failed (continuing to serve):", err);
  });
  console.log("channel host started");

  // GitHub App webhook URL: point every app this instance OWNS at this
  // instance's public URL. A developer behind an ephemeral tunnel gets a new
  // hostname on every restart, and the URL baked into the app at creation goes
  // stale, so inbound deliveries stop with no error anywhere. Apps supplied
  // through `GITHUB_APP_*` belong to another instance and are never touched —
  // see `syncAppWebhookUrl`'s doc comment for that guard.
  //
  // Deliberately NOT awaited: this makes up to two GitHub round trips, and a
  // slow or unreachable GitHub must not hold up the chain. The function
  // swallows every failure, so the floating promise cannot reject.
  void syncAllAppWebhookUrls(
    { db: providers.db, credentials: providers.engineCredentials },
    publicUrlFromEnv(process.env),
  );

  if (closed) return;

  // Workflow run host (Phase 5 plan Task 10): begin the poll + lost-wake-sweep
  // loops so pending/parked runs left over from a prior process pick back up.
  providers.workflowRunHost.startHost();

  // Workflow schedule loop: fire cron schedules that came due (including at
  // most one catch-up per schedule for fires missed while down).
  providers.workflowScheduler.start();

  // Event dispatcher (event-system plan Task 6): begin the delivery drain loop
  // so pending/failed event_deliveries left over from a prior process (and
  // freshly-ingested ones between nudges) get delivered.
  providers.eventDispatcher.start();

  // Skill-repository sync (agent-skills design): begin the sweep that re-reads
  // every tracked repository on its own schedule, and imports any source added
  // while this process was down.
  providers.skillSync.start();

  // Prebuild orchestration (sandbox images v2 plan, Task 3): sweep any
  // queued/building rows orphaned by a prior process crash/restart, then begin
  // the 10s build-status poll + 10min nightly-scheduler intervals. A no-op
  // backend (`imageBuilder: null`) still starts harmlessly — every pass
  // short-circuits.
  await providers.prebuildService.start().catch((err) => {
    console.error("prebuildService.start failed:", err);
  });

  // LLM proxy env-key bootstrap (llm-recording-gateway plan, Task 8): for each
  // provider kind, if the env key is set and the org has no configured
  // provider, seed one named `env:{kind}` so the recording proxy works with
  // zero setup. Idempotent; a failure must never block boot.
  await ensureEnvProviders(providers.db, providers.engineCredentials, await resolveOrgId(providers.db)).catch((err) => {
    console.error("ensureEnvProviders failed (continuing to serve):", err);
  });

  if (closed) return;

  // Hourly sandbox-token rotation (sandbox-reconciliation plan, Task 12):
  // re-mints tokens for long-running sandboxes whose initial token is > 12 h
  // old, pushing the fresh token via `SandboxProvider.updateCreds` into the
  // live /etc/valet/creds/ mount. A no-op when the provider does not report
  // `credsMount` (docker dev, local). The interval is `.unref()`'d inside
  // `startRotateSweep` so it never prevents process exit on its own.
  rotateSweep = startRotateSweep({
    host: providers.engineHost,
    provider: providers.sandboxProvider,
    db: providers.db,
  });

  // GitHub App installations: pick up a new installation without anybody
  // pressing "Refresh installations". The tick wakes every minute and checks at
  // most one org that is past its own due time, so most ticks do nothing. An
  // instance with no public URL receives no `installation` webhooks, which is
  // why this cannot be webhook-only. The interval is `.unref()`'d inside
  // `startInstallationSweep`, so it never prevents process exit on its own.
  installationSweep = startInstallationSweep({
    db: providers.db,
    credentials: providers.engineCredentials,
    key: deriveSecretKey(encryptionKey),
    publicUrl: publicUrlFromEnv(process.env),
  });
}

// Kick the chain off the listener's critical path. An unexpected rejection
// exits the process (unless a shutdown caused it): the pre-reorder code ran
// these steps inside startServer, where a throw reached the caller's FATAL
// handler and exited 1 — and on Kubernetes that exit IS the retry, because
// the pod restarts and reruns the chain. Logging-and-parking instead would
// strand a single-replica install NotReady forever on a transient DB blip,
// with liveness green and nothing restarting it.
void runBootChain().catch((err) => {
  if (closed) {
    console.error("boot chain: failed during shutdown (ignored):", err);
    return;
  }
  console.error("FATAL: boot chain failed before completing — exiting for a clean retry:", err);
  process.exit(1);
});

// ── Graceful shutdown — evict live sandboxes so containers don't leak. This
// does NOT call process.exit: the caller (direct-entry guard below, or the
// serve command) owns process lifecycle. Idempotent so repeated close() /
// double signals are harmless.

async function close(): Promise<void> {
  if (closed) return;
  // Also read by the boot chain between steps: services not yet started
  // after this point stay unstarted, so the stops below can meet a service
  // that never ran — each one tolerates that.
  closed = true;
  try {
    providers.workflowScheduler.stop();
  } catch (err) {
    console.error("workflowScheduler.stop failed:", err);
  }
  try {
    await providers.workflowRunHost.stopHost();
  } catch (err) {
    console.error("workflowRunHost.stopHost failed:", err);
  }
  try {
    await providers.eventDispatcher.stop();
  } catch (err) {
    console.error("eventDispatcher.stop failed:", err);
  }
  try {
    await providers.skillSync.stop();
  } catch (err) {
    console.error("skillSync.stop failed:", err);
  }
  try {
    providers.prebuildService.stop();
  } catch (err) {
    console.error("prebuildService.stop failed:", err);
  }
  try {
    rotateSweep?.stop();
  } catch (err) {
    console.error("rotateSweep.stop failed:", err);
  }
  try {
    // Awaited, unlike the sweeps above it: a pass in flight holds a database
    // query open, and closing the store under it logs errors that look like
    // real failures during every shutdown.
    await installationSweep?.stop();
  } catch (err) {
    console.error("installationSweep.stop failed:", err);
  }
  try {
    providers.childWatcher.stopRetentionSweep();
  } catch (err) {
    console.error("childWatcher.stopRetentionSweep failed:", err);
  }
  try {
    providers.hibernationReaper.stop();
  } catch (err) {
    console.error("hibernationReaper.stop failed:", err);
  }
  try {
    providers.workflowSandboxReclaimer.stop();
  } catch (err) {
    console.error("workflowSandboxReclaimer.stop failed:", err);
  }
  try {
    providers.sandboxReconcileSweep.stop();
  } catch (err) {
    console.error("sandboxReconcileSweep.stop failed:", err);
  }
  try {
    providers.idleHibernationSweep.stop();
  } catch (err) {
    console.error("idleHibernationSweep.stop failed:", err);
  }
  try {
    await providers.channelHost.stop();
  } catch (err) {
    console.error("channelHost.stop failed:", err);
  }
  try {
    // Evict, never destroy: Session.destroy() deletes the session's durable
    // rows (threads, queue items, transcript). Shutdown must leave the store
    // intact so boot-time reconciliation can resume unsettled work — the
    // same contract the kill-mid-turn tests prove for SIGKILL.
    providers.engineHost.evictAll();
  } catch (err) {
    console.error("evictAll failed:", err);
  }
  try {
    // Flush any batched spans before the process goes away.
    await telemetry?.shutdown();
  } catch (err) {
    console.error("otel shutdown failed:", err);
  }
  await server.close();
}

// Last-resort guards. A single bad request must not take down the server
// and break every other live session. Real fixes belong in the route or WS
// handler that's swallowing the error; these are belt-and-braces so the dev
// experience doesn't get whiplashed when one slips through.
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});

  return { close, port, backend: parseSandboxBackend(process.env.VALET_SANDBOX_BACKEND) };
}

/**
 * Wire SIGINT/SIGTERM to a graceful shutdown that exits the process. Shared by
 * the direct-entry boot below; the serve command wires its own handler so it
 * can also clean up its pidfile.
 */
function installSignalShutdown(handle: ServerHandle): void {
  const onSignal = (signal: NodeJS.Signals) => {
    console.log(`\nReceived ${signal}, shutting down (sessions evicted, durable state kept)...`);
    void handle.close().finally(() => process.exit(0));
    // Hard-exit if close() takes too long (containers can be slow to stop).
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
}

// Direct-entry boot: `tsx src/main.ts` (dev / the workflow-run e2e harness).
// Guarded so `import`-ing this module never boots — the bundle's entry is
// `cli.ts`, where every module shares the bundle's `import.meta.url`; the
// `/main.` check keeps this false there (serve() drives the boot in the
// bundle), true only when main.ts is itself the script being run.
const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryHref && /\/main\.(ts|js|mjs)$/.test(import.meta.url)) {
  // A boot rejection (e.g. `loadAuthConfig` on a half-configured provider)
  // carries the corrective action in its message. Print that message and
  // exit 1 — an unhandled rejection buries it under a stack trace.
  try {
    const handle = await startServer();
    installSignalShutdown(handle);
  } catch (err) {
    console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
