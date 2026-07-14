import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { InMemoryCredentialStore, type ChildSpawner, type Principal } from "@valet/engine";
import { DockerSandboxProvider } from "@valet/sandbox-docker";
import { SqliteSessionStore, SqliteEventStream, applyEngineMigrations } from "@valet/store-sqlite";
import { createDefaultNodeExecutors, LocalRunHost, type OnApprovalPending } from "@valet/workflow";
import { applyAppMigrations, buildAppDb, type AppDb } from "../lib/drizzle.js";
import { EngineHost } from "../engine/host.js";
import { buildChildSpawner, ChildWatcher } from "../orchestrator/children.js";
import { routeAttention } from "../orchestrator/attention.js";
import { SqliteWorkflowStore } from "../workflows/sqlite-store.js";
import { buildWorkflowEngineDeps } from "../workflows/engine-deps.js";
import { FsBlobStore } from "./blob-fs.js";
import type { Providers } from "./types.js";

export interface NodeProviderOpts {
  /** Path to the sqlite file holding both app + engine schemas. */
  dbPath: string;
  /** Directory root for the filesystem-backed blob store. */
  blobsRoot: string;
  /** Encryption key used by helpers that store sensitive data. */
  encryptionKey: string;
  /**
   * Anthropic API key for the engine's LLM calls. Required for prompts to
   * actually run; leave undefined for read-only routes.
   */
  anthropicApiKey?: string;
  /**
   * This process's own base URL, handed to `EngineHost` for orchestrator
   * sessions' `toolConfig.apiBaseUrl` (Phase 4 decision 15/17). Required
   * for `orchestratorSessionFor`; regular sessions don't need it.
   */
  apiBaseUrl?: string;
  /**
   * Test-only crash-point hook for `LocalRunHost` (Phase 5 plan decision
   * 20), sourced from `WF_CRASH_AT` in `main.ts`. When `'terminalizing'`,
   * the host calls `process.exit(137)` right after `beginTerminalize`.
   */
  workflowCrashAt?: "terminalizing";
}

export const LOCAL_USER = {
  id: "local-user",
  email: "local@dev",
  name: "Local Dev",
  role: "admin" as const,
};

export const LOCAL_ORG = {
  id: "local-org",
  name: "Local Dev",
};

/**
 * Open the sqlite database, run app + engine migrations, seed the local
 * dev identity, and construct every provider the API + engine need.
 *
 * The same sqlite file holds both schemas — table names don't collide
 * (`engine_*` vs application names) so they coexist cleanly.
 */
export async function buildNodeProviders(opts: NodeProviderOpts): Promise<Providers> {
  mkdirSync(dirname(opts.dbPath), { recursive: true });
  mkdirSync(opts.blobsRoot, { recursive: true });

  const sqlite = new Database(opts.dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  applyAppMigrations(sqlite);
  applyEngineMigrations(sqlite);

  // Seed the local-dev identity. Idempotent.
  const now = Date.now();
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO orgs (id, name, created_at) VALUES (?, ?, ?)",
    )
    .run(LOCAL_ORG.id, LOCAL_ORG.name, now);
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(LOCAL_USER.id, LOCAL_USER.email, LOCAL_USER.name, LOCAL_USER.role, now);
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)",
    )
    .run(LOCAL_ORG.id, LOCAL_USER.id, "admin");

  // Two Drizzle handles: one for the app schema, one for the engine schema.
  // Same connection underneath; Drizzle's per-handle config is local.
  const db = buildAppDb(sqlite);
  const engineDb = drizzle(sqlite);

  const engineStore = new SqliteSessionStore(engineDb);
  const blobs = new FsBlobStore(opts.blobsRoot);
  const sandboxProvider = new DockerSandboxProvider();
  // Durable event log over the same better-sqlite3 handle the store uses.
  const eventStream = new SqliteEventStream(sqlite);
  const engineCredentials = new InMemoryCredentialStore();

  // Circular construction: EngineHost needs the ChildSpawner at construction
  // time (it's baked into every orchestrator session's toolConfig), but the
  // spawner itself needs the EngineHost (to create the child session) and
  // the ChildWatcher (to arm settlement watching). Break the cycle with a
  // one-slot indirection — `spawnerRef` is filled in immediately after
  // `engineHost` exists, before any orchestrator session can actually wake
  // and try to call `task`.
  let spawnerRef: ChildSpawner | undefined;
  const engineHost = new EngineHost({
    engineStore,
    sandboxProvider,
    eventStream,
    engineCredentials,
    blobs,
    anthropicApiKey: opts.anthropicApiKey,
    db,
    apiBaseUrl: opts.apiBaseUrl,
    childSpawner: (req, ctx) => {
      if (!spawnerRef) throw new Error("childSpawner invoked before provider wiring completed");
      return spawnerRef(req, ctx);
    },
  });

  const childWatcher = new ChildWatcher({ db, engineHost, engineStore });
  spawnerRef = buildChildSpawner({ db, engineHost, engineStore }, childWatcher);

  // Workflow run host (Phase 5 plan Task 10). `workflowStore` is the same
  // `WorkflowStore` port `buildWorkflowEngineDeps`'s session executors and
  // the routes both read/write through — one instance per process, backed
  // by the same sqlite handle as everything else.
  //
  // `AppDb`'s drizzle-orm version doesn't declare `$client` in its public
  // type even though the runtime instance always carries it (same cast
  // `sqlite-store.test.ts` uses) — bridging a library type gap, not a real
  // type mismatch.
  const workflowStore = new SqliteWorkflowStore(db as AppDb & { $client: Database.Database });
  const workflowEngineDeps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore });

  // Approval attention (decision 12): the FIRST park on an approval node
  // routes through the Phase 4 notification system. `onApprovalPending`
  // only receives `{runId, nodeId, prompt, summary?, details?}` — no owner
  // — so it re-resolves the run's owner from the store itself.
  const onApprovalPending: OnApprovalPending = async (info) => {
    // Contained: the executor awaits this AFTER persisting the approval
    // intent, so a throw here would abort the drive AND permanently skip the
    // notification on the re-drive (intent already exists). A lost
    // notification must degrade to log-only — the run stays resolvable via
    // the API either way.
    try {
      const run = await workflowStore.getRun(info.runId);
      if (!run?.owner) return; // no recorded owner: nothing to notify
      const owner: Principal = { type: run.owner.ownerType as Principal["type"], id: run.owner.ownerId };
      await routeAttention(
        { db },
        {
          kind: "approval",
          owner,
          title: info.summary ?? info.prompt,
          body: info.summary ? info.prompt : undefined,
          href: `/workflows/runs/${info.runId}`,
          dedupeKey: `${info.runId}:${info.nodeId}`,
        },
      );
    } catch (err) {
      console.error(`workflow approval notification failed for ${info.runId}:${info.nodeId}`, err);
    }
  };

  const workflowRunHost = new LocalRunHost({
    store: workflowStore,
    engine: workflowEngineDeps,
    executors: createDefaultNodeExecutors(),
    onApprovalPending,
    crashAt: opts.workflowCrashAt,
  });

  return {
    db,
    blobs,
    encryptionKey: opts.encryptionKey,
    engineStore,
    sandboxProvider,
    eventStream,
    engineCredentials,
    engineHost,
    childWatcher,
    workflowStore,
    workflowRunHost,
  };
}
