# Engine v2 Phase 1 — Durable Submission Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accepted work survives anything: every prompt becomes a durable submission with CAS claims, leases, write fencing, two-phase settlement, and startup reconciliation — proven by a kill-the-process-mid-turn test with no duplicated side effects.

**Architecture:** Invert `packages/engine`'s in-memory queue (`Thread.pending` array + write-only `saveQueueState` blob) into a store-driven submission lifecycle per the engine spec's Durable Execution section. The store (`packages/store-sqlite`, `InMemorySessionStore`) gains submission lifecycle methods expressed as single-statement CAS writes (idioms proven in `packages/store-sqlite/experiments/FINDINGS-fencing.md`). The engine claims work from the store, fences its writes, settles two-phase, and reconciles unsettled submissions on restore. `awaitResult` resolves results from the transcript↔submission linkage (`queueItemId` + `stopReason`).

**Tech Stack:** TypeScript, Node 22, better-sqlite3 + Drizzle, `@mariozechner/pi-agent-core` 0.73.0 (`Agent` class API: `.prompt()`, `.continue()`, `.waitForIdle()`, `.subscribe()`), vitest, pi-ai faux provider (`registerFauxProvider`, `fauxAssistantMessage`, `fauxToolCall`).

**Authoritative contracts** (read before implementing — the plan restates the shapes, the spec is the tiebreaker):
- `docs/specs/2026-05-02-portable-runtime-engine-design.md` — "Per-Thread Prompt Queue" (~line 1082), "Durable Execution" (~1136: lifecycle, leases, reconciliation, fencing, terminalization), "Engine Public API" (~244: `PromptReceipt`, `awaitResult`, `SubmissionResult`), "Messages" (~504: `BaseEntry.queueItemId`, `MessageEntry.stopReason`), "SessionStore" (~1640), "Required Tables" (~1849), "Conformance" (~2438).
- `packages/store-sqlite/experiments/FINDINGS-fencing.md` — canonical CAS SQL idioms (claim, heartbeat, replace-attempt, fenced append, settle) and the WAL/`synchronous` guidance.
- `packages/engine/experiments/FINDINGS-continuation.md` — continuation rules (trailing message must be user/toolResult; interrupted tool calls become error results, never re-executed, because models may silently override fabricated results).

## Global Constraints

- Node 22: `source ~/.nvm/nvm.sh && nvm use 22.22.2` before any command. Run tests with `pnpm --filter @valet/engine test -- <pattern>` / `pnpm --filter @valet/store-sqlite test`.
- Pre-1.0 migration policy (CLAUDE.md): edit `packages/store-sqlite/migrations/sqlite/0000_lonely_lizard.sql` and `src/schema.ts` in place — NO new numbered migrations. After schema edits: `rm -f ~/.valet/app.db`.
- Type-safety rules (CLAUDE.md): no `any`, no `as unknown as T`, no `@ts-ignore`. Fix `any`s you touch.
- Every new store/engine behavior lands with its conformance test in the same task; the shared contract suites in `packages/engine/src/test-helpers/` are consumed by BOTH `packages/engine/test/in-memory-store.test.ts` and `packages/store-sqlite/test/sqlite-store.test.ts` — new store behavior goes into the shared suite, never into a backend-specific test.
- Interrupted tool calls are NEVER re-executed (spec, Terminalization). The one exception is decision-gate replay under its own contract.
- Fence parameters are typed `fence?: WriteFence` during this phase (transition ergonomics — the engine always passes one after Task 3; existing gate/compaction code paths are updated as they're touched). The contract suites assert rejection whenever a stale fence IS provided. Do not "tighten to required" mid-task; that cleanup is Task 7 Step 6.
- Durability defaults (spec): lease 30s, heartbeat ~10s, `maxAttempts` 10, `timeoutAt` = admission + 1h (not enforced while `blocked_on_decision_gate`), collect window 5s.
- SQLite stores open with `journal_mode=WAL`, `busy_timeout=5000`, `synchronous=FULL`. FULL is a deliberate Phase 1 decision (see FINDINGS-fencing.md: NORMAL can lose the last commit on power loss; this subsystem's premise is durability — revisit only with a benchmark showing it matters).
- Commit after each task; terse subjects ≤72 chars; no Co-Authored-By trailers.
- `pnpm typecheck` must pass at the end of every task (the API package consumes engine types — `packages/api/src/routes/messages.ts:244` calls `submitPrompt`; keep it compiling).

## Design decisions locked in by this plan

These resolve ambiguities the spec leaves to the implementation. Do not re-litigate them mid-task; if one proves wrong, stop and escalate.

1. **`QueueState` becomes a derived view.** `saveQueueState`/`getQueueState` and the `engine_queue_state` table are DELETED. The engine derives `QueueState` from unsettled queue items + `ThreadData.paused` when emitting `queue_state` events. (`ThreadData` gains a persisted `paused?: boolean`.)
2. **`settleUnclaimed` is a first-class store method.** Fenced `reserveSettlement`/`finalizeSettlement` cover claimed turns. Items that settle without ever being claimed (superseded queued items, merged collect constituents, abort-while-queued) settle through `settleUnclaimed` — a CAS that only succeeds when the item has no live attempt (`status IN ('collecting','queued')`). Keeps the fence contract honest instead of inventing dummy fences.
3. **Steer supersession is one store transaction** via `admitSubmission(..., { steer: true })`, which returns the superseded item ids. The engine then withdraws those items' gates and settles them `superseded` via `settleUnclaimed` (queued items) or the normal fenced path (the running item, settled by its own interrupted attempt handler or reconciliation). Gate withdrawal is engine-side (gates need event emission), not inside the store transaction — the durable supersession stamp is what correctness rides on, and that IS transactional.
4. **The claim loop replaces `tickQueue`.** The store is the queue; `Thread` holds no `pending` array. `kick()` asks the store to claim the thread's head; in-process it is triggered by admission/settlement/resume, and a session-level sweep timer (every 5s) retries claims + flushes due collect windows + reconciles expired leases, so nothing depends on in-process continuity.
5. **One heartbeat per session** (not per item): every 10s, `renewLeases(ownerId, activeItemIds)` for all items this instance is running.
6. **`awaitResult` scope:** `timeoutMs` + `signal` + merged-delegation land now; `resultSchema` validation is Phase 5 (workflow integration) — the option is typed but rejected with a clear "not implemented until Phase 5" error if passed.
7. **Reconciliation is a pure decision function + an effectful executor.** `decideReconciliation(item, ctx): ReconcileAction` is exported and unit-tested without mocks (CLAUDE.md: extract pure functions); the executor applies actions through the store/engine.
8. **New read methods** `listUnsettledSubmissions(sessionId)` and `getQueueItem(sessionId, itemId)` are added to `SessionStore` (reconciliation and `awaitResult` need them; the spec's method list predates this — sync the spec in Task 7).
9. **Owner principal:** `SessionData` gains `owner: Principal` (default `{type:'user', id:userId}`) and `parentThreadId?`; store columns `owner_type`/`owner_id`/`parent_thread_id`. `listSessions` switches its filter to the owner tuple. Full principal semantics (teams, unions) are Phase 4 — Phase 1 only lays the columns and default.

## File Structure

```
packages/engine/src/
  types.ts                    # +WriteFence, SubmissionClaim/Outcome/Result, QueueItem lifecycle fields,
                              #  BaseEntry.queueItemId, MessageEntry.stopReason, SessionStore contract
  submission.ts               # NEW: pure helpers — decideReconciliation, deriveQueueState, resolveSubmissionText
  thread.ts                   # inverted: claim loop, fenced writes, settlement, awaitResult
  session.ts                  # reconcile-on-rehydrate, sweep timer, heartbeat
  engine.ts                   # owner default, reconcile wiring
  test-helpers/
    in-memory-store.ts        # (wherever InMemorySessionStore lives today) implements new contract
    store-contract.ts         # updated: -queue-state test, +linkage columns round-trip
    submission-contract.ts    # NEW: submission lifecycle conformance suite
    restart-safe-gates-contract.ts  # updated for fenced suspended-turn methods
packages/engine/test/
  queue-modes.test.ts         # rewritten against durable submissions
  reconciliation.test.ts      # NEW: pure decideReconciliation table tests
  await-result.test.ts        # NEW
  kill-mid-turn.test.ts       # NEW: child-process SIGKILL integration test
  kill-child.ts               # NEW: the child entrypoint the test SIGKILLs
packages/store-sqlite/
  migrations/sqlite/0000_lonely_lizard.sql   # edited in place
  src/schema.ts               # edited in place
  src/store.ts                # submission methods (CAS), fences, transactions, engine_meta check
packages/api/src/routes/messages.ts          # keep compiling (receipt shape unchanged)
```

---

### Task 1: Submission contract — types, InMemory store, conformance suite

**Files:**
- Modify: `packages/engine/src/types.ts` (QueueItem, SessionStore, entries, new types)
- Modify: the `InMemorySessionStore` implementation (locate it: `grep -rn "class InMemorySessionStore" packages/engine/src/`)
- Create: `packages/engine/src/test-helpers/submission-contract.ts`
- Modify: `packages/engine/src/test-helpers/store-contract.ts` (remove queue-state round-trip test at ~line 272; add linkage-columns round-trip)
- Modify: `packages/engine/test/in-memory-store.test.ts` (also run the new suite)
- Modify: `packages/engine/src/thread.ts` + `packages/engine/src/session.ts` — MINIMAL mechanical adaptation only (see Step 4); the real inversion is Task 3

**Interfaces (Produces — later tasks consume these exact shapes):**

```typescript
// types.ts — new/changed types. Keep existing fields not mentioned here.

export interface WriteFence {
  itemId: string;
  attemptId: string;
}

export interface SubmissionClaim {
  sessionId: string;
  threadId: string;
  itemId: string;
  attemptId: string;
  ownerId: string;
  leaseDurationMs?: number; // default 30_000
}

export interface SubmissionOutcome {
  outcome: "completed" | "failed" | "aborted" | "superseded" | "merged";
  error?: string;
}

export type SubmissionStatus =
  | "collecting"
  | "queued"
  | "running"
  | "blocked_on_decision_gate"
  | "terminalizing"
  | "settled";

export interface QueueItem {
  id: string;
  threadId: string;
  /** Idempotent admission key. Unique per session when present. */
  dispatchId?: string;
  content: PromptContent;
  author?: PromptAuthor;
  channel?: ChannelTarget;
  replyTarget?: ChannelTarget;
  model?: string;
  role?: string;
  metadata?: Record<string, unknown>;
  // Durable execution lifecycle
  status: SubmissionStatus;
  outcome?: SubmissionOutcome;
  supersededByItemId?: string;
  mergedIntoItemId?: string;
  attemptId?: string;
  attemptCount: number;      // starts 0; claim/replace set+increment
  maxAttempts: number;       // default 10
  timeoutAt: number;         // default createdAt + 3_600_000
  abortRequestedAt?: number;
  ownerId?: string;
  leaseExpiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface SubmissionResult {
  queueItemId: string;
  outcome: SubmissionOutcome["outcome"];
  /** Content of the last persisted assistant entry carrying this queueItemId with stopReason 'end_turn'. */
  text?: string;
  output?: unknown;          // Phase 5 (resultSchema) — always undefined in Phase 1
  error?: string;
}

export interface AwaitResultOptions {
  timeoutMs?: number;
  resultSchema?: TSchema;    // typed now, rejected until Phase 5
  signal?: AbortSignal;
}

// BaseEntry gains (see spec ~line 514):
//   queueItemId?: string;   // the submission that produced this entry — the transcript↔submission linkage
// MessageEntry gains:
//   stopReason?: "end_turn" | "error" | "abort";   // persisted on the turn's final assistant entry

// ThreadData gains:
//   paused?: boolean;       // the only stored piece of queue state

// SessionData gains:
//   owner: Principal;       // default { type: 'user', id: userId }
//   parentThreadId?: string;
export interface Principal {
  type: "user" | "team" | "org";
  id: string;
}
```

```typescript
// SessionStore — changed/new methods. Unchanged methods keep their signatures.
export interface SessionStore {
  // CHANGED: optional fence; store MUST reject with StaleAttemptError when a
  // fence is provided and does not name the item's current attempt.
  appendEntries(sessionId: string, threadId: string, entries: SessionEntry[], fence?: WriteFence): Promise<void>;
  updateEntry(sessionId: string, threadId: string, entry: SessionEntry, fence?: WriteFence): Promise<void>;
  saveSuspendedTurn(sessionId: string, threadId: string, suspended: SuspendedTurnState, fence?: WriteFence): Promise<void>;
  clearSuspendedTurn(sessionId: string, threadId: string, fence?: WriteFence): Promise<void>;

  // REMOVED: saveQueueState, getQueueState  (QueueState is derived — decision 1)

  // NEW: submission lifecycle
  /**
   * Idempotent admission. Same dispatchId + deep-equal content → returns the
   * existing item with admitted=false. Same dispatchId + different content →
   * throws ConflictError. steer:true additionally stamps supersededByItemId
   * on every unsettled item of the thread admitted before this one, in the
   * same atomic step, and returns their ids.
   */
  admitSubmission(
    sessionId: string,
    threadId: string,
    item: QueueItem,
    opts?: { steer?: boolean },
  ): Promise<{ item: QueueItem; admitted: boolean; supersededItemIds: string[] }>;
  /**
   * CAS queued→running. Succeeds only when itemId is the thread's runnable
   * head: the oldest item with status 'queued' and no supersededByItemId.
   * Records attemptId, ownerId, lease; increments attemptCount. Returns the
   * updated item, or null when not head / not queued / already claimed.
   */
  claimSubmission(claim: SubmissionClaim): Promise<QueueItem | null>;
  /** CAS: install a new attempt on a running/blocked item whose lease expired. Null when the CAS loses. */
  replaceSubmissionAttempt(
    sessionId: string, threadId: string, itemId: string,
    claim: SubmissionClaim, opts: { expectedAttemptId: string },
  ): Promise<QueueItem | null>;
  insertAttemptMarker(itemId: string, attemptId: string): Promise<void>;
  deleteAttemptMarker(itemId: string, attemptId: string): Promise<void>;
  /** Renew leases for items this owner still owns; silently skips items whose attempt was replaced. */
  renewLeases(ownerId: string, itemIds: string[]): Promise<void>;
  listExpiredSubmissions(now: number): Promise<QueueItem[]>;
  listUnsettledSubmissions(sessionId: string): Promise<QueueItem[]>;
  getQueueItem(sessionId: string, itemId: string): Promise<QueueItem | null>;
  /** Stamp abortRequestedAt on unsettled submissions in scope. First write wins; NOT terminal. */
  requestAbort(sessionId: string, threadId?: string): Promise<void>;
  /** Fenced two-phase settlement for claimed turns: running|blocked→terminalizing, recording the outcome. */
  reserveSettlement(sessionId: string, threadId: string, itemId: string, outcome: SubmissionOutcome, fence: WriteFence): Promise<void>;
  /** terminalizing→settled. Idempotent (re-running after settled is a no-op). Fenced. */
  finalizeSettlement(sessionId: string, threadId: string, itemId: string, fence: WriteFence): Promise<void>;
  /**
   * CAS settle for never-claimed items (decision 2): succeeds only when
   * status is 'collecting' or 'queued'. Used for superseded/merged/
   * aborted-while-queued outcomes. mergedIntoItemId is stamped when
   * outcome is 'merged'.
   */
  settleUnclaimed(sessionId: string, threadId: string, itemId: string, outcome: SubmissionOutcome, opts?: { mergedIntoItemId?: string }): Promise<boolean>;
  /** Fenced: running↔blocked_on_decision_gate transitions for the claimed turn. */
  setSubmissionBlocked(sessionId: string, threadId: string, itemId: string, blocked: boolean, fence: WriteFence): Promise<void>;
}
```

New error classes in `@valet/shared` errors (or engine `errors.ts` if shared doesn't fit — match where `NotFoundError` used by the store lives today): `StaleAttemptError` (carries `itemId`, `staleAttemptId`, `currentAttemptId`) and `ConflictError` if not already present.

- [ ] **Step 1: Write the submission-contract conformance suite (failing).**

Create `packages/engine/src/test-helpers/submission-contract.ts`, following the exact factory pattern of `store-contract.ts` (`runSessionStoreContract(name, { factory, teardown? })`). Export `runSubmissionLifecycleContract(name, ctx)`. The suite below is normative — implement every `it`; the code here is complete except imports/helpers which follow store-contract.ts conventions. Use a `makeItem(overrides?)` helper producing a valid queued `QueueItem` (status "queued", attemptCount 0, maxAttempts 10, timeoutAt createdAt+3_600_000).

```typescript
export function runSubmissionLifecycleContract(name: string, ctx: StoreContractCtx): void {
  describe(`submission lifecycle contract: ${name}`, () => {
    // --- Admission ---
    it("admits and reads back a submission", async () => { /* admit → getQueueItem: deep-equal round trip, admitted=true */ });
    it("same dispatchId + same content returns the original item, admitted=false", async () => {});
    it("same dispatchId + different content throws ConflictError", async () => {});
    it("items without dispatchId always admit", async () => { /* two identical contents, both admitted */ });

    // --- Claim (CAS + FIFO head) ---
    it("claims the head: queued→running with attemptId/ownerId/lease, attemptCount=1", async () => {});
    it("second concurrent claim for the same item returns null", async () => { /* claim twice with different attemptIds; exactly one wins */ });
    it("cannot claim a non-head item (FIFO gating)", async () => { /* admit A then B; claim(B) returns null; claim(A) succeeds */ });
    it("a superseded queued item is skipped for head selection", async () => { /* admit A; admit S with steer:true; claim(S) succeeds even though A is older */ });
    it("collecting items do not block head-claim", async () => { /* admit C status 'collecting', admit B queued; claim(B) succeeds */ });

    // --- Steer supersession (atomic) ---
    it("steer admission stamps supersededByItemId on prior unsettled items and returns their ids", async () => {
      /* admit A (queued), claim A (running), admit B (queued), admit S {steer:true}:
         result.supersededItemIds = [A.id, B.id]; getQueueItem(A).supersededByItemId === S.id; same for B;
         S itself unstamped. */
    });
    it("steer does not stamp settled items or items admitted after it", async () => {});

    // --- Fencing (uses the fence-taking methods) ---
    it("appendEntries with the current attempt's fence succeeds; entry round-trips queueItemId", async () => {});
    it("appendEntries with a stale fence throws StaleAttemptError and writes nothing", async () => {
      /* claim with attempt-1, replaceSubmissionAttempt to attempt-2, then append with fence{attempt-1}:
         throws; getEntries shows no new entry. */
    });
    it("updateEntry / saveSuspendedTurn / clearSuspendedTurn reject stale fences the same way", async () => {});
    it("reserveSettlement with a stale fence throws StaleAttemptError; item stays running", async () => {});

    // --- Leases, markers, attempt replacement ---
    it("renewLeases extends leaseExpiresAt for owned items and skips replaced ones", async () => {});
    it("listExpiredSubmissions returns running items whose lease passed, not live ones", async () => {});
    it("replaceSubmissionAttempt CAS: succeeds with matching expectedAttemptId on expired lease; increments attemptCount", async () => {});
    it("replaceSubmissionAttempt loses when expectedAttemptId is stale (double-reclaim race)", async () => {});
    it("attempt markers insert/delete round-trip", async () => { /* verify via a store-level read or by observing delete is idempotent */ });

    // --- Two-phase settlement ---
    it("reserveSettlement records the outcome durably (status terminalizing), finalize settles it", async () => {});
    it("finalizeSettlement is idempotent: re-running after settled is a no-op", async () => {});
    it("a second reserveSettlement with a different outcome throws ConflictError (first terminal write wins)", async () => {});
    it("settled items are excluded from listUnsettledSubmissions", async () => {});

    // --- settleUnclaimed ---
    it("settles a queued item 'superseded' without a claim", async () => {});
    it("settles a collecting item 'merged' stamping mergedIntoItemId", async () => {});
    it("refuses to settle a running item (returns false)", async () => {});

    // --- Abort + blocked ---
    it("requestAbort stamps abortRequestedAt on unsettled items in scope only; first write wins", async () => {});
    it("setSubmissionBlocked toggles running↔blocked_on_decision_gate under the current fence", async () => {});
  });
}
```

Fill every body with real assertions (deep-equal on round-trips, exact status/outcome checks) — no `toBeDefined()`-only tests (CLAUDE.md). Wire the suite into `packages/engine/test/in-memory-store.test.ts` next to the existing contract call.

- [ ] **Step 2: Run the suite — verify it fails** (`pnpm --filter @valet/engine test -- in-memory-store`): compile errors on missing types/methods are the expected failure mode at this point.

- [ ] **Step 3: Implement types.ts changes + InMemorySessionStore.**

Apply the type/interface changes from the Interfaces block verbatim. Implement all new methods on `InMemorySessionStore` with plain data structures (a `Map<itemId, QueueItem>` per session; atomicity is free in-process — but preserve the CAS *semantics* exactly: e.g. `claimSubmission` re-checks head + status before mutating, `settleUnclaimed` returns false on running items). Deep-equal for dispatchId payload comparison: `JSON.stringify` of `content` is acceptable.

- [ ] **Step 4: Mechanically adapt thread.ts/session.ts so the package compiles — nothing more.**

`thread.ts` still uses the in-memory queue in this task. Required mechanical changes only: construct `QueueItem`s with the new required fields (`status: "queued"`, `attemptCount: 0`, `maxAttempts: 10`, `timeoutAt`, `updatedAt`); delete `persistQueueState`'s `saveQueueState` call (keep emitting the `queue_state` event from in-memory state); `SessionData.owner` defaulted in `engine.ts`/`session.ts` (`{ type: "user", id: userId }`). Do NOT wire admission/claims yet.

- [ ] **Step 5: Update store-contract.ts** — delete the `saveQueueState`+`getQueueState` round-trip test; add: entry `queueItemId` + `stopReason` round-trip through `appendEntries`/`getEntries`; session `owner`/`parentThreadId` round-trip.

- [ ] **Step 6: Run engine tests + typecheck.** `pnpm --filter @valet/engine test` — all suites green (in-memory store passes both contracts; queue-modes etc. still pass on the untouched in-memory queue). `pnpm typecheck` green (store-sqlite will NOT compile — acceptable ONLY if the workspace typecheck is per-package; if root typecheck fails on store-sqlite, stub the new methods there with `throw new Error("implemented in Task 2")` bodies so the workspace compiles, and note it).

- [ ] **Step 7: Commit** — `feat(engine): durable submission contract + in-memory implementation`.

---

### Task 2: store-sqlite rewrite to the submission contract

**Files:**
- Modify: `packages/store-sqlite/migrations/sqlite/0000_lonely_lizard.sql` (in place — pre-1.0 rule)
- Modify: `packages/store-sqlite/src/schema.ts`
- Modify: `packages/store-sqlite/src/store.ts`
- Modify: `packages/store-sqlite/src/migrate.ts` (engine_meta stamping + fail-loud check)
- Modify: `packages/store-sqlite/test/sqlite-store.test.ts` (run the new suite)

**Interfaces:**
- Consumes: Task 1's `SessionStore` interface, `runSubmissionLifecycleContract`, error classes.
- Produces: a `SqliteSessionStore` passing both contract suites; `ENGINE_SCHEMA_VERSION` export.

**Schema changes** (edit `schema.ts` + regenerate/hand-sync `0000_lonely_lizard.sql` so they agree):

- `engine_queue_items` — REPLACE the current unused columns with the full lifecycle: `id` PK, `session_id`, `thread_id`, `dispatch_id`, `status`, `outcome`, `error`, `superseded_by_item_id`, `merged_into_item_id`, `content` (JSON text), `author`, `channel`, `reply_target`, `model`, `role`, `metadata`, `attempt_id`, `attempt_count` (int, not null), `max_attempts` (int, not null), `timeout_at` (int, not null), `abort_requested_at` (int), `owner_id`, `lease_expires_at` (int), `created_at`, `updated_at`. Indexes: `(session_id, thread_id, status)`, and a UNIQUE partial index on `(session_id, dispatch_id) WHERE dispatch_id IS NOT NULL`.
- `engine_attempt_markers` — `item_id`, `attempt_id`, `created_at`; PK `(item_id, attempt_id)`.
- `engine_meta` — `key` PK, `value`; row `('schema_version', '<ENGINE_SCHEMA_VERSION>')` inserted by migration.
- `engine_entries` — add `queue_item_id` (indexed) and `stop_reason`.
- `engine_sessions` — add `owner_type` (not null), `owner_id` (not null, index `(owner_type, owner_id)`), `parent_thread_id`.
- `engine_threads` — add `paused` (int 0/1).
- DROP TABLE `engine_queue_state`.

**Store implementation notes (the CAS idioms are proven — copy from `packages/store-sqlite/experiments/FINDINGS-fencing.md` §"Canonical SQL idioms" and adapt column names):**

- Express every CAS as a single conditional `UPDATE`/`INSERT…SELECT…WHERE EXISTS` and branch on `changes`. Drizzle's query builder can express these, but raw prepared statements via the underlying better-sqlite3 handle (as the spike does) are acceptable where Drizzle fights you — keep them in named constants next to the method.
- `claimSubmission` head-selection in ONE statement: `UPDATE engine_queue_items SET status='running', attempt_id=?, owner_id=?, lease_expires_at=?, attempt_count=attempt_count+1, updated_at=? WHERE id=? AND status='queued' AND superseded_by_item_id IS NULL AND id = (SELECT id FROM engine_queue_items WHERE session_id=? AND thread_id=? AND status NOT IN ('settled','terminalizing','collecting') AND superseded_by_item_id IS NULL ORDER BY created_at, id LIMIT 1)`.
- Fence checks: `WHERE EXISTS (SELECT 1 FROM engine_queue_items WHERE id=? AND attempt_id=?)` folded into the write statement (fenced insert) or checked first inside the same `db.transaction()` for multi-row writes (fenced batch — throw inside the transaction to roll back; spike-proven).
- `admitSubmission` with `steer:true`: one `db.transaction()` — insert the steer item, then `UPDATE engine_queue_items SET superseded_by_item_id=? WHERE session_id=? AND thread_id=? AND status NOT IN ('settled','terminalizing') AND created_at <= ? AND id != ?` (use the steer item's `created_at`; return the affected ids via a prior SELECT inside the transaction).
- `admitSubmission` dispatchId dedup: try the insert; on unique-constraint violation, SELECT the existing row, compare serialized content — equal → `{ admitted: false }`, different → `ConflictError`.
- `reserveSettlement`: fenced CAS `status IN ('running','blocked_on_decision_gate') → 'terminalizing'` recording outcome/error. A terminalizing/settled item with a DIFFERENT recorded outcome → `ConflictError`; same outcome → no-op (idempotent re-reserve).
- `finalizeSettlement`: fenced CAS `terminalizing → settled`; no-op when already settled with the same attempt lineage.
- `appendEntries`/`deleteSession` and every other multi-statement method: wrap in `db.transaction()` (the current store has none — fix as you touch, per CLAUDE.md).
- Store open (`migrate.ts` or store constructor — wherever the db handle is created): set `journal_mode=WAL`, `busy_timeout=5000`, `synchronous=FULL`; then fail-loud schema check: read `engine_meta.schema_version`; if the table exists but the version is absent/unknown/newer than `ENGINE_SCHEMA_VERSION`, throw before any read/write (spec ~line 2137).

- [ ] **Step 1:** Wire `runSubmissionLifecycleContract` into `packages/store-sqlite/test/sqlite-store.test.ts` (same `:memory:` + migrate pattern as the existing contract call). Run: fails on missing schema/methods.
- [ ] **Step 2:** Apply schema.ts + 0000 SQL edits; `rm -f ~/.valet/app.db`.
- [ ] **Step 3:** Implement the store methods per the notes above.
- [ ] **Step 4:** Run `pnpm --filter @valet/store-sqlite test` — both contract suites + restart-safe-gates green. Run `pnpm --filter @valet/engine test` (unchanged, must stay green) and `pnpm typecheck` (remove any Task-1 stubs).
- [ ] **Step 5: Commit** — `feat(store-sqlite): durable submission lifecycle with CAS fencing`.

---

### Task 3: Engine inversion — durable admission, claim loop, fenced turn, settlement

The core task. `Thread.pending`/`collectBuffer`/`activeItem` in-memory arrays are replaced by the store; a turn is bracketed by claim → fenced writes → two-phase settlement. Scope here is the **followup** path + abort + pause/resume; steer/collect are Task 4; crash recovery is Task 5.

**Files:**
- Modify: `packages/engine/src/thread.ts` (submitPrompt, delete tickQueue/persistQueueState, new claim loop, handleAgentEvent fencing, settlement)
- Modify: `packages/engine/src/session.ts` (sweep timer, heartbeat, destroy drain)
- Create: `packages/engine/src/submission.ts` (pure `deriveQueueState`)
- Modify: `packages/engine/test/queue-modes.test.ts` (followup + pause/resume sections), `packages/engine/test/happy-path.test.ts` (assert linkage columns)

**Interfaces:**
- Consumes: Task 1 types + store methods (through `session.providers.store`).
- Produces: `Thread.submitPrompt` (unchanged signature, now durably admitting); internal `Thread.kick(): Promise<void>`; `Session.sweepOnce(): Promise<void>` (exported for tests); `deriveQueueState(items: QueueItem[], mode: QueueMode, paused: boolean, blockedGateId?: string): QueueState` in submission.ts. `PromptReceipt` unchanged.

**Design (implement exactly):**

1. **submitPrompt** builds the `QueueItem` (status `"queued"`, defaults per Global Constraints; `dispatchId` from `opts.dispatchId`) → `store.admitSubmission` → emit `queue_state` (derived) → `void this.kick()` → return receipt (`status` from the admitted item's live status). Compaction auto-continue (thread.ts ~872-880, currently pushes onto `pending`) becomes a durable admission with `metadata: { compaction_continue: true, synthetic: true }`.
2. **kick()** — the claim loop body (replaces `tickQueue`): if `this.data.paused` or `this.runningItem` → return. `claim = { attemptId: uid("att"), ownerId: session.ownerId, ... }` for the head item id (from `listUnsettledSubmissions` filtered to this thread, oldest queued non-superseded). `store.claimSubmission` → null means someone else/nothing to do → return. On success: `insertAttemptMarker`, set `this.runningItem = item`, `this.fence = { itemId, attemptId }`, run the turn (existing `runItem` body), then settle (below), clear marker, loop again (`while` — drain the queue).
3. **Fence plumbing:** every `store.appendEntries`/`updateEntry`/`saveSuspendedTurn`/`clearSuspendedTurn` call inside a turn passes `this.fence`. Every entry the turn writes carries `queueItemId: this.runningItem.id`; the turn-final assistant entry (in `handleAgentEvent` `message_end`) carries `stopReason` mapped from the agent's stop reason (`"stop"→"end_turn"`, `"error"→"error"`, `"aborted"→"abort"`; `"toolUse"` mid-turn entries carry none). A `StaleAttemptError` from any fenced write aborts the turn immediately (`agent.abort()`) and skips settlement — a successor owns the item now (this is the zombie self-fencing signal; log it, don't rethrow to the user).
4. **Settlement** (turn end, all outcomes): decide the `SubmissionOutcome` (`completed` on clean end_turn; `failed` with error text on stream error; `aborted` when `abortRequestedAt` set or abort() interrupted the turn) → `reserveSettlement` → rest-state repair: any trailing assistant `tool_call` part with `status: "running"` in the turn's entries is `updateEntry`'d to `status: "error", error: "interrupted"` — never re-executed → `finalizeSettlement` → `deleteAttemptMarker` → emit `submission_settled` `EngineEvent` `{ type: "submission_settled", sessionId, threadId, queueItemId, outcome }` (add to the EngineEvent union; the bridge may drop it — that's fine, `awaitResult` consumes it in-process) → emit derived `queue_state`.
5. **Heartbeat + sweep (session.ts):** on first claim, `Session` starts a 10s interval calling `store.renewLeases(ownerId, [running item ids across threads])`; a 5s sweep interval calls each thread's `kick()` (missed wakeups can't strand queued work). Both intervals `unref()`d and cleared in `destroy()`. `Session.sweepOnce()` exposes one sweep pass for deterministic tests.
6. **abort()** becomes: `store.requestAbort(sessionId, threadId)` → withdraw pending gates (existing logic) → if a turn is in flight, `agent.abort()` + `waitForIdle()` (the settlement path then records `aborted`) → for queued items: `settleUnclaimed(..., { outcome: "aborted" })` each → emit queue_state. **pause()/resume()** persist `ThreadData.paused` via `saveThread`; resume calls `kick()`.
7. **QueueState events:** `deriveQueueState` (pure, in submission.ts, unit-tested): status precedence `paused` > `blocked_on_decision_gate` (any unsettled blocked item) > `running` > `queued` (any queued) > `idle`; `pending` = queued items oldest-first; `collectBuffer` = collecting items; `activeItemId` = the running/blocked item.
8. **Gates:** where the turn suspends on a gate (existing `requestDecision` path), additionally `setSubmissionBlocked(..., true, fence)`; on replay resume, `setSubmissionBlocked(..., false, fence)`. `saveSuspendedTurn`/`clearSuspendedTurn` now pass the fence. Gate-blocked turns do NOT settle — the claim is retained (spec).

- [ ] **Step 1: Rewrite the followup + pause/resume tests first.** In `queue-modes.test.ts`: followup FIFO now asserts store truth — after two `submitPrompt`s, `store.getQueueItem` shows both settled `completed` in order, entries carry the right `queueItemId`s, and the final assistant entries carry `stopReason: "end_turn"`. Pause: submit while paused → item stays `queued` in the store; resume → settles. Add: "submitPrompt with the same dispatchId twice returns the same queueItemId". In `happy-path.test.ts` add assertions that the persisted user entry, assistant entry, and tool_call-bearing entry all carry the turn's `queueItemId` (this is the linkage `awaitResult` and reconciliation compute from — content assertions, not `toBeDefined`).
- [ ] **Step 2: Run them — red.**
- [ ] **Step 3: Implement the design (points 1–8).** Delete `persistQueueState`, `tickQueue`, the `pending`/`collectBuffer`/`activeItem` fields (keep collect-mode compiling by routing collect submissions to plain admission temporarily — Task 4 makes them real; the collect tests in queue-modes.test.ts may be `it.skip`ped in THIS task only, with a `// Task 4` marker).
- [ ] **Step 4: Green.** `pnpm --filter @valet/engine test` — everything except the explicitly-skipped collect/steer sections passes. `pnpm typecheck`.
- [ ] **Step 5: Commit** — `feat(engine): store-driven claim loop with fenced turns and settlement`.

---

### Task 4: Steer and collect on durable submissions

**Files:**
- Modify: `packages/engine/src/thread.ts` (steer path, collect windows)
- Modify: `packages/engine/src/session.ts` (collect deadlines in the sweep)
- Modify: `packages/engine/test/queue-modes.test.ts` (un-skip + rewrite steer/collect sections)

**Interfaces:**
- Consumes: `admitSubmission(..., { steer: true })`, `settleUnclaimed`, Task 3's kick/settlement machinery.
- Produces: no new public API; collect metadata convention `metadata.collect = { constituentIds: string[] }` on merged items.

**Design:**

- **Steer:** `submitPrompt` with effective mode `steer` → `admitSubmission({ steer: true })` (atomic supersession stamp) → for each superseded id: withdraw its pending gates (reason `"steer"`, existing gate logic) and `settleUnclaimed(..., { outcome: "superseded" })` (queued items; returns false for the running one) → if the running item was superseded: `agent.abort()` + `waitForIdle()`; its settlement path (Task 3 point 4) detects `supersededByItemId` and records outcome `superseded` instead of `aborted` → `kick()` claims the steer item (it is now the head by the store's head rule). The old gate-resolution-after-steer hazard is covered by the supersession stamp being durable BEFORE any abort runs.
- **Collect:** `submitPrompt` with effective mode `collect` → admit with `status: "collecting"` and `metadata.collectDeadline = now + 5000` (dispatchId dedup applies at admission — spec). Arm an in-process timer AND let the session sweep flush overdue windows (a deadline passed while down is flushed by the sweep after restore — reconciliation itself doesn't own this). **Flush** = read this thread's `collecting` items oldest-first → admit ONE merged item (content = the existing numbered-concatenation logic from `flushCollectBuffer`, `metadata.collect.constituentIds`) → `settleUnclaimed(constituent, { outcome: "merged", mergedIntoItemId })` each → `kick()`.

- [ ] **Step 1: Rewrite the steer/collect tests (red).** Steer: submit A (slow tool via faux provider), steer with S mid-run → assert store: A settled `superseded` with `supersededByItemId = S.id`, S settled `completed`, A's partial entries remain with A's `queueItemId`. Steer with a pending gate: gate withdrawn reason `steer`, gate resolution afterwards does NOT resume A (assert store state unchanged by a late `resolveDecision`). Collect: three submits inside the window → all three settle `merged` pointing at one merged item that settles `completed`; the merged item's entries carry the merged `queueItemId`. Collect + dispatchId: re-submit a constituent's dispatchId mid-window → same constituent id back, still exactly 3 constituents.
- [ ] **Step 2–3: Implement; green** (`pnpm --filter @valet/engine test`, typecheck).
- [ ] **Step 4: Commit** — `feat(engine): transactional steer supersession + durable collect windows`.

---

### Task 5: Reconciliation — the 7-step tree, resume path, stuck-head event

**Files:**
- Create: `packages/engine/src/submission.ts` additions — `decideReconciliation` (pure) + `ReconcileAction`/`ReconcileContext` types
- Create: `packages/engine/test/reconciliation.test.ts` (pure table tests)
- Modify: `packages/engine/src/session.ts` (`Session.rehydrate` runs reconciliation; expired-lease reclaim in the sweep)
- Modify: `packages/engine/src/thread.ts` (`resumeInterrupted` — the step-7 executor)
- Modify: `packages/engine/src/test-helpers/restart-safe-gates-contract.ts` (gate path now flows through reconciliation; fenced suspended-turn calls)

**Interfaces:**
- Consumes: everything prior; `entriesToAgentMessages` (thread.ts module export) and `agent.continue()` for the resume drive.
- Produces:

```typescript
// submission.ts
export type ReconcileAction =
  | { kind: "settle"; outcome: SubmissionOutcome }          // steps 1,2,3,5,6
  | { kind: "rearm_gate" }                                   // step 4 (gate pending)
  | { kind: "replay_gate" }                                  // step 4 (gate resolved while down)
  | { kind: "resume" }                                       // step 7
  | { kind: "wait" };                                        // live lease / fresh marker — not ours to touch

export interface ReconcileContext {
  now: number;
  /** True when a persisted assistant entry carries item.id with stopReason 'end_turn'. */
  hasTerminalAssistantEntry: boolean;
  /** True when engine_attempt_markers has a row for (item.id, item.attemptId) AND the lease is unexpired. */
  attemptLive: boolean;
  suspended: SuspendedTurnState | null;
  gateStatus: "pending" | "resolved" | "expired" | "withdrawn" | null;
}

export function decideReconciliation(item: QueueItem, ctx: ReconcileContext): ReconcileAction;
```

**Normative order (spec ~1168-1182 — implement EXACTLY this order):**
0. `status settled/terminalizing` → terminalizing gets finalization re-run (executor concern, not the pure function: the executor calls `finalizeSettlement` for terminalizing items before consulting the tree). `collecting` → `wait` (the sweep's collect flush owns it). `attemptLive` → `wait`.
1. `hasTerminalAssistantEntry` → settle `completed` — unconditionally, before retry/timeout checks.
2. `abortRequestedAt` set → settle `aborted`.
3. `supersededByItemId` set → settle `superseded`.
4. status `blocked_on_decision_gate` with `suspended` present: gate `pending` → `rearm_gate`; gate `resolved` → `replay_gate`; gate `expired`/`withdrawn`/missing → fall THROUGH to steps 5-7 (the turn resumes and the model sees the gate's terminal state). **Gate-blocked items are exempt from step 6's timeout.**
5. `attemptCount >= maxAttempts` → settle `failed` ("retry budget exhausted").
6. `now >= timeoutAt` (and not gate-blocked) → settle `failed` ("timed out").
7. otherwise → `resume`.

**Executor (in Session/Thread):**
- `Session.reconcile()` — for each item from `listUnsettledSubmissions(sessionId)`: gather `ReconcileContext` from the store (entries by queueItemId for the linkage check; markers+lease; suspended turn; gate), get the action, apply it:
  - `settle` for claimed items: `replaceSubmissionAttempt` (fresh attempt — the settle must be fenced under an attempt we own) → `reserveSettlement`/`finalizeSettlement` with rest-state repair. For never-claimed items: `settleUnclaimed`.
  - `rearm_gate` / `replay_gate`: the existing `armPendingGateForRestart` / `replayBlocked` paths — now invoked from here instead of `resumeBlockedThreadIfReady` (which this replaces; delete it).
  - `resume`: `Thread.resumeInterrupted(item)` — `replaceSubmissionAttempt` (CAS, expectedAttemptId = the dead attempt) → `insertAttemptMarker` → **rest-state repair FIRST** (trailing `tool_call` parts with `status: "running"` → `updateEntry` to `status: "error", error: "interrupted — result lost in restart"`; never re-executed, per FINDINGS-continuation.md: models may silently override fabricated values, so an honest error is the only safe injection) → rehydrate `agent.state.messages` via `entriesToAgentMessages` → `agent.continue()` + `waitForIdle()` (the trailing message is now a toolResult-convertible error result, satisfying the continuation contract) → normal settlement path.
- `Session.rehydrate` calls `await this.reconcile()` after threads/transcripts load (replacing the `resumeBlockedThreadIfReady` loop). The sweep additionally reconciles items from `listExpiredSubmissions(now)` belonging to this session (lease-expiry reclaim while live).
- **Stuck-head attention event:** when reconcile (or the sweep) observes an unsettled item with `attemptCount >= 3` OR `now - createdAt > 15min` (excluding gate-blocked), emit `EngineEvent` `{ type: "submission_stuck", sessionId, threadId, queueItemId, attemptCount, ageMs }` — once per observation pass, no dedup needed in Phase 1 (the attention router lands in Phase 4).

- [ ] **Step 1: Pure table tests (red).** `reconciliation.test.ts`: one `it` per tree step proving both the trigger and the ORDER (e.g. "terminal entry + abortRequestedAt + exhausted retries → completed, not aborted/failed"; "gate-blocked past timeoutAt with pending gate → rearm, not failed"; "expired gate falls through to resume"; "live attempt → wait even when timed out"). Direct calls to `decideReconciliation` with literal items/contexts — no mocks, no store.
- [ ] **Step 2: Implement `decideReconciliation`; pure tests green.**
- [ ] **Step 3: Executor integration test (red → green).** In `queue-modes.test.ts` or a new describe in `reconciliation.test.ts`: build a store with a hand-crafted crashed state (item `running`, stale lease, no marker liveness, transcript with a dangling `tool_call` part), `restoreSession`, assert: the dangling part became an error part, the item settled or resumed per the faux provider's scripted continuation, and NO tool re-execution happened (spy on the ToolDef's execute). Update `restart-safe-gates-contract.ts` for the reconciliation-driven gate path (same behavioral assertions as today, now flowing through `Session.reconcile`).
- [ ] **Step 4: Full suite green** (`pnpm --filter @valet/engine test`, `pnpm --filter @valet/store-sqlite test`, typecheck).
- [ ] **Step 5: Commit** — `feat(engine): startup reconciliation with resume repair + stuck-head event`.

---

### Task 6: awaitResult

**Files:**
- Modify: `packages/engine/src/thread.ts` (`awaitResult` method), `packages/engine/src/submission.ts` (`resolveSubmissionText` pure helper)
- Create: `packages/engine/test/await-result.test.ts`

**Interfaces:**
- Consumes: `submission_settled` EngineEvent (Task 3), `getQueueItem`, `getEntries`, `mergedIntoItemId`.
- Produces: `Thread.awaitResult(queueItemId: string, opts?: AwaitResultOptions): Promise<SubmissionResult>`; `resolveSubmissionText(entries: SessionEntry[], queueItemId: string): string | undefined` (pure: content of the LAST assistant `MessageEntry` with this `queueItemId` and `stopReason === "end_turn"`).

**Design:** read the item; if `outcome.outcome === "merged"` → recurse on `mergedIntoItemId` (bounded depth 5). If settled → build the result from the store (`text` via `resolveSubmissionText`; `error` from the outcome; superseded returns partial text under the item's own queueItemId per spec ~422). If unsettled → subscribe to the session bus for `submission_settled` matching the id, re-check the store once after subscribing (race: settled between read and subscribe), then await; `timeoutMs` (no default — callers choose) rejects with a `TimeoutError` that does NOT disturb the submission; `signal` aborts the wait the same way. `resultSchema` present → throw `new Error("resultSchema lands in Phase 5")` (decision 6). Resumability is inherent: everything derives from durable state, so a second `awaitResult` after a restart returns the same result — test it by calling on a NEW engine instance over the same store.

- [ ] **Step 1: Tests (red):** settled-before-call returns immediately with the right `text`; call-then-settle resolves via the event; merged constituent delegates to the merged item's result; superseded returns `outcome: "superseded"` + partial text; timeout rejects while the item later settles normally; **restart resumability**: settle under engine A, `awaitResult` under engine B (same sqlite `:memory:`? use a temp-file db) returns the identical result.
- [ ] **Step 2–3: Implement; green.**
- [ ] **Step 4: Commit** — `feat(engine): awaitResult with linkage-based result resolution`.

---

### Task 7: Kill-mid-turn proof, API blast radius, spec sync

**Files:**
- Create: `packages/engine/test/kill-child.ts` (child entrypoint), `packages/engine/test/kill-mid-turn.test.ts`
- Modify: `packages/api/src/routes/messages.ts` (only if compile requires; receipt shape is unchanged)
- Modify: `docs/specs/2026-05-02-portable-runtime-engine-design.md` (SessionStore method sync — decision 2, 8; same-commit rule from CLAUDE.md)
- Modify: `Makefile` (dogfood kill-restart note) — only a comment/echo pointing at the manual procedure; no new automation

**The kill-mid-turn test (the phase's exit criterion, automated):**

- `kill-child.ts`: a tsx-runnable script that (argv: dbPath, markerPath) builds an Engine over `SqliteSessionStore` on `dbPath` with a faux provider scripted to: assistant turn with TWO sequential tool calls of a `slow_marker` ToolDef whose execute appends a line `"executed:<callId>"` to `markerPath` then sleeps 5s (first call) — the child prints `READY:<queueItemId>` after `submitPrompt` and never exits on its own. **The faux provider must be registered inside the child** (it's in-process); script the continuation response too (after the repaired error tool result, the model answers and ends the turn).
- `kill-mid-turn.test.ts`: spawn the child (`node --import tsx` with Node 22), wait for `READY:` + the first `executed:` line in markerPath, `SIGKILL` the child **while the first tool sleeps** (mid-tool, entry persisted with a running tool_call part), then in-process: fresh Engine over the same dbPath (faux provider scripted for the continuation), `restoreSession` → reconciliation runs → `awaitResult(queueItemId)` resolves. Assert: markerPath contains EXACTLY ONE `executed:` line (no duplicate side effect — the interrupted call was repaired to an error, not re-run; the second call never started and must NOT start either since the model was scripted to conclude), the dangling tool_call part in the store reads `status: "error"`, the item settled `completed`, and `attemptCount === 2`.
- Timing hardening: poll markerPath instead of sleeping; generous timeouts (CI); temp dir via `fs.mkdtemp`.

- [ ] **Step 1:** Write child + test (red — reconciliation exists, but the harness will flush out real gaps; fix them in-place, they are in-scope for this task).
- [ ] **Step 2:** Green: `pnpm --filter @valet/engine test -- kill-mid-turn`.
- [ ] **Step 3:** Full workspace: `pnpm --filter @valet/engine test && pnpm --filter @valet/store-sqlite test && pnpm typecheck`. Fix `packages/api` compile fallout (expected: none — `submitPrompt`/`PromptReceipt` unchanged; `bridge.ts` may need the two new EngineEvent types added to its silently-dropped list at ~line 249).
- [ ] **Step 4: Spec sync.** Update the SessionStore interface block in the engine spec (~1640) to match the shipped contract: `settleUnclaimed`, `listUnsettledSubmissions`, `getQueueItem`, `admitSubmission` steer-option + return shape, `replaceSubmissionAttempt` expectedAttemptId, fence-optionality note, `setSubmissionBlocked`, removal of saveQueueState/getQueueState, `synchronous=FULL` choice. One tight diff — contracts only, no prose rewrites.
- [ ] **Step 5:** Manual dogfood (needs `ANTHROPIC_API_KEY` from `.env` + Docker): run `make dogfood-api`, submit a prompt that triggers a slow tool, `kill -9` the API process mid-turn, restart, confirm the turn completes and the transcript shows the interrupted-tool error + recovery. Record the result in the task report (this is the roadmap's exit criterion — a human-visible pass, not a CI gate).
- [ ] **Step 6: Fence-required cleanup.** Grep the engine for `appendEntries`/`updateEntry`/`saveSuspendedTurn`/`clearSuspendedTurn` calls still passing no fence from inside a claimed turn (compaction writes, gate entry writes) and thread the fence through. Calls legitimately outside any turn (rehydrate-time repairs by reconciliation before an attempt exists — there should be none; reconciliation always claims first) get a comment justifying fencelessness.
- [ ] **Step 7: Commit** — `feat(engine): kill-mid-turn recovery proof + spec sync`.

---

## Sequencing and execution notes

- Tasks are strictly ordered 1→7; each leaves the workspace green (Task 1's store-sqlite stub exception noted inline).
- Task 3 is the largest; if its implementer stalls, the natural split line is "admission+claim+fenced writes" vs "settlement+abort+pause" — but prefer one task, the halves share every fixture.
- The faux-provider pattern (`registerFauxProvider` with a unique name per test, `.setResponses([...])`) is mandatory for all new engine tests — no real API calls in CI paths.
- Phase exit = roadmap Phase 1 criteria: all suites green + the Step-5 manual dogfood pass.

## Self-review notes (per writing-plans)

- Spec coverage: submission lifecycle ✔ (T1-4), leases/markers ✔ (T1-3,5), reconciliation tree incl. gate-timeout exemption ✔ (T5), effect fencing ✔ (T1-3), terminalization/rest-state ✔ (T3,5), steer transactional ✔ (T4), collect durable+merge ✔ (T4), awaitResult+linkage ✔ (T6), stuck-head ✔ (T5), schema-version fail-loud ✔ (T2), owner columns ✔ (T1-2), kill-mid-turn ✔ (T7). Deferred with explicit markers: gate ordinals + expiry loop (Phase 2), resultSchema (Phase 5), attention routing (Phase 4).
- Types cross-checked: `WriteFence`/`SubmissionClaim`/`SubmissionOutcome` names match the spec; `ReconcileAction`/`deriveQueueState`/`resolveSubmissionText` are defined once (T5/T3/T6) and consumed by name elsewhere.

