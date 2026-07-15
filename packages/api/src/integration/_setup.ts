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
import { serve } from "@hono/node-server";
import {
  VirtualSandboxProvider,
  type ChildSpawner,
  type CredentialStore,
  type SandboxProvider,
  type ValetPlugin,
} from "@valet/engine";
import { PgSessionStore, PgEventStream } from "@valet/store-postgres";
import { createDefaultNodeExecutors, LocalRunHost, type RunHost, type WorkflowStore } from "@valet/workflow";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { EngineHost } from "../engine/host.js";
import { buildChildSpawner, ChildWatcher } from "../orchestrator/children.js";
import { FsBlobStore } from "../providers/blob-fs.js";
import { notPortedStub } from "../providers/not-ported-stub.js";
import { assemblePlugins } from "../plugins/assemble.js";
import { orgMembers, orgs, users } from "../schema/index.js";
import { buildWorkflowEngineDeps } from "../workflows/engine-deps.js";
import { createApp, type AuthWiring } from "../app.js";
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
  // Not yet ported to Postgres (Task 8 of the postgres-backend plan) — see
  // `providers/not-ported-stub.ts`'s doc comment. No integration suite that
  // boots via `bootTestApi` today exercises a credential-store method.
  const engineCredentials = notPortedStub<CredentialStore>("CredentialStore");
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
  const engineHost = new EngineHost({
    engineStore,
    sandboxProvider,
    eventStream,
    engineCredentials,
    blobs,
    anthropicApiKey: ANTHROPIC_API_KEY,
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

  // Not yet ported to Postgres (Task 8) — see `providers/not-ported-stub.ts`'s
  // doc comment.
  const workflowStore = notPortedStub<WorkflowStore>("WorkflowStore");
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
  //
  // `workflowStore` is a `notPortedStub` for the duration of the postgres-
  // backend cutover wave (Task 8 ports `PgWorkflowStore`) — starting the
  // real poll/sweep loops against it throws inside `pollOnce`'s background
  // interval on every tick, as an unhandled rejection unrelated to whatever
  // the test actually boots for (it pollutes every suite that calls
  // `bootTestApi`, not just workflow ones). Skip starting the loop while the
  // store is stubbed; workflow-specific tests that need the loop running are
  // already in the Task 7 "expected failing" list and get their coverage
  // back in Task 8 once `workflowStore` is real again.

  const providers: Providers = {
    db,
    blobs,
    encryptionKey: "test-key",
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

  let authWiring: AuthWiring = {};
  if (opts.auth) {
    const authConfig = loadAuthConfig(process.env);
    if (!authConfig) {
      throw new Error("bootTestApi({ auth: true }): BETTER_AUTH_SECRET was set but loadAuthConfig returned null");
    }
    const hooks = buildAuthHooks({ db, cfg: authConfig, credentialStore: engineCredentials });
    authWiring = { auth: buildAuth({ db, cfg: authConfig, hooks }), authConfig };
  }

  const { app, injectWebSocket } = createApp(providers, authWiring);
  const server = serve({ fetch: app.fetch, port });
  injectWebSocket(server);

  await new Promise<void>((resolve) => server.on("listening", () => resolve()));

  return {
    baseUrl: `http://localhost:${port}`,
    wsUrl: `ws://localhost:${port}`,
    providers,
    async cleanup() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
