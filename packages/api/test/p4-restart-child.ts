/**
 * Child entrypoint for the Phase 4 exit-criteria cross-process restart proof
 * (`orchestrator-restart.test.ts`). Mirrors the structure of
 * `packages/engine/test/kill-gate-child.ts`: this script boots a real API
 * provider stack (sqlite file at argv[0], VirtualSandboxProvider so no
 * Docker is required — decision 11's restart-survival mechanism is
 * orthogonal to which sandbox backend the child uses) over the SAME
 * `deps` shape `children.test.ts` builds by hand, ensures the orchestrator,
 * and spawns a child session by calling the `ChildSpawner` DIRECTLY
 * (bypassing the `task` tool / LLM turn on the parent — determinism per
 * decision 24's task-10 brief) with a real-model prompt for the CHILD.
 *
 * `buildChildSpawner` inserts the durable `child_watches` row and calls
 * `watcher.arm()` (fire-and-forget) before returning — the exact
 * "watch row exists, child hasn't settled yet" checkpoint the restart test
 * needs. Once the spawner call resolves, this script prints
 * `READY:<childSessionId>|<queueItemId>|<parentSessionId>|<parentThreadId>`
 * (pipe-delimited — `parentSessionId` is an orchestrator id and itself
 * contains colons, e.g. `orchestrator:user:local-user`)
 * once and hangs; the test process SIGKILLs it from the outside (same
 * kill-from-parent idiom as kill-mid-gate.test.ts, safer than a self-kill
 * racing stdout flush).
 *
 * argv: [dbPath]
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  InMemoryCredentialStore,
  VirtualSandboxProvider,
  type ChildSpawner,
} from "@valet/engine";
import { SqliteSessionStore, SqliteEventStream, applyEngineMigrations } from "@valet/store-sqlite";
import { applyAppMigrations, buildAppDb } from "../src/lib/drizzle.js";
import { EngineHost } from "../src/engine/host.js";
import { buildChildSpawner, ChildWatcher } from "../src/orchestrator/children.js";
import { FsBlobStore } from "../src/providers/blob-fs.js";

const [dbPath] = process.argv.slice(2);
if (!dbPath) {
  process.stderr.write("usage: p4-restart-child.ts <dbPath>\n");
  process.exit(2);
}
if (!process.env.ANTHROPIC_API_KEY) {
  process.stderr.write("p4-restart-child: ANTHROPIC_API_KEY is required\n");
  process.exit(2);
}

async function main(): Promise<void> {
  mkdirSync(dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  applyAppMigrations(sqlite);
  applyEngineMigrations(sqlite);

  const now = Date.now();
  sqlite
    .prepare("INSERT OR IGNORE INTO orgs (id, name, created_at) VALUES (?, ?, ?)")
    .run("local-org", "Local Dev", now);
  sqlite
    .prepare("INSERT OR IGNORE INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("local-user", "local@dev", "Local Dev", "admin", now);
  sqlite
    .prepare("INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)")
    .run("local-org", "local-user", "admin");

  const db = buildAppDb(sqlite);
  const engineDb = drizzle(sqlite);
  const engineStore = new SqliteSessionStore(engineDb);
  const sandboxProvider = new VirtualSandboxProvider();
  const eventStream = new SqliteEventStream(sqlite);
  const engineCredentials = new InMemoryCredentialStore();
  const blobs = new FsBlobStore(join(dirname(dbPath), "blobs"));

  let spawnerRef: ChildSpawner | undefined;
  const engineHost = new EngineHost({
    engineStore,
    sandboxProvider,
    eventStream,
    engineCredentials,
    blobs,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    db,
    // Never actually served in this process — the orchestrator's own turn
    // is never driven here (the spawn call bypasses its LLM turn entirely),
    // so nothing ever dials this URL.
    apiBaseUrl: "http://127.0.0.1:0",
    childSpawner: (req, ctx) => {
      if (!spawnerRef) throw new Error("childSpawner invoked before provider wiring completed");
      return spawnerRef(req, ctx);
    },
  });

  const childrenDeps = { db, engineHost, engineStore, workspaceRoot: join(dirname(dbPath), "children") };
  const watcher = new ChildWatcher(childrenDeps);
  const spawner = buildChildSpawner(childrenDeps, watcher);
  spawnerRef = spawner;

  const principal = { type: "user" as const, id: "local-user" };
  const session = await engineHost.orchestratorSessionFor(principal, {
    actorUserId: "local-user",
    orgId: "local-org",
  });
  const parentThreadId = session.thread().id;

  // Direct spawn call — bypasses the `task` tool / any LLM turn on the
  // parent for determinism (task-10 brief). `buildChildSpawner` durably
  // inserts the `child_watches` row and arms the watcher (fire-and-forget)
  // before this call resolves; the child's own real-model turn keeps
  // running asynchronously past this point — the exact race window this
  // test needs to kill inside.
  const result = await spawner(
    { prompt: "Run the bash command `echo p4-restart-ok` and then stop.", title: "p4-restart-child" },
    {
      parentSessionId: session.id,
      parentThreadId,
      actorUserId: "local-user",
      owner: principal,
    },
  );

  process.stdout.write(`READY:${result.childSessionId}|${result.queueItemId}|${session.id}|${parentThreadId}\n`);

  // Hang until the test process SIGKILLs us.
  setInterval(() => {}, 1000);
}

main().catch((err) => {
  process.stderr.write(`p4-restart-child fatal: ${String(err)}\n`);
  process.exit(1);
});
