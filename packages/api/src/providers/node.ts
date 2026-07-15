import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildSpawner, Principal, ValetPlugin } from "@valet/engine";
import { DockerSandboxProvider } from "@valet/sandbox-docker";
import { SqliteSessionStore, SqliteEventStream, applyEngineMigrations } from "@valet/store-sqlite";
import { createDefaultNodeExecutors, LocalRunHost, type OnApprovalPending } from "@valet/workflow";
import { applyAppMigrations, buildAppDb, type AppDb } from "../lib/drizzle.js";
import { orgMembers, orgs, users } from "../schema/index.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { EngineHost } from "../engine/host.js";
import { buildChildSpawner, ChildWatcher } from "../orchestrator/children.js";
import { routeAttention } from "../orchestrator/attention.js";
import { SqliteCredentialStore } from "../plugins/credential-store.js";
import { assemblePlugins } from "../plugins/assemble.js";
import { loadNodeModulesPlugins } from "../plugins/node-modules-loader.js";
import { bundledPlugins } from "../plugins/registry.gen.js";
import { SqliteWorkflowStore } from "../workflows/sqlite-store.js";
import { buildWorkflowEngineDeps } from "../workflows/engine-deps.js";
import { FsBlobStore } from "./blob-fs.js";
import type { Providers } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/api/src/providers -> packages/api
const apiPkgRoot = resolve(__dirname, "../..");
// packages/api -> repo root
const repoRoot = resolve(apiPkgRoot, "../..");

/**
 * Parses the `VALET_PLUGINS` env var: `allow:pkg1,pkg2` / `deny:pkg1` /
 * unset (no filtering). Format mirrors what the node_modules loader's
 * `allowlist`/`denylist` options expect.
 */
export function parseValetPluginsEnv(
  value: string | undefined,
): { allowlist?: string[]; denylist?: string[] } {
  if (!value) return {};
  const [mode, rest] = value.split(":", 2);
  const names = (rest ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (mode === "allow") return { allowlist: names };
  if (mode === "deny") return { denylist: names };
  return {};
}

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
  /**
   * Test-only override for the assembled plugin set. When provided, no
   * node_modules scan runs and `assemblePlugins` is called with only this
   * one source: `assemblePlugins([[...plugins]])`. When absent (the normal
   * boot path), plugins are `assemblePlugins([bundledPlugins,
   * nodeModulesResult.plugins])`.
   */
  plugins?: ValetPlugin[];
  /**
   * Forwarded to `EngineHost.sandboxJwtMaster` (Task 8, auth-v2 plan) —
   * `AuthConfig.sandboxJwtMaster` when real auth is configured, else
   * undefined (the host falls back to `internalToken()`).
   */
  sandboxJwtMaster?: string;
  /**
   * Forwarded to `EngineHost.sandboxApiUrl` (Task 8, auth-v2 plan) —
   * `AuthConfig.baseUrl` when real auth is configured, else undefined (the
   * host falls back to the local dev default).
   */
  sandboxApiUrl?: string;
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

  // Two Drizzle handles: one for the app schema, one for the engine schema.
  // Same connection underneath; Drizzle's per-handle config is local.
  const db = buildAppDb(sqlite);
  const engineDb = drizzle(sqlite);

  // Seed the local-dev identity. Idempotent.
  const now = Date.now();
  db.insert(orgs).values({ id: LOCAL_ORG.id, name: LOCAL_ORG.name, createdAt: now }).onConflictDoNothing().run();
  db.insert(users)
    .values({ id: LOCAL_USER.id, email: LOCAL_USER.email, name: LOCAL_USER.name, role: LOCAL_USER.role })
    .onConflictDoNothing()
    .run();
  db.insert(orgMembers)
    .values({ orgId: LOCAL_ORG.id, userId: LOCAL_USER.id, role: "admin", createdAt: now })
    .onConflictDoNothing()
    .run();

  const engineStore = new SqliteSessionStore(engineDb);
  const blobs = new FsBlobStore(opts.blobsRoot);
  const sandboxProvider = new DockerSandboxProvider();
  // Durable event log over the same better-sqlite3 handle the store uses.
  const eventStream = new SqliteEventStream(sqlite);
  // `AppDb`'s drizzle-orm version doesn't declare `$client` in its public
  // type even though the runtime instance always carries it (same cast
  // `workflowStore` below uses) — bridging a library type gap, not a real
  // type mismatch.
  const engineCredentials = new SqliteCredentialStore(
    db as AppDb & { $client: Database.Database },
    deriveSecretKey(opts.encryptionKey),
  );

  // Plugin loading (plugin-system-v2 plan Task 4): tests supply `opts.plugins`
  // directly and skip the node_modules scan entirely; the normal boot path
  // assembles the bundled registry with whatever's discovered on disk.
  const { allowlist, denylist } = parseValetPluginsEnv(process.env.VALET_PLUGINS);
  const { plugins, actionPluginByService } = opts.plugins
    ? assemblePlugins([[...opts.plugins]])
    : assemblePlugins([
        bundledPlugins,
        (
          await loadNodeModulesPlugins({
            searchPaths: [resolve(apiPkgRoot, "node_modules"), resolve(repoRoot, "node_modules")],
            allowlist,
            denylist,
          })
        ).plugins,
      ]);

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
    sandboxJwtMaster: opts.sandboxJwtMaster,
    sandboxApiUrl: opts.sandboxApiUrl,
    plugins,
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
  const workflowEngineDeps = buildWorkflowEngineDeps({
    host: engineHost,
    store: workflowStore,
    db,
    engineStore,
    actionPluginByService,
    credentials: engineCredentials,
  });

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
    plugins,
    actionPluginByService,
  };
}
