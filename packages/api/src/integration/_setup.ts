/**
 * Shared boot harness for API integration tests.
 *
 * Spins up a real `createApp(providers)` on a random port with in-memory
 * sqlite + virtual sandbox + InMemory bus/creds. Returns the base URLs and
 * a cleanup function tests can call in `finally`.
 *
 * Underscore-prefixed filename so vitest's `*.test.ts` glob doesn't pick it
 * up as a test.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import {
  VirtualSandboxProvider,
  type ChildSpawner,
  type SandboxProvider,
} from "@valet/engine";
import { SqliteSessionStore, SqliteEventStream, applyEngineMigrations } from "@valet/store-sqlite";
import { createDefaultNodeExecutors, LocalRunHost, type RunHost } from "@valet/workflow";
import { applyAppMigrations, buildAppDb, type AppDb } from "../lib/drizzle.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { EngineHost } from "../engine/host.js";
import { buildChildSpawner, ChildWatcher } from "../orchestrator/children.js";
import { FsBlobStore } from "../providers/blob-fs.js";
import { SqliteCredentialStore } from "../plugins/credential-store.js";
import { SqliteWorkflowStore } from "../workflows/sqlite-store.js";
import { buildWorkflowEngineDeps } from "../workflows/engine-deps.js";
import { createApp } from "../app.js";
import type { Providers } from "../providers/types.js";

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

  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  applyAppMigrations(sqlite);
  applyEngineMigrations(sqlite);

  // Seed the local-dev identity (mirrors buildNodeProviders).
  const now = Date.now();
  sqlite
    .prepare("INSERT OR IGNORE INTO orgs (id, name, created_at) VALUES (?, ?, ?)")
    .run("local-org", "Local Dev", now);
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("local-user", "local@dev", "Local Dev", "admin", now);
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)",
    )
    .run("local-org", "local-user", "admin");
  // Non-admin identity for role-gated route tests. Select it via the
  // `x-valet-test-user-id` header (see authMiddleware).
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("test-member", "member@dev", "Test Member", "member", now);
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)",
    )
    .run("local-org", "test-member", "member");
  // A second org admin, distinct from `local-user`, for tests exercising the
  // org-admin recovery path on a team they aren't a member of.
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("test-admin", "admin@dev", "Test Admin", "admin", now);
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)",
    )
    .run("local-org", "test-admin", "admin");

  const blobsRoot = mkdtempSync(join(tmpdir(), "valet-itest-blobs-"));

  const db = buildAppDb(sqlite);
  const engineDb = drizzle(sqlite);
  const engineStore = new SqliteSessionStore(engineDb);
  const sandboxProvider = opts.sandboxProvider ?? new VirtualSandboxProvider();
  const eventStream = new SqliteEventStream(sqlite);
  // Same `$client` type-gap bridge as `providers/node.ts` — see its comment.
  const engineCredentials = new SqliteCredentialStore(
    db as AppDb & { $client: Database.Database },
    deriveSecretKey("test-key"),
  );
  const blobs = new FsBlobStore(blobsRoot);

  // Pre-allocate the port: EngineHost needs `apiBaseUrl` at construction
  // time, before `serve()` (below) would otherwise hand back a `port: 0`
  // assignment. See `getFreePort`'s comment for the tradeoff.
  const port = await getFreePort();
  const apiBaseUrl = `http://127.0.0.1:${port}`;

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

  // Same `$client` type-gap bridge as `providers/node.ts` — see its comment.
  const workflowStore = new SqliteWorkflowStore(db as AppDb & { $client: Database.Database });
  const workflowEngineDeps = buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore });
  const realWorkflowRunHost = new LocalRunHost({
    store: workflowStore,
    engine: workflowEngineDeps,
    executors: createDefaultNodeExecutors(),
  });
  const workflowRunHost = opts.workflowRunHost ?? realWorkflowRunHost;
  // Only start the host loop when it's the real one under test control — a
  // caller-supplied stub owns its own lifecycle (or has none).
  if (!opts.workflowRunHost) workflowRunHost.startHost();

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
  };

  const { app, injectWebSocket } = createApp(providers);
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
    },
  };
}
