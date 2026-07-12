# Findings: SQLite CAS fencing spike

Run: 2026-07-11, better-sqlite3 11.10.0, Node 22.22.2, WAL + busy_timeout=5000.
Script: `experiments/fencing-spike.ts` (rerunnable, no network).

## Verdict for Phase 1

The fencing contract is fully expressible as single-statement CAS writes in better-sqlite3. All five properties (claim CAS, lease takeover CAS with rejection on unexpired/wrong-attempt/wrong-status, zombie heartbeat rejection, fenced single-row append, fenced multi-row append with all-or-nothing atomicity) verified on a single database file with two independent `Database` connections simulating crashed owner + reconciler. WAL mode + `busy_timeout` + synchronous transactions are essential: the database itself enforces the fencing constraints via WHERE clause conditions, and the `changes` return value (0 = no match, 1 = matched and written) provides the single-statement CAS semantics without needing explicit locks. No SERIALIZABLE or other elevated isolation mode required — NORMAL synchronous is sufficient because the WHERE conditions are checked as part of the UPDATE/INSERT, and multi-row batches are wrapped in `db.transaction()` to ensure atomicity (first fence rejection throws, rolling back all prior writes in the batch).

## Canonical SQL idioms (copy into the Phase 1 store rewrite)

- claimSubmission: `UPDATE submissions SET status = 'running', attempt_id = @attempt, lease_expires_at = @lease WHERE id = @id AND status = 'queued'`
- heartbeatLease: `UPDATE submissions SET lease_expires_at = @lease WHERE id = @id AND attempt_id = @attempt AND status = 'running'`
- replaceSubmissionAttempt: `UPDATE submissions SET attempt_id = @newAttempt, lease_expires_at = @lease WHERE id = @id AND status = 'running' AND attempt_id = @oldAttempt AND lease_expires_at < @now`
- fenced appendEntries (single row): `INSERT INTO entries (id, thread_id, queue_item_id, body) SELECT @entryId, @threadId, @itemId, @body WHERE EXISTS (SELECT 1 FROM submissions WHERE id = @itemId AND attempt_id = @attempt)`
- fenced appendEntries (batch): fence re-checked per row inside one better-sqlite3 transaction; first rejection throws → full rollback. Confirmed: zombie batch attempted after takeover returns 0 rows landed (exception caught, transaction rolled back), owner batch lands all 3 rows.

## Property results

| Property | Result |
|---|---|
| claim CAS, exactly one winner | PASS — A claims → changes=1; B re-claims same row → changes=0 |
| takeover rejected: unexpired lease / wrong attempt | PASS — both rejections observed (changes=0 in both cases) |
| takeover succeeds after expiry | PASS — succeeds when lease_expires_at < @now AND attempt_id matches |
| zombie heartbeat rejected | PASS — changes=0 after takeover |
| zombie single append rejected (changes=0) | PASS — fence exists condition fails on stale attempt_id |
| zombie batch lands zero rows | PASS — first row's fence rejection throws, entire batch rolls back, zero rows in DB |

## Surprises / gotchas

- **`changes` counting is reliable for CAS.** `db.prepare().run()` returns `{ changes }` (number of rows affected). For UPDATE/DELETE, changes=0 means WHERE condition failed. For INSERT…SELECT…WHERE EXISTS, changes=0 means the subquery found no match. This is the core fencing primitive.
- **Transactions + exception handling implement all-or-nothing batches.** `db.transaction()` wraps the callback; if any statement throws, the whole transaction rolls back. In the spike, the batch loop throws `FENCE_REJECTED` on first failure, causing a rollback. Phase 1 should use this pattern: `db.transaction(() => { for (row of batch) { if (stmt.run().changes === 0) throw new Error("fence"); } })()`
- **WAL + synchronous=NORMAL sufficient.** Better-sqlite3 defaults to WAL mode in recent versions. Synchronous=NORMAL (default) does not invoke fsync after every write, but is safe for multi-process concurrent access because WAL ensures writes are ordered on disk. The spike never sets SERIALIZABLE isolation; default READ_UNCOMMITTED works because the WHERE clauses enforce the invariants.
- **No lock contention observed.** Both connections opened the same .db file without explicit PRAGMA locking; busy_timeout=5000 prevents ERR_CANTOPEN but was never hit in the spike (no contention). In production with many reconcilers, busy_timeout should still suffice because each submission has a unique row, and multiple reconcilers only contend if attempting simultaneous takeovers on the same submission (which should be rare if heartbeat intervals are tuned).
- **Database file WAL artifacts.** The -wal and -shm files created alongside the .db file are expected and managed by SQLite. Phase 1 must preserve these during snapshot/restore operations.
