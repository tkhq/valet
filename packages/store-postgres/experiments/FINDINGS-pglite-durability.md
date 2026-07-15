# Findings: PGlite SIGKILL durability spike

Run: 2026-07-15, @electric-sql/pglite 0.5.4, Node 22.22.2, macOS (darwin arm64, APFS, /tmp data dirs).
Script: `experiments/durability-spike.ts` (rerunnable, no network).

## Verdict: PASS

**60/60 SIGKILL cycles with zero durability violations.** PGlite on a NodeFS
data dir survives `SIGKILL` mid-write: every commit whose promise resolved
before the kill was present in the reopened database, every row's checksum
was intact, and the database reopened cleanly every time.

- **Durable config** (`relaxedDurability: false`): 50 kill cycles, 1,872
  acked commits total, 0 violations. 1,873 rows recovered — exactly one row
  across all 50 cycles was committed-but-not-yet-acked at kill time (the safe
  direction: extra durable data, never lost acked data).
- **Relaxed config** (`relaxedDurability: true`): 10 kill cycles, 315 acked
  commits, 0 violations. No observable behavioral difference under NodeFS
  (see "Config notes" below for why).

Recommendation line for the plan: **PGlite-for-dev OK** — decisions 2-3 of
`docs/specs/2026-07-15-postgres-backend-design.md` stand as specced; the
dockerized postgres:17 fallback is not needed for crash-durability reasons.

## Method

Ported from `packages/store-sqlite/experiments/fencing-spike.ts`'s
child-process harness shape:

1. Parent spawns a **writer** child per cycle on a fresh temp data dir. The
   writer opens PGlite, creates `spike_rows (seq INTEGER PRIMARY KEY,
   checksum TEXT)`, prints `READY`, then loops single-transaction inserts of
   `(seq, sha256(seq + salt))` as fast as it can. After each commit promise
   resolves it appends the seq to a plain ack log via `writeSync` +
   `fsyncSync` — so the ack log itself is durable and an ack can only exist
   for a commit PGlite claimed was done.
2. Parent waits for `READY` (PGlite cold boot is ~1.25s and must not eat the
   kill window), sleeps a randomized **50-500ms**, then SIGKILLs the
   writer's whole process group.
3. Parent spawns a **validator** child that reopens the data dir with a
   fresh PGlite, reads all rows, verifies checksums, and reports as JSON.
   Parent then asserts every acked seq is present.

Violations checked, per cycle: DB fails to reopen; any checksum mismatch;
any acked-but-missing seq (the core durability violation). Max committed seq
per cycle is recorded (26-72 commits per kill window in the durable run).

## Config notes (what "most durable configuration" means for PGlite 0.5.x)

Read from the installed package's `dist/pglite-CpaPhfpC.d.ts` and pglite.dev
docs:

- `PGliteOptions.relaxedDurability?: boolean` is the only durability knob.
  Per the docs it schedules the post-query `syncToFs()` flush asynchronously
  instead of awaiting it — but this mechanism exists for the browser
  filesystems (IndexedDB/OPFS), where PGlite buffers pages in memory and
  flushes to the backing store. There is no documented default; the code
  treats `undefined` as falsy (flush awaited).
- On Node with a `dataDir` path, PGlite mounts **NODEFS** (emscripten
  filesystem passthrough, `dist/fs/nodefs.js`) — reads/writes go directly to
  the host filesystem via real `fs` calls, with no intermediate buffer for
  `relaxedDurability` to relax. `BaseFilesystem.syncToFs()` is a no-op for
  NodeFS. This matches the spike's observation: `relaxedDurability: true`
  behaved identically to `false` under kill testing.
- The spike therefore ran its primary 50 cycles with `relaxedDurability:
  false` explicitly (the most durable configuration expressible), and this
  is also effectively the default under Node.

## Reopen behavior

- Reopen of a killed data dir: **~162ms average** (range 158-167ms) across
  all 60 cycles, vs ~1.25s for a cold create of a fresh data dir — reopening
  an existing dir skips initdb. No visible WAL-replay stalls; whatever
  recovery Postgres does on the killed dir is inside that ~160ms.
- No cycle required manual intervention; no data dir was left in a state
  PGlite refused to open.

## Surprises / gotchas (harness-level, but they will bite Task 1+ too)

- **tsx's CLI re-execs node.** Spawning children via `tsx/cli` and
  SIGKILLing the spawned pid kills only the wrapper; the real process
  (holding PGlite, inserting in a loop) is orphaned and runs forever. Early
  runs leaked one full-speed PGlite writer per cycle and drove the host into
  uninterruptible disk-wait. Fix: `node --import <tsx loader> file.ts`
  (in-process, the pid you spawn is the pid that dies) plus
  `detached: true` + process-group kill as a backstop.
- **PGlite's wasm heap is not reliably released by `close()`.** Reopening
  many databases sequentially in one long-lived process balloons RSS into
  the multi-GB range. The spike validates in a subprocess per cycle for this
  reason. Anything in Valet that cycles PGlite instances (tests, per-session
  DBs) should assume one PGlite per process lifetime, or budget for the
  leak.
- **PGlite cold create is ~1.25s** (wasm instantiation + initdb). Dev-boot
  code (Task 7) should expect a noticeable first-open cost per data dir, and
  ~160ms for subsequent opens.
- **Single-connection only.** The spike never exercised concurrent writers
  (PGlite is single-connection by design). Cross-process locking semantics
  are out of scope here and must not be assumed.

## Scope limits

- This proves **process-crash durability** (SIGKILL). It does not prove
  power-loss durability: NODEFS write() calls land in the OS page cache, and
  whether PGlite/emscripten issues a real fsync on commit was not verified
  at the syscall level. For a dev backend this is the right bar; do not cite
  this spike as evidence for prod-grade power-loss guarantees.
- macOS/APFS only. Linux dev containers should behave the same or better,
  but were not tested.
