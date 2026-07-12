# Findings: SQLite CAS fencing spike

Run: 2026-07-11, better-sqlite3 11.10.0, Node 22.22.2, WAL + busy_timeout=5000.
Script: `experiments/fencing-spike.ts` (rerunnable, no network).

## Verdict for Phase 1

The fencing contract's **logical CAS properties** are fully expressible as single-statement CAS writes in better-sqlite3. All five properties (claim CAS, lease takeover CAS with all three rejection legs tested — unexpired lease, wrong prior attempt, and wrong status against a settled row — zombie heartbeat rejection, fenced single-row append, fenced multi-row append with all-or-nothing atomicity) verified on a single database file with two independent `Database` connections simulating crashed owner + reconciler. The database itself enforces the fencing constraints via WHERE clause conditions, and the `changes` return value (0 = no match, 1 = matched and written) provides the single-statement CAS semantics without needing explicit locks. Multi-row batches wrapped in `db.transaction()` provide all-or-nothing atomicity (first fence rejection throws, rolling back all prior writes in the batch).

**What was NOT exercised by this spike:** better-sqlite3 is fully synchronous, and the spike's two connections (`connA`/`connB`) never issued overlapping writes — each `.run()` call completes before the next one starts, so there was no actual write-write contention, no `SQLITE_BUSY` was ever raised, and `busy_timeout` was never invoked. WAL mode, `busy_timeout=5000`, and `synchronous=NORMAL` were configured and did not prevent the 13 CAS checks from passing, but their adequacy under *real* concurrent cross-process load — i.e. two OS processes genuinely racing for the same write lock — is a reasoned claim from SQLite's documented behavior, not something this spike observed. Whether `busy_timeout=5000` is long enough under production reconciler contention, and how the CAS retry logic behaves when `SQLITE_BUSY` actually fires, remain open questions. Phase 1's kill-mid-turn integration test (real separate processes, real timing) is where cross-process contention actually gets exercised; treat this spike's "PASS" as validating the SQL idioms and fencing logic only, not the concurrency runtime behavior around them.

## Canonical SQL idioms (copy into the Phase 1 store rewrite)

- claimSubmission: `UPDATE submissions SET status = 'running', attempt_id = @attempt, lease_expires_at = @lease WHERE id = @id AND status = 'queued'`
- heartbeatLease: `UPDATE submissions SET lease_expires_at = @lease WHERE id = @id AND attempt_id = @attempt AND status = 'running'`
- replaceSubmissionAttempt: `UPDATE submissions SET attempt_id = @newAttempt, lease_expires_at = @lease WHERE id = @id AND status = 'running' AND attempt_id = @oldAttempt AND lease_expires_at < @now`
- fenced appendEntries (single row): `INSERT INTO entries (id, thread_id, queue_item_id, body) SELECT @entryId, @threadId, @itemId, @body WHERE EXISTS (SELECT 1 FROM submissions WHERE id = @itemId AND attempt_id = @attempt)`
- fenced appendEntries (batch): fence re-checked per row inside one better-sqlite3 transaction; first rejection throws → full rollback. Confirmed: zombie batch attempted after takeover returns 0 rows landed (exception caught, transaction rolled back), owner batch lands all 3 rows.
- settleSubmission: `UPDATE submissions SET status = 'settled' WHERE id = @id AND attempt_id = @attempt AND status = 'running'`

## Property results

| Property | Result |
|---|---|
| claim CAS, exactly one winner | PASS — A claims → changes=1; B re-claims same row → changes=0 |
| takeover rejected: unexpired lease / wrong attempt | PASS — both rejections observed (changes=0 in both cases) |
| takeover rejected: wrong status (settled row) | PASS — row settled via CAS (changes=1), then REPLACE_ATTEMPT with matching attempt + expired lease → changes=0 |
| takeover succeeds after expiry | PASS — succeeds when lease_expires_at < @now AND attempt_id matches |
| zombie heartbeat rejected | PASS — changes=0 after takeover |
| zombie single append rejected (changes=0) | PASS — fence exists condition fails on stale attempt_id |
| zombie batch lands zero rows | PASS — first row's fence rejection throws, entire batch rolls back, zero rows in DB |

## Rules Phase 1 must adopt

- **`synchronous=NORMAL` vs `synchronous=FULL` is a deliberate Phase 1 decision, not an inherited spike default.** In WAL mode, `synchronous=NORMAL` fsyncs less often than `FULL`: it durably syncs the WAL on checkpoint but not necessarily after every commit, which means it survives an application/process crash (WAL replay recovers committed transactions) but can lose the most recently committed transaction(s) on an OS crash or power loss, because that commit may still be sitting in the OS page cache rather than on disk. `synchronous=FULL` fsyncs on every commit, closing that window at the cost of a disk sync per write (slower, especially under write-heavy fencing/heartbeat traffic). This spike used NORMAL and it did not cause any of the 13 CAS checks to fail, but that only shows NORMAL doesn't break logical correctness — it says nothing about durability under power loss. Since submissions/entries are a durability-premised subsystem (crash recovery, exactly-once fencing), Phase 1 must explicitly choose NORMAL (accept the power-loss window in exchange for throughput) or FULL (no window, slower) rather than carrying NORMAL forward because "the spike used it."
- Cross-process `SQLITE_BUSY` / `busy_timeout` behavior must be validated by Phase 1's kill-mid-turn integration test (real separate OS processes racing for the write lock), not assumed from this spike — this spike's two connections never contended for a write lock at all.

## Surprises / gotchas

- **`changes` counting is reliable for CAS.** `db.prepare().run()` returns `{ changes }` (number of rows affected). For UPDATE/DELETE, changes=0 means WHERE condition failed. For INSERT…SELECT…WHERE EXISTS, changes=0 means the subquery found no match. This is the core fencing primitive.
- **Transactions + exception handling implement all-or-nothing batches.** `db.transaction()` wraps the callback; if any statement throws, the whole transaction rolls back. In the spike, the batch loop throws `FENCE_REJECTED` on first failure, causing a rollback. Phase 1 should use this pattern: `db.transaction(() => { for (row of batch) { if (stmt.run().changes === 0) throw new Error("fence"); } })()`
- **WAL + synchronous=NORMAL was not stressed.** Better-sqlite3 defaults to WAL mode in recent versions. Synchronous=NORMAL (default) does not invoke fsync after every write; WAL is documented to keep writes ordered on disk and to make NORMAL safe against *application* crashes, but this spike never generated actual concurrent write pressure to confirm it under load — it only confirms the logical CAS invariants hold via WHERE clauses, which is isolation-mode-independent. The spike never sets SERIALIZABLE isolation; default READ_UNCOMMITTED worked here because the WHERE clauses enforce the invariants — but that is a property of the CAS SQL, not evidence about isolation behavior under real contention.
- **No lock contention observed — this is a gap, not a finding.** Both connections opened the same .db file without explicit PRAGMA locking; `busy_timeout=5000` prevents `ERR_CANTOPEN` but was never hit in the spike because better-sqlite3 is synchronous and the spike's two connections never issued overlapping writes. Whether 5000ms is adequate for real reconciler contention, and how the CAS retry path behaves when `SQLITE_BUSY` actually fires, is untested and reasoned-only. Do not read "no lock contention observed" as "no lock contention will occur" — it means the spike didn't create the conditions to observe it either way.
- **Database file WAL artifacts.** The -wal and -shm files created alongside the .db file are expected and managed by SQLite. Phase 1 must preserve these during snapshot/restore operations.
