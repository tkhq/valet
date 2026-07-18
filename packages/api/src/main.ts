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
import { buildNodeProviders } from "./providers/node.js";
import { parseSandboxBackend } from "./providers/sandbox-backend.js";
import { agentSessions } from "./schema/index.js";
import { loadSessionMeta } from "./engine/session-meta.js";
import type { Providers } from "./providers/types.js";
import { loadAuthConfig } from "./auth/config.js";
import { buildAuthHooks } from "./auth/provisioning.js";
import { buildAuth } from "./auth/index.js";
import { wireAttentionRouter } from "./orchestrator/attention-wiring.js";
import { ensureWorkflowSession } from "./workflows/engine-deps.js";
import { restoreOneSession, type RestoreSessionDeps } from "./boot-restore.js";
import { webDistPath } from "./assets/base.js";

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

/**
 * Eager restore of sessions with unsettled submissions. On boot the store may
 * hold in-flight submissions from a previous process; materializing their
 * engine sessions lets the claim loop pick the work back up. Per-session
 * failures are isolated so one bad row can't stall the rest of the boot.
 */
async function restoreUnsettledSessions(providers: Providers): Promise<void> {
  let restored = 0;
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
    sessionFor: (sessionId, meta) => providers.engineHost.sessionFor(sessionId, meta),
  };
  for (const id of ids) {
    try {
      await restoreOneSession(id, deps);
      restored++;
    } catch (err) {
      console.error(`boot restore: failed to restore session ${id}:`, err);
    }
  }
  console.log(`boot restore: restored ${restored} sessions with unsettled submissions`);
}

/**
 * Boot the API server. Reads every effective value from `process.env` (a
 * caller such as `valet serve` sets those BEFORE calling), starts listening,
 * runs boot-time reconciliation, and returns a `ServerHandle`.
 *
 * This function does NOT register signal handlers or call `process.exit` — the
 * caller owns process lifecycle (see the direct-entry guard at the bottom of
 * this file, and `cli/commands/serve.ts`).
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

const workflowCrashAt = process.env.WF_CRASH_AT === "terminalizing" ? "terminalizing" : undefined;

// Real auth (auth-v2 design): only wired when BETTER_AUTH_SECRET resolves a
// config. Absent → stub-only mode. Loaded before `buildNodeProviders` so
// `EngineHost` can be constructed with the sandbox JWT master / API base
// URL it needs at session-provision time — not after boot.
const authConfig = loadAuthConfig(process.env);

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

const providers = await buildNodeProviders({
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
  // (see `NodeProviderOpts.seedLocalIdentity`).
  seedLocalIdentity: !authConfig,
});

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

// Eager boot restore: pick up any submissions left unsettled by a prior
// process before we start accepting connections. A restore failure must
// never prevent `serve` — any unexpected rejection is logged and boot
// continues so a single bad row can't crash-loop the process.
await restoreUnsettledSessions(providers).catch((err) => {
  console.error("boot restore: unexpected failure (continuing to serve):", err);
});

// Re-arm every unsettled child_watches row (Phase 4 decision 11) — the
// restart-mid-child-run survival mechanism. Alongside restoreUnsettledSessions
// above; a failure here must likewise never block boot.
await providers.childWatcher.rearm().catch((err) => {
  console.error("boot restore: childWatcher.rearm failed (continuing to serve):", err);
});

// Channel ingress (Task 8): resolves credentials into transports, then
// starts webhook registration or the long-poll loop per transport. A
// failure here must never block boot — channels are best-effort.
await providers.channelHost.start().catch((err) => {
  console.error("boot restore: channelHost.start failed (continuing to serve):", err);
});
console.log("channel host started");

// Workflow run host (Phase 5 plan Task 10): begin the poll + lost-wake-sweep
// loops so pending/parked runs left over from a prior process pick back up.
providers.workflowRunHost.startHost();

// Prebuild orchestration (sandbox images v2 plan, Task 3): sweep any
// queued/building rows orphaned by a prior process crash/restart, then begin
// the 10s build-status poll + 10min nightly-scheduler intervals. A no-op
// backend (`imageBuilder: null`) still starts harmlessly — every pass
// short-circuits.
await providers.prebuildService.start().catch((err) => {
  console.error("prebuildService.start failed:", err);
});

// `authConfig` was loaded above (before `buildNodeProviders`, which needs
// it); wire up the real auth instance now that `providers` exists.
const authWiring: AuthWiring = authConfig
  ? {
      auth: buildAuth({
        db: providers.db,
        cfg: authConfig,
        hooks: buildAuthHooks({ db: providers.db, cfg: authConfig, credentialStore: providers.engineCredentials }),
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
const { app, startServer, webServed } = createApp(providers, authWiring, { webDistDir }, adapter);
// A set-but-unmounted dist means the bundled image shipped without a valid
// build (missing/incomplete web/dist/index.html) — the api would boot and
// silently 404 JSON at `/` instead of serving the SPA. Fail loud at boot.
if (webDistDir && !webServed) {
  console.error(
    `FATAL: VALET_WEB_DIST_DIR="${webDistDir}" is set but has no index.html — the web build is missing from the image.`,
  );
  process.exit(1);
}

const server = startServer({
  port,
  onListen: (boundPort) => {
    console.log(`@valet/api listening on http://localhost:${boundPort}`);
    console.log(`  data dir: ${dataDir}`);
    console.log(`  db:       ${databaseUrl ? databaseUrl.replace(/:[^:@]*@/, ":***@") : `pglite:${pgDataDir}`}`);
    console.log(`  blobs:    ${blobsRoot}`);
    console.log(
      `  auth:     ${authConfig ? "real (BETTER_AUTH_SECRET set)" : process.env.VALET_LOCAL_AUTH === "1" ? "stub (VALET_LOCAL_AUTH=1)" : "DISABLED — set VALET_LOCAL_AUTH=1 for /api/* access"}`,
    );
    console.log(`  web:      ${webServed ? `serving ${webDistDir}` : "not served (VALET_WEB_DIST_DIR unset — dev mode)"}`);
  },
});

// ── Graceful shutdown — evict live sandboxes so containers don't leak. This
// does NOT call process.exit: the caller (direct-entry guard below, or the
// serve command) owns process lifecycle. Idempotent so repeated close() /
// double signals are harmless.

let closed = false;
async function close(): Promise<void> {
  if (closed) return;
  closed = true;
  try {
    await providers.workflowRunHost.stopHost();
  } catch (err) {
    console.error("workflowRunHost.stopHost failed:", err);
  }
  try {
    providers.prebuildService.stop();
  } catch (err) {
    console.error("prebuildService.stop failed:", err);
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
  const handle = await startServer();
  installSignalShutdown(handle);
}
