import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEventStreamContract } from "@valet/engine/test-helpers";
import { ValidationError } from "@valet/engine";
import { applyEngineMigrations } from "../src/migrate.js";
import { SqliteEventStream } from "../src/event-stream.js";

runEventStreamContract("SqliteEventStream", {
  factory: () => {
    const sqlite = new Database(":memory:");
    applyEngineMigrations(sqlite);
    return new SqliteEventStream(sqlite);
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

  it("produces a dense gapless sequence under concurrent appends across two connections", async () => {
    dir = mkdtempSync(join(tmpdir(), "valet-event-stream-"));
    const dbPath = join(dir, "app.db");

    const primary = new Database(dbPath);
    applyEngineMigrations(primary);
    primary.close();

    const connA = new Database(dbPath);
    const connB = new Database(dbPath);
    connA.pragma("journal_mode = WAL");
    connA.pragma("busy_timeout = 5000");
    connB.pragma("journal_mode = WAL");
    connB.pragma("busy_timeout = 5000");

    const streamA = new SqliteEventStream(connA);
    const streamB = new SqliteEventStream(connB);

    const sessionId = "concurrent-session";
    const makeAppends = (stream: SqliteEventStream, prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) =>
        stream.append(
          {
            sessionId,
            event: { type: "status", threadId: "thread-1", status: "idle" },
            timestamp: Date.now(),
          },
          `${prefix}-${i}`,
        ),
      );

    await Promise.all([...makeAppends(streamA, "a", 50), ...makeAppends(streamB, "b", 50)]);

    const { events } = await streamA.read(sessionId, { limit: 500 });

    const seqs = events.map((e) => Number(e.offset)).sort((a, b) => a - b);
    expect(seqs).toHaveLength(100);
    expect(new Set(seqs).size).toBe(100);
    expect(seqs[0]).toBe(1);
    expect(seqs[99]).toBe(100);

    connA.close();
    connB.close();
  });

  it("rejects a non-numeric fromOffset with ValidationError", async () => {
    const sqlite = new Database(":memory:");
    applyEngineMigrations(sqlite);
    const stream = new SqliteEventStream(sqlite);
    await expect(stream.read("some-session", { fromOffset: "not-a-number" })).rejects.toThrow(ValidationError);
    sqlite.close();
  });
});
