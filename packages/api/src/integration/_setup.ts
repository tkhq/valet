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
import { createServer } from "node:net";
import { eq } from "drizzle-orm";
import {
  VirtualSandboxProvider,
  type ChildReader,
  type ChildSender,
  type ChildSpawner,
  type SandboxProvider,
  type ValetPlugin,
} from "@valet/engine";
import { PgSessionStore, PgEventStream } from "@valet/store-postgres";
import { createDefaultNodeExecutors, LocalRunHost, type OnApprovalGrant, type RunHost } from "@valet/workflow";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { EngineHost, type EngineHostOpts } from "../engine/host.js";
import { buildHibernationHooks } from "../engine/hibernation-hooks.js";
import { buildChildReader, buildChildSender, buildChildSpawner, ChildWatcher } from "../orchestrator/children.js";
import { HibernationReaper } from "../engine/hibernation-reaper.js";
import { SandboxReconcileSweep } from "../engine/sandbox-reconcile-sweep.js";
import { IdleHibernationSweep } from "../engine/idle-hibernation-sweep.js";
import { ChannelHost } from "../channels/host.js";
import { EventDispatcher } from "../events/dispatcher.js";
import { WorkflowScheduler } from "../workflows/scheduler.js";
import { SkillSyncService } from "../services/skill-sync.js";
import { GitHubSkillRepoReader } from "../services/skill-repo-reader.js";
import { skillRepoReaderFactory } from "../services/skill-source-credential.js";
import { buildOrchestratorTarget } from "../events/orchestrator-target.js";
import { resolveOrgId } from "../lib/org.js";
import { FsBlobStore } from "../providers/blob-fs.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { assemblePlugins } from "../plugins/assemble.js";
import { DynamicToolCounts } from "../plugins/dynamic-tool-count.js";
import { orgMembers, orgs, users, workflowDefinitions } from "../schema/index.js";
import { buildWorkflowEngineDeps } from "../workflows/engine-deps.js";
import { writeExecutionGrant } from "../policies/service.js";
import { PgWorkflowStore } from "../workflows/pg-store.js";
import { WorkflowSandboxReclaimer } from "../workflows/sandbox-reclaim.js";
import { WorkflowWebhookRateLimiter, type WorkflowWebhookRateLimiterOptions } from "../workflows/webhook-service.js";
import { createApp, type AuthWiring } from "../app.js";
import { SourceService } from "../bakes/source-service.js";
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
  /** Forwarded to `EngineHostOpts.defaultImages` — tests that pin
   * per-profile stock-image fallback behavior. */
  defaultImages?: Partial<Record<"headless" | "full", string>>;
  /**
   * Override the default real `LocalRunHost` — route-level tests that only
   * need to observe `start`/`wake`/`terminate` calls (never actually drive a
   * run) pass a stub implementing the `RunHost` port instead of paying for
   * the poll/sweep loops.
   */
  workflowRunHost?: RunHost;
  /** Overrides the default 30-per-60s `webhookRateLimiter` — rate-limit
   * tests set a tiny limit so they don't have to race a wall-clock window. */
  webhookRateLimit?: WorkflowWebhookRateLimiterOptions;
  /** Plugin set for the assembled `Providers.plugins`/`actionPluginByService`
   * — tests never scan node_modules; default `[]`. */
  plugins?: ValetPlugin[];
  /**
   * Boots with a real better-auth instance instead of stub-only mode: sets
   * `BETTER_AUTH_SECRET=test-secret` and unsets `VALET_LOCAL_AUTH` (both
   * restored on `cleanup()`) so `loadAuthConfig` resolves and the stub rung
   * stays off, then wires `buildAuthHooks` + `buildAuth` into `createApp`
   * exactly as `main.ts` does. A credential-less request therefore 401s here
   * the way it does in production. Every other caller stays untouched —
   * `BETTER_AUTH_SECRET` is unset by default and `VALET_LOCAL_AUTH=1` stays
   * on, so `createApp` gets no `auth`/`authConfig` and runs stub-only, same
   * as before this option existed.
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
  /** Overrides the GitHub token deps given to BOTH `EngineHost` (the
   * session `credentialResolver` seam, GH-T10 fix) and the workflow action
   * invoker — the same pair `providers/node.ts` derives from one key at real
   * boot. Point `apiUrl`/`githubUrl` at `startGithubFixture()`'s `url` to
   * keep resolution off the network.
   *
   * When unset, `EngineHost` gets no resolver (sessions read credentials
   * straight from the store, matching every other route test) but the
   * workflow invoker still gets the default test key, because production
   * always wires it and a `github` tool node is otherwise untestable. */
  githubTokenDeps?: EngineHostOpts["githubTokenDeps"];
  /** Wires `Providers.prebuildService`'s `builder` — unset/`null` (the
   * default) means "prebuilds unavailable", same as a `local` sandbox
   * backend boot. Prebuild route tests supply a fake `ImageBuilder`. */
  imageBuilder?: ImageBuilder | null;
  /** Overrides the GitHub API base URL two constructed services read
   * through: the `PrebuildService`'s credential/contents resolution (ignored
   * when `imageBuilder` is unset), and the skill-sync reader. Point it at
   * `startGithubFixture()`'s `url`. */
  githubApiUrl?: string;
}

/** Pre-allocates a port for the app to bind. `EngineHost` needs its
 * `apiBaseUrl` before `createApp`/`serve` can hand back the port
 * `serve({ port: 0 })` would otherwise assign, so a pre-allocated port is
 * the only order that works here.
 *
 * Allocation probes SEQUENTIALLY inside a per-vitest-worker range instead
 * of `listen(0)` → close → reuse: the OS hands sibling workers the same
 * ephemeral port in the release window, and the resulting EADDRINUSE
 * failed whole 10-minute suite runs. Disjoint ranges make cross-worker
 * collisions impossible; the in-worker cursor never re-probes a port it
 * already handed out. */
const PORT_RANGE_BASE = 21000;
const PORT_RANGE_SIZE = 20000;
// Seed from the PID, not VITEST_POOL_ID: pool ids restart per vitest
// project, so two projects' workers could share a "unique" id and probe
// the same cursor simultaneously. Live processes can't share a PID, and
// the multiplier scatters cursors so even a mod-collision starts far away.
let portCursor = PORT_RANGE_BASE + ((process.pid * 137) % PORT_RANGE_SIZE);

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, () => {
      srv.close(() => resolve(true));
    });
  });
}

async function getFreePort(): Promise<number> {
  for (;;) {
    if (portCursor >= PORT_RANGE_BASE + PORT_RANGE_SIZE) portCursor = PORT_RANGE_BASE;
    const candidate = portCursor++;
    if (await canBind(candidate)) return candidate;
  }
}

export async function bootTestApi(opts: BootTestApiOpts = {}): Promise<TestApi> {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
  // Test-only: enables the `x-valet-test-user-id` impersonation header in
  // authMiddleware. Never set this outside the test bootstrap (see
  // packages/api/src/middleware/auth.ts).
  process.env.VALET_TEST_AUTH_HEADER = "1";

  const prevAuthSecret = process.env.BETTER_AUTH_SECRET;
  const prevLocalAuth = process.env.VALET_LOCAL_AUTH;
  if (opts.auth) {
    process.env.BETTER_AUTH_SECRET = "test-secret";
    // Stub auth and real auth are mutually exclusive — the boot check in
    // `main.ts` refuses the pair. A real-auth test must see production's
    // answer to a credential-less request (401), so the stub var comes OFF
    // here and is restored on `cleanup()`. Stub-mode callers keep the
    // stub + `x-valet-test-user-id` contract unchanged.
    delete process.env.VALET_LOCAL_AUTH;
  } else {
    process.env.VALET_LOCAL_AUTH = "1";
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
  // comment. Test callers that want to unit-test the spawner/watcher/reader
  // directly still can (they're plain exported functions/classes); this
  // wiring only matters for exercising `task` and `child_read` through a
  // real orchestrator.
  let spawnerRef: ChildSpawner | undefined;
  let readerRef: ChildReader | undefined;
  let senderRef: ChildSender | undefined;
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
    ...(opts.defaultImages ? { defaultImages: opts.defaultImages } : {}),
    idleMinutes: opts.idleMinutes,
    onHibernate: opts.onHibernate ?? defaultHibernationHooks.onHibernate,
    onWake: opts.onWake ?? defaultHibernationHooks.onWake,
    onSessionReady: opts.onSessionReady ?? defaultHibernationHooks.onSessionReady,
    idleSweepTestHooks: opts.idleSweepTestHooks,
    githubTokenDeps: opts.githubTokenDeps,
    db,
    apiBaseUrl,
    plugins,
    actionPluginByService,
    childSpawner: (req, ctx) => {
      if (!spawnerRef) throw new Error("childSpawner invoked before provider wiring completed");
      return spawnerRef(req, ctx);
    },
    childReader: (req, ctx) => {
      if (!readerRef) throw new Error("childReader invoked before provider wiring completed");
      return readerRef(req, ctx);
    },
    childSender: (req, ctx) => {
      if (!senderRef) throw new Error("childSender invoked before provider wiring completed");
      return senderRef(req, ctx);
    },
  });
  // Prebuilds are out of scope for the integration harness (no real
  // docker/kubernetes builder wired here unless a test injects one); routes
  // must treat this as "unavailable", same as a `local` sandbox-backend
  // boot. Constructed before the child spawner, whose zero-config repo
  // binding needs it.
  // One set of GitHub credential deps for every consumer in the harness, so
  // a test that points the fixture at one of them points it at all of them.
  const githubTokenDeps = {
    db,
    credentials: engineCredentials,
    key: deriveSecretKey("test-key"),
    apiUrl: opts.githubApiUrl,
    githubUrl: opts.githubApiUrl,
  };

  const prebuildService = new SourceService({
    db,
    builder: opts.imageBuilder ?? null,
    githubTokenDeps,
  });

  // Child workspaces under the test tmp dir (cleaned up with it) instead of
  // the real ~/.valet/children.
  const childrenDeps = { db, engineHost, engineStore, prebuildService, workspaceRoot: join(blobsRoot, "children") };
  const childWatcher = new ChildWatcher(childrenDeps);
  spawnerRef = buildChildSpawner(childrenDeps, childWatcher);
  readerRef = buildChildReader(childrenDeps);
  senderRef = buildChildSender(childrenDeps, childWatcher);

  // retentionMs 0 disables the sweep; behavior is tested in engine/hibernation-reaper.test.ts.
  const hibernationReaper = new HibernationReaper({ db, engineHost, engineStore, retentionMs: 0 });

  // Never started on its timer in tests; behavior is tested in
  // engine/sandbox-reconcile-sweep.test.ts. ageReportMs 0 keeps the
  // over-age report quiet even if a test drives sweep() by hand.
  const sandboxReconcileSweep = new SandboxReconcileSweep({
    db,
    provider: sandboxProvider,
    engineHost,
    engineStore,
    ageReportMs: 0,
  });

  // idleMs 0 disables the sweep; behavior is tested in
  // engine/idle-hibernation-sweep.test.ts.
  const idleHibernationSweep = new IdleHibernationSweep({ db, engineHost, engineStore, idleMs: 0 });

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

  // Never started on its timer in tests (matches the dispatcher/scheduler
  // convention) — drive `reclaimRun`/`sweep` manually; behavior is tested
  // in workflows/sandbox-reclaim.test.ts.
  const workflowSandboxReclaimer = new WorkflowSandboxReclaimer({
    db,
    engineHost,
    engineStore,
    store: workflowStore,
  });

  const workflowEngineDeps = buildWorkflowEngineDeps({
    host: engineHost,
    store: workflowStore,
    db,
    engineStore,
    actionPluginByService,
    plugins,
    credentials: engineCredentials,
    // Same key BOTH consumers get at real boot (`providers/node.ts` derives
    // one key for `EngineHost` and the workflow action invoker). Without
    // this, a `github` tool node inside a workflow threw a wiring error and
    // the whole path was untestable.
    githubTokenDeps: opts.githubTokenDeps ?? { key: deriveSecretKey("test-key") },
  });
  // "Grant the rest of this run" (action-policies plan, Task 3/6): mirrors
  // `providers/node.ts`'s real-boot `onApprovalGrant` wiring so integration
  // tests can exercise an approval node's `grantActions` end to end — the
  // real boot path wires this via `providers/node.ts`, which this harness
  // otherwise duplicates rather than reuses (same rationale as every other
  // hand-assembled dep below).
  const onApprovalGrant: OnApprovalGrant = async (info) => {
    try {
      const run = await workflowStore.getRun(info.runId);
      if (!run?.params.workflowId) return;
      const defRows = await db
        .select({ orgId: workflowDefinitions.orgId })
        .from(workflowDefinitions)
        .where(eq(workflowDefinitions.id, run.params.workflowId))
        .limit(1);
      const orgId = defRows[0]?.orgId;
      if (!orgId) return;
      const now = Date.now();
      for (const g of info.grants) {
        await writeExecutionGrant(db, info.runId, { orgId, service: g.service, actionId: g.actionId, grantedBy: info.resolvedBy, now });
      }
    } catch (err) {
      console.error(`test harness: workflow approval grant write failed for run ${info.runId}:`, err);
    }
  };

  const realWorkflowRunHost = new LocalRunHost({
    store: workflowStore,
    engine: workflowEngineDeps,
    executors: createDefaultNodeExecutors(),
    onApprovalGrant,
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
  const workflowScheduler = new WorkflowScheduler({
    db,
    workflowStore,
    workflowRunHost,
    deliverToOrchestrator: buildOrchestratorTarget({ db, engineHost }),
  });

  const eventDispatcher = new EventDispatcher({
    db,
    workflowRunHost,
    workflowStore,
    deliverToOrchestrator: buildOrchestratorTarget({ db, engineHost }),
  });

  const webhookRateLimiter = new WorkflowWebhookRateLimiter(opts.webhookRateLimit ?? { limit: 30, windowMs: 60_000 });

  // Skill-repository sync. Constructed with the same real deps
  // `buildNodeProviders` uses, but NEVER started on its timer — tests drive
  // `syncOnce`/`pollOnce` themselves, matching the event dispatcher.
  const skillSync = new SkillSyncService({
    db,
    reader: new GitHubSkillRepoReader({ apiUrl: opts.githubApiUrl }),
    readerFor: skillRepoReaderFactory(githubTokenDeps, { apiUrl: opts.githubApiUrl }),
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
    hibernationReaper,
    workflowSandboxReclaimer,
    sandboxReconcileSweep,
    idleHibernationSweep,
    channelHost,
    workflowStore,
    workflowRunHost,
    workflowScheduler,
    webhookRateLimiter,
    eventDispatcher,
    skillSync,
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
        if (prevLocalAuth === undefined) delete process.env.VALET_LOCAL_AUTH;
        else process.env.VALET_LOCAL_AUTH = prevLocalAuth;
      }
    },
  };
}
