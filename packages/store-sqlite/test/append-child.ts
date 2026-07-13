/**
 * Child entrypoint for the cross-process BEGIN IMMEDIATE append proof
 * (sqlite-event-stream.test.ts). Opens the file-backed db the parent already
 * migrated, sets a per-connection busy_timeout, and appends `count` events
 * with eventKeys `${prefix}-${i}` in a tight loop — the point is to have two
 * OS processes racing writers on the same sqlite file, which a synchronous
 * in-process `Promise.all` (same test, single connection pool) can never
 * exercise.
 *
 * argv: [dbPath, prefix, count]
 */
import Database from "better-sqlite3";
import { SqliteEventStream } from "../src/event-stream.js";

const [dbPath, prefix, countStr] = process.argv.slice(2);
if (!dbPath || !prefix || !countStr) {
  process.stderr.write("usage: append-child.ts <dbPath> <prefix> <count>\n");
  process.exit(2);
}
const count = Number(countStr);

async function main(): Promise<void> {
  const sqlite = new Database(dbPath);
  // journal_mode is a database-level property (persists once set to WAL by
  // the parent's migration open), but busy_timeout is per-connection — must
  // be set here too, or this process legitimately throws SQLITE_BUSY while
  // racing the other child's BEGIN IMMEDIATE transaction.
  sqlite.pragma("busy_timeout = 5000");

  const stream = new SqliteEventStream(sqlite);
  const sessionId = "concurrent-session";

  for (let i = 0; i < count; i++) {
    await stream.append(
      {
        sessionId,
        event: { type: "status", threadId: "thread-1", status: "idle" },
        timestamp: Date.now(),
      },
      `${prefix}-${i}`,
    );
  }

  sqlite.close();
}

main().catch((err) => {
  process.stderr.write(`append-child fatal: ${String(err)}\n`);
  process.exit(1);
});
