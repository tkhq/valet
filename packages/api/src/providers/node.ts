import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildSpawner, Principal, ValetPlugin } from "@valet/engine";
import { PgSessionStore, PgEventStream, applyEngineMigrations } from "@valet/store-postgres";
import { createDefaultNodeExecutors, LocalRunHost, type OnApprovalPending } from "@valet/workflow";
import { applyAppMigrations, buildAppDb, buildAppQueryable } from "../lib/drizzle.js";
import { orgMembers, orgs, users } from "../schema/index.js";
import { EngineHost } from "../engine/host.js";
import { buildHibernationHooks } from "../engine/hibernation-hooks.js";
import { buildChildSpawner, ChildWatcher } from "../orchestrator/children.js";
import { routeAttention } from "../orchestrator/attention.js";
import { assemblePlugins } from "../plugins/assemble.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { OAuthRefreshingCredentialStore } from "../plugins/oauth-refreshing-credential-store.js";
import { DynamicToolCounts } from "../plugins/dynamic-tool-count.js";
import { loadNodeModulesPlugins } from "../plugins/node-modules-loader.js";
import { bundledPlugins } from "../plugins/registry.gen.js";
import { buildWorkflowEngineDeps } from "../workflows/engine-deps.js";
import { PgWorkflowStore } from "../workflows/pg-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { resolveOrgId } from "../lib/org.js";
import { ChannelHost, publicUrlFromEnv } from "../channels/host.js";
import { FsBlobStore } from "./blob-fs.js";
import { pgliteWasmOptions } from "../assets/base.js";
import { buildSandboxProvider, resolveDefaultImage, resolveIdleMinutes } from "./sandbox-backend.js";
import { resolveImageBuilder, resolvePrebuildPreflight } from "./image-builder.js";
import { PrebuildService } from "../prebuilds/service.js";
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
  /**
   * Postgres connection string. Set (typically `DATABASE_URL`) → connects
   * via `pg.Pool`. Unset → boots an embedded PGlite instance at `pgDataDir`
   * instead (spec decision 4's dev/test default).
   */
  databaseUrl?: string;
  /**
   * Directory backing the embedded PGlite instance when `databaseUrl` is
   * unset. Ignored when `databaseUrl` is set.
   */
  pgDataDir: string;
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
  /**
   * Seed the `local-user`/`local-org` stub identity (default `true`, for
   * backward compat with every existing stub-mode caller/test). Must be
   * `false` whenever real auth is configured (`BETTER_AUTH_SECRET` set):
   * `evaluateAdmission`'s "zero users → first signup becomes admin" rule
   * (`auth/provisioning.ts`) never fires if a local user is pre-seeded, so a
   * fresh real deployment could never mint its first admin and every real
   * signup would land in the seeded "Local Dev" org.
   */
  seedLocalIdentity?: boolean;
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
 * Open the Postgres connection (pool or embedded PGlite), run app + engine
 * migrations, seed the local dev identity, and construct every provider the
 * API + engine need.
 *
 * One connection source backs both schemas — table names don't collide
 * (`engine_*` vs application names) so they coexist in one database.
 */
export async function buildNodeProviders(opts: NodeProviderOpts): Promise<Providers> {
  mkdirSync(opts.blobsRoot, { recursive: true });

  let source: Pool | PGlite;
  if (opts.databaseUrl) {
    source = new Pool({ connectionString: opts.databaseUrl });
  } else {
    mkdirSync(opts.pgDataDir, { recursive: true });
    // Bundled single-binary: PGlite's default `import.meta.url`-relative wasm
    // load resolves to the bundle's own dir, so hand it the sibling
    // wasm/data assets explicitly. `undefined` in dev/tsx → default loading.
    const wasmOpts = await pgliteWasmOptions();
    source = wasmOpts ? new PGlite(opts.pgDataDir, wasmOpts) : new PGlite(opts.pgDataDir);
  }

  // Normalized query interface (decision 4) shared by the app's raw-SQL
  // migration runner and the engine's stores; `db` below is the Drizzle
  // handle over the SAME connection source.
  const pgdb = buildAppQueryable(source);

  await applyAppMigrations(pgdb);
  await applyEngineMigrations(pgdb);

  const db = buildAppDb(source);

  // Seed the local-dev identity. Idempotent. Skipped whenever real auth is
  // configured (`opts.seedLocalIdentity: false`, set by `main.ts` when
  // `authConfig` resolves) — see `NodeProviderOpts.seedLocalIdentity`.
  if (opts.seedLocalIdentity ?? true) {
    const now = Date.now();
    await db.insert(orgs).values({ id: LOCAL_ORG.id, name: LOCAL_ORG.name, createdAt: now }).onConflictDoNothing();
    await db
      .insert(users)
      .values({ id: LOCAL_USER.id, email: LOCAL_USER.email, name: LOCAL_USER.name, role: LOCAL_USER.role })
      .onConflictDoNothing();
    await db
      .insert(orgMembers)
      .values({ orgId: LOCAL_ORG.id, userId: LOCAL_USER.id, role: "admin", createdAt: now })
      .onConflictDoNothing();
  }

  const engineStore = new PgSessionStore(pgdb);
  const blobs = new FsBlobStore(opts.blobsRoot);
  // Backend selection (kubernetes-deployment plan Task 6, spec decision 7):
  // VALET_SANDBOX_BACKEND=docker|kubernetes|local, default docker — the
  // pre-Task-6 unconditional `new DockerSandboxProvider()` behavior.
  const sandboxProvider = buildSandboxProvider(process.env);
  const imageBuilder = resolveImageBuilder(process.env);
  const eventStream = new PgEventStream(pgdb);
  const baseCredentials = new PgCredentialStore(pgdb, deriveSecretKey(opts.encryptionKey));

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

  // Refresh-on-read decorator (integration-OAuth design): wraps the raw
  // credential store so any `engineCredentials.get()` call transparently
  // refreshes near-expiry oauth2 tokens using the plugins' oauth
  // declarations. Constructed after plugin assembly since it needs `plugins`.
  const engineCredentials = new OAuthRefreshingCredentialStore(baseCredentials, {
    db,
    plugins,
    env: process.env,
  });

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
    defaultImage: resolveDefaultImage(process.env),
    idleMinutes: resolveIdleMinutes(process.env),
    ...(resolvePrebuildPreflight(process.env) ? { prebuildPreflight: resolvePrebuildPreflight(process.env) } : {}),
    ...buildHibernationHooks(db),
    db,
    apiBaseUrl: opts.apiBaseUrl,
    sandboxJwtMaster: opts.sandboxJwtMaster,
    sandboxApiUrl: opts.sandboxApiUrl,
    plugins,
    // GH-T10 fix: session `github` actions resolve through the token service
    // (same `key` `engineCredentials`/the workflow invoker/the sandbox
    // credential route derive theirs from) instead of a raw credential read.
    githubTokenDeps: { key: deriveSecretKey(opts.encryptionKey) },
    childSpawner: (req, ctx) => {
      if (!spawnerRef) throw new Error("childSpawner invoked before provider wiring completed");
      return spawnerRef(req, ctx);
    },
  });

  const childWatcher = new ChildWatcher({ db, engineHost, engineStore });
  spawnerRef = buildChildSpawner({ db, engineHost, engineStore }, childWatcher);

  const channelHost = new ChannelHost({
    db,
    engineHost,
    engineStore,
    eventStream,
    engineCredentials,
    plugins,
    publicUrl: publicUrlFromEnv(process.env),
    resolveOrgId: () => resolveOrgId(db),
  });

  // Workflow run host (Phase 5 plan Task 10). `workflowStore` is the same
  // `WorkflowStore` port `buildWorkflowEngineDeps`'s session executors and
  // the routes both read/write through — one instance per process, backed
  // by the same connection source as everything else.
  const workflowStore = new PgWorkflowStore(pgdb);
  const workflowEngineDeps = buildWorkflowEngineDeps({
    host: engineHost,
    store: workflowStore,
    db,
    engineStore,
    actionPluginByService,
    credentials: engineCredentials,
    // GH-T10: lets a `github` workflow tool-node action resolve through
    // `resolveGitHubToken` (same `key` `engineCredentials`/the sandbox
    // credential route derive theirs from) instead of a raw credential read.
    githubTokenDeps: { key: deriveSecretKey(opts.encryptionKey) },
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

  // Prebuild orchestration (sandbox images v2 plan, Task 3). Same
  // `resolveGitHubToken`-shaped deps every other GitHub-credential consumer
  // in this file builds (`{ db, credentials: engineCredentials, key }`).
  // `start()`/`stop()` are called from `main.ts`.
  const prebuildService = new PrebuildService({
    db,
    builder: imageBuilder,
    githubTokenDeps: { db, credentials: engineCredentials, key: deriveSecretKey(opts.encryptionKey) },
  });

  return {
    db,
    blobs,
    encryptionKey: opts.encryptionKey,
    engineStore,
    sandboxProvider,
    imageBuilder,
    eventStream,
    engineCredentials,
    engineHost,
    childWatcher,
    channelHost,
    workflowStore,
    workflowRunHost,
    plugins,
    actionPluginByService,
    dynamicToolCounts: new DynamicToolCounts({ credentials: engineCredentials }),
    prebuildService,
  };
}
