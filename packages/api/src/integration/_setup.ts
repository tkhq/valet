/**
 * Shared boot harness for API integration tests.
 *
 * Spins up a real `createApp(providers)` on a random port with a fresh
 * PGlite instance (via the shared `test-helpers/pg-test-db.ts` helper) +
 * virtual sandbox + InMemory bus/creds. Returns the base URLs and a cleanup
 * function tests can call in `finally`.
 *
 * Underscore-prefixed filename so vitest's `*.test.ts` glob doesn't pick it
 * up as a test.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import {
  VirtualSandboxProvider,
  type ChildSpawner,
  type SandboxProvider,
  type ValetPlugin,
} from "@valet/engine";
import { PgSessionStore, PgEventStream } from "@valet/store-postgres";
import { createDefaultNodeExecutors, LocalRunHost, type RunHost } from "@valet/workflow";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { EngineHost, type EngineHostOpts } from "../engine/host.js";
import { buildHibernationHooks } from "../engine/hibernation-hooks.js";
import { buildChildSpawner, ChildWatcher } from "../orchestrator/children.js";
import { ChannelHost } from "../channels/host.js";
import { EventDispatcher } from "../events/dispatcher.js";
import { WorkflowScheduler } from "../workflows/scheduler.js";
import { buildOrchestratorTarget } from "../events/orchestrator-target.js";
import { resolveOrgId } from "../lib/org.js";
import { FsBlobStore } from "../providers/blob-fs.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { assemblePlugins } from "../plugins/assemble.js";
import { DynamicToolCounts } from "../plugins/dynamic-tool-count.js";
import { orgMembers, orgs, users } from "../schema/index.js";
import { buildWorkflowEngineDeps } from "../workflows/engine-deps.js";
import { PgWorkflowStore } from "../workflows/pg-store.js";
import { createApp, type AuthWiring } from "../app.js";
import { PrebuildService } from "../prebuilds/service.js";
import type { ImageBuilder } from "../prebuilds/builder.js";
import type { Providers } from "../providers/types.js";
import { loadAuthConfig } from "../auth/config.js";
import { buildAuthHooks } from "../auth/provisioning.js";
import { buildAuth } from "../auth/index.js";

export interface TestApi {
  baseUrl: string;
  wsUrl: string;
  providers: Providers;
  cleanup(): Promise<void>;
}

export interface BootTestApiOpts {
  /** Override the default `VirtualSandboxProvider` — e.g. a create-counting
   * wrapper that proves a code path never provisions a sandbox. */
  sandboxProvider?: SandboxProvider;
  /** Forwarded to `EngineHostOpts.defaultImage` — tests that pin
   * `VALET_SANDBOX_IMAGE`-style behavior assert against a fake
   * `sandboxProvider` that records the `SandboxCreateOpts.image` it
   * receives. Unset by default, matching `EngineHost`'s own default. */
  defaultImage?: string;
  /**
   * Override the default real `LocalRunHost` — route-level tests that only
   * need to observe `start`/`wake`/`terminate` calls (never actually drive a
   * run) pass a stub implementing the `RunHost` port instead of paying for
   * the poll/sweep loops.
   */
  workflowRunHost?: RunHost;
  /** Plugin set for the assembled `Providers.plugins`/`actionPluginByService`
   * — tests never scan node_modules; default `[]`. */
  plugins?: ValetPlugin[];
  /**
   * Boots with a real better-auth instance instead of stub-only mode: sets
   * `BETTER_AUTH_SECRET=test-secret` (restored on `cleanup()`) so
   * `loadAuthConfig` resolves, then wires `buildAuthHooks` + `buildAuth`
   * into `createApp` exactly as `main.ts` does. Every other caller stays
   * untouched — `BETTER_AUTH_SECRET` is unset by default, so `createApp`
   * gets no `auth`/`authConfig` and runs stub-only, same as before this
   * option existed.
   */
  auth?: boolean;
  /** Passed through to `createApp`'s `CreateAppOpts.webDistDir` — route
   * tests for the SPA static-serve/fallback (kubernetes-deployment design
   * decision 3) point this at a temp dir with a fixture `index.html`. Unset
   * by every other caller, matching dev's unmounted-static behavior. */
  webDistDir?: string;
  /** Public base URL forwarded to the constructed `ChannelHost` (Task 8) —
   * unset by default (long-poll/inert mode). Webhook-mode route tests set
   * this so the host registers webhook transports instead. */
  channelPublicUrl?: string;
  /**
   * Start the constructed `ChannelHost` immediately (Task 8). Default
   * `false` — the host is always constructed and included in `providers`,
   * but by default zero transports exist (`plugins: []` default) so
   * starting it is a no-op most callers skip. Webhook/poll-loop tests opt
   * in here (or call `providers.channelHost.start()` themselves).
   */
  startChannelHost?: boolean;
  /** Forwarded to `EngineHostOpts.idleMinutes` (sandbox hibernation plan,
   * Task 3) — unset by default, matching `EngineHost`'s own "sweep off"
   * default. Idle-sweep tests set this (with a `sandboxProvider` whose
   * `capabilities().hibernation` is `true`) to exercise the sweep. */
  idleMinutes?: number;
  /** Overrides the default db-backed `EngineHostOpts.onHibernate` hook
   * (`buildHibernationHooks`) — unset by default, matching real boot. */
  onHibernate?: EngineHostOpts["onHibernate"];
  /** Overrides the default db-backed `EngineHostOpts.onWake` hook
   * (`buildHibernationHooks`) — unset by default, matching real boot. */
  onWake?: EngineHostOpts["onWake"];
  /** Overrides the default db-backed `EngineHostOpts.onSessionReady` hook
   * (`buildHibernationHooks`) — unset by default, matching real boot. */
  onSessionReady?: EngineHostOpts["onSessionReady"];
  /** Forwarded to `EngineHostOpts.idleSweepTestHooks` — test-only race
   * injection for the idle sweep's re-check. */
  idleSweepTestHooks?: EngineHostOpts["idleSweepTestHooks"];
  /** Forwarded to `EngineHostOpts.githubTokenDeps` — wires the session
   * `credentialResolver` seam (GH-T10 fix) so a real `sessionFor(...)` build
   * resolves `github` credentials through the token service instead of a raw
   * store read. Unset by default, matching every other route test (no
   * resolver at all) — only tests exercising the action-invoke-level
   * session-credential seam (GitHub/repo integration plan, Task 12's e2e)
   * need this wired through a full API boot. */
  githubTokenDeps?: EngineHostOpts["githubTokenDeps"];
  /** Wires `Providers.prebuildService`'s `builder` — unset/`null` (the
   * default) means "prebuilds unavailable", same as a `local` sandbox
   * backend boot. Prebuild route tests supply a fake `ImageBuilder`. */
  imageBuilder?: ImageBuilder | null;
  /** Overrides the `apiUrl`/`githubUrl` the constructed `PrebuildService`
   * resolves GitHub credentials/contents through — point this at
   * `startGithubFixture()`'s `url`. Ignored when `imageBuilder` is unset. */
  githubApiUrl?: string;
}

/** Grabs a free ephemeral port by briefly binding and releasing a socket. A
 * small race exists between release and the real `serve()` call below, but
 * it's the same pattern node test harnesses commonly use — `EngineHost`
 * needs its `apiBaseUrl` before `createApp`/`serve` can hand back the port
 * `serve({ port: 0 })` would otherwise assign, so a pre-allocated port is
 * the only order that works here. */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export async function bootTestApi(opts: BootTestApiOpts = {}): Promise<TestApi> {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
  process.env.VALET_LOCAL_AUTH = "1";
  // Test-only: enables the `x-valet-test-user-id` impersonation header in
  // authMiddleware. Never set this outside the test bootstrap (see
  // packages/api/src/middleware/auth.ts).
  process.env.VALET_TEST_AUTH_HEADER = "1";

  const prevAuthSecret = process.env.BETTER_AUTH_SECRET;
  if (opts.auth) {
    process.env.BETTER_AUTH_SECRET = "test-secret";
  }

  const { pgdb, appDb: db } = await freshTestPgDb();

  // Seed the local-dev identity (mirrors buildNodeProviders) — skipped in
  // `auth: true` mode: these stub identities exist for the
  // `x-valet-test-user-id` impersonation header (stub-auth-only), and a
  // pre-seeded user would break the admission rule's "first-ever signup is
  // admin" case (auth-instance tests sign up the actual first user).
  const now = Date.now();
  if (!opts.auth) {
    await db.insert(orgs).values({ id: "local-org", name: "Local Dev", createdAt: now }).onConflictDoNothing();
    await db
      .insert(users)
      .values({ id: "local-user", email: "local@dev", name: "Local Dev", role: "admin" })
      .onConflictDoNothing();
    await db
      .insert(orgMembers)
      .values({ orgId: "local-org", userId: "local-user", role: "admin", createdAt: now })
      .onConflictDoNothing();
    // Non-admin identity for role-gated route tests. Select it via the
    // `x-valet-test-user-id` header (see authMiddleware).
    await db
      .insert(users)
      .values({ id: "test-member", email: "member@dev", name: "Test Member", role: "member" })
      .onConflictDoNothing();
    await db
      .insert(orgMembers)
      .values({ orgId: "local-org", userId: "test-member", role: "member", createdAt: now })
      .onConflictDoNothing();
    // A second org admin, distinct from `local-user`, for tests exercising
    // the org-admin recovery path on a team they aren't a member of.
    await db
      .insert(users)
      .values({ id: "test-admin", email: "admin@dev", name: "Test Admin", role: "admin" })
      .onConflictDoNothing();
    await db
      .insert(orgMembers)
      .values({ orgId: "local-org", userId: "test-admin", role: "admin", createdAt: now })
      .onConflictDoNothing();
  }

  const blobsRoot = mkdtempSync(join(tmpdir(), "valet-itest-blobs-"));
  const engineStore = new PgSessionStore(pgdb);
  const sandboxProvider = opts.sandboxProvider ?? new VirtualSandboxProvider();
  const eventStream = new PgEventStream(pgdb);
  const engineCredentials = new PgCredentialStore(pgdb, deriveSecretKey("test-key"));
  const blobs = new FsBlobStore(blobsRoot);

  // Pre-allocate the port: EngineHost needs `apiBaseUrl` at construction
  // time, before `serve()` (below) would otherwise hand back a `port: 0`
  // assignment. See `getFreePort`'s comment for the tradeoff.
  const port = await getFreePort();
  const apiBaseUrl = `http://127.0.0.1:${port}`;

  const { plugins, actionPluginByService } = assemblePlugins([[...(opts.plugins ?? [])]]);

  // Same circular-construction indirection as providers/node.ts — see its
  // comment. Test callers that want to unit-test the spawner/watcher
  // directly still can (they're plain exported functions/classes); this
  // wiring only matters for exercising `task` through a real orchestrator.
  let spawnerRef: ChildSpawner | undefined;
  // Default hibernation hooks are the SAME db-backed implementation real
  // boot uses (`providers/node.ts`) — matches production behavior for tests
  // that don't need to observe the hooks directly. `opts.on*` overrides
  // take precedence for tests that do (e.g. asserting call order/count).
  const defaultHibernationHooks = buildHibernationHooks(db);
  const engineHost = new EngineHost({
    engineStore,
    sandboxProvider,
    eventStream,
    engineCredentials,
    blobs,
    anthropicApiKey: ANTHROPIC_API_KEY,
    defaultImage: opts.defaultImage,
    idleMinutes: opts.idleMinutes,
    onHibernate: opts.onHibernate ?? defaultHibernationHooks.onHibernate,
    onWake: opts.onWake ?? defaultHibernationHooks.onWake,
    onSessionReady: opts.onSessionReady ?? defaultHibernationHooks.onSessionReady,
    idleSweepTestHooks: opts.idleSweepTestHooks,
    githubTokenDeps: opts.githubTokenDeps,
    db,
    apiBaseUrl,
    plugins,
    childSpawner: (req, ctx) => {
      if (!spawnerRef) throw new Error("childSpawner invoked before provider wiring completed");
      return spawnerRef(req, ctx);
    },
  });
  // Child workspaces under the test tmp dir (cleaned up with it) instead of
  // the real ~/.valet/children.
  const childrenDeps = { db, engineHost, engineStore, workspaceRoot: join(blobsRoot, "children") };
  const childWatcher = new ChildWatcher(childrenDeps);
  spawnerRef = buildChildSpawner(childrenDeps, childWatcher);

  const channelHost = new ChannelHost({
    db,
    engineHost,
    engineStore,
    eventStream,
    engineCredentials,
    plugins,
    publicUrl: opts.channelPublicUrl,
    resolveOrgId: () => resolveOrgId(db),
  });
  if (opts.startChannelHost) {
    await channelHost.start();
  }

  const workflowStore = new PgWorkflowStore(pgdb);
  const workflowEngineDeps = buildWorkflowEngineDeps({
    host: engineHost,
    store: workflowStore,
    db,
    engineStore,
    actionPluginByService,
    credentials: engineCredentials,
  });
  const realWorkflowRunHost = new LocalRunHost({
    store: workflowStore,
    engine: workflowEngineDeps,
    executors: createDefaultNodeExecutors(),
  });
  const workflowRunHost = opts.workflowRunHost ?? realWorkflowRunHost;
  // Only start the host loop when it's the real one under test control — a
  // caller-supplied stub owns its own lifecycle (or has none).
  if (!opts.workflowRunHost) {
    workflowRunHost.startHost();
  }

  // Event dispatcher (event-system plan Task 6): constructed with the same
  // real deps as buildNodeProviders but NEVER started on its timer — tests
  // drive `providers.eventDispatcher.pollOnce()` themselves (the ingest
  // path's `nudge` still triggers an immediate poll, matching production).
  // Never started on its timer in tests — drive `tick()` manually if needed.
  const workflowScheduler = new WorkflowScheduler({ db, workflowStore, workflowRunHost });

  const eventDispatcher = new EventDispatcher({
    db,
    workflowRunHost,
    workflowStore,
    deliverToOrchestrator: buildOrchestratorTarget({ db, engineHost }),
  });

  // Prebuilds are out of scope for the integration harness (no real
  // docker/kubernetes builder wired here); routes must treat this as
  // "unavailable", same as a `local` sandbox-backend boot.
  const prebuildService = new PrebuildService({
    db,
    builder: opts.imageBuilder ?? null,
    githubTokenDeps: {
      db,
      credentials: engineCredentials,
      key: deriveSecretKey("test-key"),
      apiUrl: opts.githubApiUrl,
      githubUrl: opts.githubApiUrl,
    },
  });

  const providers: Providers = {
    db,
    blobs,
    encryptionKey: "test-key",
    engineStore,
    sandboxProvider,
    imageBuilder: null,
    eventStream,
    engineCredentials,
    engineHost,
    childWatcher,
    channelHost,
    workflowStore,
    workflowRunHost,
    workflowScheduler,
    eventDispatcher,
    plugins,
    actionPluginByService,
    dynamicToolCounts: new DynamicToolCounts({ credentials: engineCredentials }),
    prebuildService,
  };

  let authWiring: AuthWiring = {};
  if (opts.auth) {
    const authConfig = loadAuthConfig(process.env);
    if (!authConfig) {
      throw new Error("bootTestApi({ auth: true }): BETTER_AUTH_SECRET was set but loadAuthConfig returned null");
    }
    const hooks = buildAuthHooks({ db, cfg: authConfig, credentialStore: engineCredentials });
    authWiring = { auth: buildAuth({ db, cfg: authConfig, hooks }), authConfig };
  }

  // Node-only test boot: `createApp` defaults to the Node server adapter.
  const { startServer } = createApp(providers, authWiring, { webDistDir: opts.webDistDir });
  const server = await new Promise<ReturnType<typeof startServer>>((resolve) => {
    const handle = startServer({ port, onListen: () => resolve(handle) });
  });

  return {
    baseUrl: `http://localhost:${port}`,
    wsUrl: `ws://localhost:${port}`,
    providers,
    async cleanup() {
      await server.close();
      await eventDispatcher.stop();
      await channelHost.stop();
      if (!opts.workflowRunHost) await realWorkflowRunHost.stopHost();
      await engineHost.destroyAll();
      rmSync(blobsRoot, { recursive: true, force: true });
      if (opts.auth) {
        if (prevAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
        else process.env.BETTER_AUTH_SECRET = prevAuthSecret;
      }
    },
  };
}
