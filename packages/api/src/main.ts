/**
 * Node entry point.
 *
 *   ANTHROPIC_API_KEY=sk-... VALET_LOCAL_AUTH=1 pnpm --filter @valet/api dev
 *
 * Boots the API on PORT (default 8787). Exits non-zero with a clear message
 * if required env vars are missing.
 */
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createApp, type AuthWiring } from "./app.js";
import { buildNodeProviders } from "./providers/node.js";
import { agentSessions } from "./schema/index.js";
import type { Providers } from "./providers/types.js";
import { loadAuthConfig } from "./auth/config.js";
import { buildAuthHooks } from "./auth/provisioning.js";
import { buildAuth } from "./auth/index.js";
import { wireAttentionRouter } from "./orchestrator/attention-wiring.js";
import { ensureWorkflowSession } from "./workflows/engine-deps.js";
import { restoreOneSession, type RestoreSessionDeps } from "./boot-restore.js";

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
      return row ? { userId: row.userId, orgId: row.orgId, workspace: row.workspace } : undefined;
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

const providers = await buildNodeProviders({
  databaseUrl,
  pgDataDir,
  blobsRoot,
  encryptionKey,
  anthropicApiKey,
  apiBaseUrl: `http://127.0.0.1:${port}`,
  workflowCrashAt,
  sandboxJwtMaster: authConfig?.sandboxJwtMaster,
  sandboxApiUrl: authConfig?.baseUrl,
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

// Workflow run host (Phase 5 plan Task 10): begin the poll + lost-wake-sweep
// loops so pending/parked runs left over from a prior process pick back up.
providers.workflowRunHost.startHost();

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

// Bundled production image only (docker/Dockerfile.api sets this to the
// baked-in `packages/web/dist`) — unset in `make dev-local`, where Vite's
// own dev server serves the web app. See `static-web.ts`.
const webDistDir = process.env.VALET_WEB_DIST_DIR;
const { app, injectWebSocket } = createApp(providers, authWiring, { webDistDir });

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`@valet/api listening on http://localhost:${info.port}`);
  console.log(`  data dir: ${dataDir}`);
  console.log(`  db:       ${databaseUrl ? databaseUrl.replace(/:[^:@]*@/, ":***@") : `pglite:${pgDataDir}`}`);
  console.log(`  blobs:    ${blobsRoot}`);
  console.log(
    `  auth:     ${authConfig ? "real (BETTER_AUTH_SECRET set)" : process.env.VALET_LOCAL_AUTH === "1" ? "stub (VALET_LOCAL_AUTH=1)" : "DISABLED — set VALET_LOCAL_AUTH=1 for /api/* access"}`,
  );
  console.log(`  web:      ${webDistDir ? `serving ${webDistDir}` : "not served (VALET_WEB_DIST_DIR unset — dev mode)"}`);
});

// Attach the WS upgrade handler to the running http server.
injectWebSocket(server);

// ── Graceful shutdown — destroy live sandboxes so containers don't leak.

async function shutdown(signal: NodeJS.Signals) {
  console.log(`\nReceived ${signal}, shutting down (sessions evicted, durable state kept)...`);
  try {
    await providers.workflowRunHost.stopHost();
  } catch (err) {
    console.error("workflowRunHost.stopHost failed:", err);
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
  server.close(() => process.exit(0));
  // Hard-exit if close() takes too long (containers can be slow to stop).
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

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
