/**
 * Phase 0 spike: express engine-v2 submission fencing (claim / lease takeover /
 * fenced append) as single-statement CAS writes in better-sqlite3, and prove a
 * zombie writer is rejected. See FINDINGS-fencing.md for results.
 *
 * Run (from repo root):
 *   pnpm --filter @valet/store-sqlite exec tsx experiments/fencing-spike.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dbPath = join(mkdtempSync(join(tmpdir(), "fencing-spike-")), "spike.db");

function connect(): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  return db;
}

const admin = connect();
admin.exec(`
  CREATE TABLE submissions (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    status TEXT NOT NULL,             -- queued|running|terminalizing|settled
    attempt_id TEXT,
    lease_expires_at INTEGER
  );
  CREATE TABLE entries (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    queue_item_id TEXT NOT NULL,
    body TEXT NOT NULL
  );
`);
admin.prepare(
  "INSERT INTO submissions (id, thread_id, status) VALUES ('sub1', 't1', 'queued')",
).run();

// Two independent connections on the same file — two "processes".
const connA = connect(); // original owner (will become the zombie)
const connB = connect(); // reconciler / new owner

const CLAIM = `
  UPDATE submissions SET status = 'running', attempt_id = @attempt, lease_expires_at = @lease
  WHERE id = @id AND status = 'queued'`;
const HEARTBEAT = `
  UPDATE submissions SET lease_expires_at = @lease
  WHERE id = @id AND attempt_id = @attempt AND status = 'running'`;
const REPLACE_ATTEMPT = `
  UPDATE submissions SET attempt_id = @newAttempt, lease_expires_at = @lease
  WHERE id = @id AND status = 'running' AND attempt_id = @oldAttempt AND lease_expires_at < @now`;
const FENCED_APPEND = `
  INSERT INTO entries (id, thread_id, queue_item_id, body)
  SELECT @entryId, @threadId, @itemId, @body
  WHERE EXISTS (SELECT 1 FROM submissions WHERE id = @itemId AND attempt_id = @attempt)`;

const results: string[] = [];
function check(name: string, cond: boolean, detail: string): void {
  const line = `${cond ? "PASS" : "FAIL"} — ${name} (${detail})`;
  console.log(line);
  results.push(line);
  assert.ok(cond, name);
}

const now = 1_000_000; // fixed fake clock; leases are plain integers
const leaseA = now + 30_000;

// 1. Claim is CAS: A wins, B's identical claim is a no-op.
const claimA = connA.prepare(CLAIM).run({ id: "sub1", attempt: "attempt-A", lease: leaseA });
check("claim: A wins", claimA.changes === 1, `changes=${claimA.changes}`);
const claimB = connB.prepare(CLAIM).run({ id: "sub1", attempt: "attempt-B", lease: leaseA });
check("claim: B loses CAS on running row", claimB.changes === 0, `changes=${claimB.changes}`);

// A can append while it owns the attempt.
const appendLive = connA.prepare(FENCED_APPEND).run({
  entryId: "e1", threadId: "t1", itemId: "sub1", body: "assistant-partial", attempt: "attempt-A",
});
check("fenced append: live owner writes", appendLive.changes === 1, `changes=${appendLive.changes}`);

// 2. Lease takeover: rejected while unexpired / wrong attempt; succeeds when expired.
const earlyTakeover = connB.prepare(REPLACE_ATTEMPT).run({
  id: "sub1", newAttempt: "attempt-B", oldAttempt: "attempt-A", lease: now + 60_000, now,
});
check("takeover: rejected while lease unexpired", earlyTakeover.changes === 0, `changes=${earlyTakeover.changes}`);
const wrongAttempt = connB.prepare(REPLACE_ATTEMPT).run({
  id: "sub1", newAttempt: "attempt-B", oldAttempt: "attempt-X", lease: now + 60_000, now: leaseA + 1,
});
check("takeover: rejected on wrong prior attempt", wrongAttempt.changes === 0, `changes=${wrongAttempt.changes}`);
const takeover = connB.prepare(REPLACE_ATTEMPT).run({
  id: "sub1", newAttempt: "attempt-B", oldAttempt: "attempt-A", lease: leaseA + 60_000, now: leaseA + 1,
});
check("takeover: succeeds after expiry with matching attempt", takeover.changes === 1, `changes=${takeover.changes}`);

// 3. Zombie heartbeat rejected.
const zombieBeat = connA.prepare(HEARTBEAT).run({ id: "sub1", attempt: "attempt-A", lease: leaseA + 120_000 });
check("heartbeat: zombie rejected", zombieBeat.changes === 0, `changes=${zombieBeat.changes}`);

// 4. Fenced append: zombie rejected, new owner accepted — single statement each.
const zombieAppend = connA.prepare(FENCED_APPEND).run({
  entryId: "e2", threadId: "t1", itemId: "sub1", body: "zombie-write", attempt: "attempt-A",
});
check("fenced append: zombie rejected", zombieAppend.changes === 0, `changes=${zombieAppend.changes}`);
const ownerAppend = connB.prepare(FENCED_APPEND).run({
  entryId: "e3", threadId: "t1", itemId: "sub1", body: "reconciler-write", attempt: "attempt-B",
});
check("fenced append: new owner writes", ownerAppend.changes === 1, `changes=${ownerAppend.changes}`);

// 5. Multi-row fenced append is all-or-nothing.
function fencedBatch(db: Database.Database, attempt: string, ids: string[]): number {
  const stmt = db.prepare(FENCED_APPEND);
  const tx = db.transaction((rows: string[]) => {
    let landed = 0;
    for (const entryId of rows) {
      const r = stmt.run({ entryId, threadId: "t1", itemId: "sub1", body: `batch-${attempt}`, attempt });
      if (r.changes === 0) throw new Error("FENCE_REJECTED"); // rolls back the whole batch
      landed += r.changes;
    }
    return landed;
  });
  try {
    return tx(ids);
  } catch (err) {
    if (err instanceof Error && err.message === "FENCE_REJECTED") return 0;
    throw err;
  }
}
const zombieBatch = fencedBatch(connA, "attempt-A", ["e4", "e5", "e6"]);
const zombieRows = (admin.prepare("SELECT COUNT(*) AS n FROM entries WHERE body = 'batch-attempt-A'").get() as { n: number }).n;
check("batch append: zombie batch lands zero rows", zombieBatch === 0 && zombieRows === 0, `returned=${zombieBatch}, rows=${zombieRows}`);
const ownerBatch = fencedBatch(connB, "attempt-B", ["e7", "e8", "e9"]);
check("batch append: owner batch lands all rows", ownerBatch === 3, `returned=${ownerBatch}`);

console.log("\n--- summary ---");
for (const line of results) console.log(line);
console.log(`db: ${dbPath}`);
