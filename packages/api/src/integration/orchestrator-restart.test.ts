/**
 * Cross-process restart proof: Phase 4 exit criterion "survives a process
 * restart mid-child-run — settlement signal still delivered exactly once"
 * (decision 11, roadmap "Exit Criteria" section, Task 10).
 *
 * Structure mirrors `packages/engine/test/kill-mid-gate.test.ts`: this test
 * process spawns a CHILD PROCESS (`../../test/p4-restart-child.ts`) that
 * boots a full API provider stack over a real sqlite file, ensures the
 * orchestrator, and spawns a child session by calling the `ChildSpawner`
 * DIRECTLY (bypassing the LLM turn on the parent for determinism). The
 * spawner durably inserts the `child_watches` row and arms the watcher
 * BEFORE returning — the checkpoint this test needs — so killing the
 * process right after it prints readiness lands squarely mid-child-run:
 * the watch row exists, but the child's own real-model turn hasn't
 * settled yet.
 *
 * This process then boots a FRESH provider stack over the SAME db file
 * (the "process B" restart), restores the child session (mirroring
 * `main.ts`'s `restoreUnsettledSessions`), calls `ChildWatcher.rearm()`
 * (mirroring `main.ts`'s boot sequence), and asserts: the child's
 * submission settles, and the spawning parent thread gains EXACTLY ONE
 * `child.settled` signal entry — proof that `awaitResult`'s resumability
 * plus the deterministic `dispatchId` (`settled:{childSessionId}:{queueItemId}`)
 * together survive the crash without double-delivery.
 *
 * Key-gated (the child needs a real model for its post-restart turn);
 * Docker is NOT required — the child runs on a `VirtualSandboxProvider`.
 */
import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { InMemoryCredentialStore, VirtualSandboxProvider, type ChildSpawner, type MessageEntry } from "@valet/engine";
import { PgSessionStore, PgEventStream, pgDbFromPglite, applyEngineMigrations } from "@valet/store-postgres";
import { applyAppMigrations, buildAppDb } from "../lib/drizzle.js";
import { EngineHost } from "../engine/host.js";
import { buildChildSpawner, ChildWatcher } from "../orchestrator/children.js";
import { SourceService } from "../bakes/source-service.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { FsBlobStore } from "../providers/blob-fs.js";
import { agentSessions } from "../schema/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ROOT = join(__dirname, "..", "..");
const CHILD = join(API_ROOT, "test", "p4-restart-child.ts");

const describeIfKey = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;

/** Poll a predicate until true or the deadline; throws on timeout. */
async function poll(predicate: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Boots a fresh provider stack over the PGlite instance persisted at
 * `pgDataDir` — same wiring as `p4-restart-child.ts` and
 * `providers/node.ts`, but with a `VirtualSandboxProvider` (no Docker
 * needed for this test). */
async function bootRestoredProviders(pgDataDir: string) {
  const pglite = new PGlite(pgDataDir);
  const pgdb = pgDbFromPglite(pglite);
  await applyAppMigrations(pgdb);
  await applyEngineMigrations(pgdb);

  const db = buildAppDb(pglite);
  const engineStore = new PgSessionStore(pgdb);
  const sandboxProvider = new VirtualSandboxProvider();
  const eventStream = new PgEventStream(pgdb);
  const engineCredentials = new InMemoryCredentialStore();
  const blobs = new FsBlobStore(join(dirname(pgDataDir), "blobs"));

  let spawnerRef: ChildSpawner | undefined;
  const engineHost = new EngineHost({
    engineStore,
    sandboxProvider,
    eventStream,
    engineCredentials,
    blobs,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    db,
    apiBaseUrl: "http://127.0.0.1:0",
    childSpawner: (req, ctx) => {
      if (!spawnerRef) throw new Error("childSpawner invoked before provider wiring completed");
      return spawnerRef(req, ctx);
    },
  });
  // No builder, no GitHub credential — the spawner's zero-config
  // `ensureRepoSource` path is a silent no-op here (and never throws).
  const prebuildService = new SourceService({
    db,
    builder: null,
    githubTokenDeps: { db, credentials: engineCredentials, key: deriveSecretKey("test-key") },
  });
  const childrenDeps = { db, engineHost, engineStore, prebuildService, workspaceRoot: join(dirname(pgDataDir), "children") };
  const childWatcher = new ChildWatcher(childrenDeps);
  spawnerRef = buildChildSpawner(childrenDeps, childWatcher);

  return { pglite, db, engineStore, engineHost, childWatcher };
}

function signalEntries(entries: MessageEntry[], childSessionId: string): MessageEntry[] {
  return entries.filter(
    (e) => e.signal?.signalType === "child.settled" && e.signal.attributes?.child_session_id === childSessionId,
  );
}

describeIfKey("api integration: cross-process restart mid-child-run (Phase 4 exit criterion)", () => {
  it(
    "SIGKILL while a child's turn is unsettled -> restart re-arms -> exactly one child.settled signal",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "valet-p4-restart-"));
      const dbPath = join(dir, "pgdata");

      // ── Phase 1: child process ensures orchestrator, spawns a child
      //    directly via ChildSpawner, then gets SIGKILLed mid-run. ──
      const child: ChildProcess = spawn(
        process.execPath,
        ["--import", "tsx", CHILD, dbPath],
        { cwd: API_ROOT, stdio: ["ignore", "pipe", "pipe"], env: process.env },
      );

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (b: Buffer) => {
        stdout += b.toString();
      });
      child.stderr?.on("data", (b: Buffer) => {
        stderr += b.toString();
      });
      const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));

      try {
        await poll(() => /READY:\S+/.test(stdout), 30_000, `READY (stderr: ${stderr})`);
        const match = stdout.match(/READY:([^|]+)\|([^|]+)\|([^|]+)\|(\S+)/);
        expect(match).toBeTruthy();
        if (!match) throw new Error("no READY match");
        const [, childSessionId, queueItemId, parentSessionId, parentThreadId] = match;

        // Brief settle window so the durable child_watches row + queued
        // submission are unambiguously committed before we yank the process.
        await new Promise((r) => setTimeout(r, 250));

        child.kill("SIGKILL");
        await exited;

        // ── Phase 2: fresh provider stack over the same db — the "restart". ──
        const restored = await bootRestoredProviders(dbPath);
        try {
          // Sanity: the child's submission is indeed unsettled after the crash.
          const unsettledIds = await restored.engineStore.listSessionIdsWithUnsettledSubmissions();
          expect(unsettledIds).toContain(childSessionId);

          // Mirrors main.ts's restoreUnsettledSessions: materialize every
          // unsettled session so the engine's claim loop can resume it.
          for (const id of unsettledIds) {
            const rows = await restored.db.select().from(agentSessions).where(eq(agentSessions.id, id)).limit(1);
            const row = rows[0];
            if (!row) continue;
            await restored.engineHost.sessionFor(id, { userId: row.userId, orgId: row.orgId, workspace: row.workspace });
          }

          // Mirrors main.ts's childWatcher.rearm() boot call — the
          // restart-survival mechanism under test.
          await restored.childWatcher.rearm();

          // The child's submission settles post-restart (real model call).
          await poll(
            async () => {
              const item = await restored.engineStore.getQueueItem(childSessionId, queueItemId);
              return item?.status === "settled";
            },
            120_000,
            "child submission settled",
          );

          // Exactly one child.settled signal landed on the spawning parent
          // thread — the deterministic dispatchId
          // (`settled:{childSessionId}:{queueItemId}`) deduped the re-arm.
          const parent = await restored.engineHost.sessionFor(parentSessionId, {
            userId: "local-user",
            orgId: "local-org",
            workspace: "/irrelevant-for-orchestrator-ids",
          });
          // Thread identity survived the restart — same engine thread id,
          // reachable by the well-known "web:default" key `readEntries`
          // resolves by (session.thread() key lookup, not id lookup).
          expect(parent.thread("web:default").id).toBe(parentThreadId);

          await poll(
            async () => {
              const entries = ((await parent.readEntries("web:default")) ?? []) as MessageEntry[];
              return signalEntries(entries, childSessionId).length >= 1;
            },
            30_000,
            "child.settled signal entry",
          );
          const entriesAfterFirstArm = ((await parent.readEntries("web:default")) ?? []) as MessageEntry[];
          expect(signalEntries(entriesAfterFirstArm, childSessionId)).toHaveLength(1);

          // Re-arming again (as a second boot would) must not double-deliver —
          // the actual "exactly one" guarantee is the engine's dispatchId
          // idempotent admission, not any in-process bookkeeping.
          await restored.childWatcher.rearm();
          await new Promise((r) => setTimeout(r, 500));
          const entriesAfterSecondArm = ((await parent.readEntries("web:default")) ?? []) as MessageEntry[];
          expect(signalEntries(entriesAfterSecondArm, childSessionId)).toHaveLength(1);

          // The child actually ran its turn after the restart.
          const childSession = await restored.engineHost.sessionFor(childSessionId, {
            userId: "local-user",
            orgId: "local-org",
            workspace: join(dirname(dbPath), "children", childSessionId),
          });
          const childEntries = (await childSession.readEntries("web:default")) ?? [];
          expect(JSON.stringify(childEntries)).toContain("p4-restart-ok");
        } finally {
          await restored.engineHost.destroyAll();
          await restored.pglite.close();
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await rm(dir, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
