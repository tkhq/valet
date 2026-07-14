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
import { createApp } from "./app.js";
import { buildNodeProviders } from "./providers/node.js";
import { agentSessions } from "./schema/index.js";
import type { Providers } from "./providers/types.js";
import { wireAttentionRouter } from "./orchestrator/attention-wiring.js";

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
  for (const id of ids) {
    try {
      // Keep the per-session app-row lookup INSIDE the try: a lookup that
      // rejects (bad row, transient store error) must isolate to this one
      // session, not abort the whole restore pass and crash-loop boot.
      const row = await providers.db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, id))
        .get();
      if (!row) {
        console.warn(`boot restore: skipping ${id} — no app session row`);
        continue;
      }
      await providers.engineHost.sessionFor(id, {
        userId: row.userId,
        orgId: row.orgId,
        workspace: row.workspace,
      });
      restored++;
    } catch (err) {
      console.error(`boot restore: failed to restore session ${id}:`, err);
    }
  }
  console.log(`boot restore: restored ${restored} sessions with unsettled submissions`);
}

const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const dataDir = process.env.VALET_DATA_DIR ?? resolve(homedir(), ".valet");
const dbPath = process.env.VALET_DB_PATH ?? resolve(dataDir, "app.db");
const blobsRoot = process.env.VALET_BLOBS_DIR ?? resolve(dataDir, "blobs");
const encryptionKey = process.env.VALET_ENCRYPTION_KEY ?? "dev-key-not-secure";
const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

if (!anthropicApiKey) {
  console.error(
    "ANTHROPIC_API_KEY is required for prompts to run. Set it before starting the server.",
  );
  process.exit(1);
}

const workflowCrashAt = process.env.WF_CRASH_AT === "terminalizing" ? "terminalizing" : undefined;

const providers = await buildNodeProviders({
  dbPath,
  blobsRoot,
  encryptionKey,
  anthropicApiKey,
  apiBaseUrl: `http://127.0.0.1:${port}`,
  workflowCrashAt,
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

const { app, injectWebSocket } = createApp(providers);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`@valet/api listening on http://localhost:${info.port}`);
  console.log(`  data dir: ${dataDir}`);
  console.log(`  db:       ${dbPath}`);
  console.log(`  blobs:    ${blobsRoot}`);
  console.log(
    `  auth:     ${process.env.VALET_LOCAL_AUTH === "1" ? "stub (VALET_LOCAL_AUTH=1)" : "DISABLED — set VALET_LOCAL_AUTH=1 for /api/* access"}`,
  );
});

// Attach the WS upgrade handler to the running http server.
injectWebSocket(server);

// ── Graceful shutdown — destroy live sandboxes so containers don't leak.

async function shutdown(signal: NodeJS.Signals) {
  console.log(`\nReceived ${signal}, destroying live sandboxes...`);
  try {
    await providers.workflowRunHost.stopHost();
  } catch (err) {
    console.error("workflowRunHost.stopHost failed:", err);
  }
  try {
    await providers.engineHost.destroyAll();
  } catch (err) {
    console.error("destroyAll failed:", err);
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
