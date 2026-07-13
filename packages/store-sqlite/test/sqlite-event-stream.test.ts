import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runEventStreamContract } from "@valet/engine/test-helpers";
import { ValidationError } from "@valet/engine";
import type { QueueItem } from "@valet/engine";
import { applyEngineMigrations } from "../src/migrate.js";
import { SqliteEventStream } from "../src/event-stream.js";
import { SqliteSessionStore } from "../src/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const APPEND_CHILD = join(__dirname, "append-child.ts");

// The contract suite's fence cases call ctx.factory() once, then
// fenceFixture.seed() immediately after, within the same `it`. This closure
// tracks the store built over the most recently created sqlite handle so
// seed() writes land in the same database the freshly-created stream reads.
let currentStore: SqliteSessionStore | undefined;

const FENCE_SESSION = "fence-sess";
const FENCE_THREAD = "fence-thread";

/** Spawns append-child.ts and resolves with its exit info once it exits. */
function spawnAppendChild(
  dbPath: string,
  prefix: string,
  count: number,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(
      process.execPath,
      ["--import", "tsx", APPEND_CHILD, dbPath, prefix, String(count)],
      { cwd: PACKAGE_ROOT, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

runEventStreamContract("SqliteEventStream", {
  factory: () => {
    const sqlite = new Database(":memory:");
    applyEngineMigrations(sqlite);
    currentStore = new SqliteSessionStore(drizzle(sqlite));
    return new SqliteEventStream(sqlite);
  },
  fenceFixture: {
    seed: async (itemId: string) => {
      const store = currentStore;
      if (!store) throw new Error("fenceFixture.seed called before factory()");
      const now = Date.now();
      await store.saveSession({
        id: FENCE_SESSION,
        owner: { type: "user", id: "u1" },
        userId: "u1",
        orgId: "o1",
        workspace: "/",
        purpose: "interactive",
        status: "running",
        createdAt: now,
        updatedAt: now,
      });
      await store.saveThread(FENCE_SESSION, {
        id: FENCE_THREAD,
        sessionId: FENCE_SESSION,
        key: "web:default",
        status: "active",
        queueMode: "followup",
        createdAt: now,
        updatedAt: now,
      });
      const admitItem: QueueItem = {
        id: itemId,
        threadId: FENCE_THREAD,
        content: "seed submission",
        status: "queued",
        attemptCount: 0,
        maxAttempts: 10,
        timeoutAt: now + 3_600_000,
        createdAt: now,
        updatedAt: now,
      };
      await store.admitSubmission(FENCE_SESSION, FENCE_THREAD, admitItem);
      const attemptId = `att-${itemId}`;
      const claimed = await store.claimSubmission({
        sessionId: FENCE_SESSION,
        threadId: FENCE_THREAD,
        itemId,
        attemptId,
        ownerId: "owner-1",
      });
      if (!claimed) throw new Error("fenceFixture.seed: claim failed");
      return { currentAttemptId: attemptId };
    },
  },
});

describe("SqliteEventStream (sqlite-specific)", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it(
    "produces a dense gapless sequence under concurrent appends from two OS processes",
    async () => {
      dir = mkdtempSync(join(tmpdir(), "valet-event-stream-"));
      const dbPath = join(dir, "app.db");
      const sessionId = "concurrent-session";

      // Parent creates the db and runs migrations first, so the two children
      // race real writers against an already-migrated file rather than racing
      // each other over `applyEngineMigrations`.
      const primary = new Database(dbPath);
      applyEngineMigrations(primary);
      primary.close();

      const [a, b] = await Promise.all([
        spawnAppendChild(dbPath, "a", 50),
        spawnAppendChild(dbPath, "b", 50),
      ]);

      if (a.code !== 0) throw new Error(`child a exited ${a.code}: ${a.stderr}`);
      if (b.code !== 0) throw new Error(`child b exited ${b.code}: ${b.stderr}`);

      // Fresh connection, independent of either child, to read back the result.
      const reader = new Database(dbPath);
      try {
        const stream = new SqliteEventStream(reader);
        const { events } = await stream.read(sessionId, { limit: 500 });

        const seqs = events.map((e) => Number(e.offset)).sort((x, y) => x - y);
        expect(seqs).toHaveLength(100);
        expect(new Set(seqs).size).toBe(100);
        expect(seqs[0]).toBe(1);
        expect(seqs[99]).toBe(100);

        const keys = new Set<string>();
        for (let i = 0; i < 50; i++) {
          keys.add(`a-${i}`);
          keys.add(`b-${i}`);
        }
        const rows = reader
          .prepare(`SELECT event_key FROM engine_events WHERE session_id = ?`)
          .all(sessionId) as Array<{ event_key: string }>;
        const eventKeys = new Set(rows.map((r) => r.event_key));
        expect(eventKeys).toEqual(keys);
      } finally {
        reader.close();
      }
    },
    30_000,
  );

  it("rejects a non-numeric fromOffset with ValidationError", async () => {
    const sqlite = new Database(":memory:");
    try {
      applyEngineMigrations(sqlite);
      const stream = new SqliteEventStream(sqlite);
      await expect(stream.read("some-session", { fromOffset: "not-a-number" })).rejects.toThrow(
        ValidationError,
      );
    } finally {
      sqlite.close();
    }
  });
});
