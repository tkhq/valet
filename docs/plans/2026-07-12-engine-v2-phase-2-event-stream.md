# Engine v2 Phase 2 — Event Stream + Gates + Client Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The UI experience on the new event plane — an offset-addressed durable event log, WS client resume (replay-from-offset then live), decision gates with ordinals and a durable expiry loop wired end-to-end, web resume + submission-state surfaces, and the operator submissions API.

**Architecture:** A new `EventStream` provider replaces the fire-and-forget `EventBus`: the engine durably appends every discrete event with an idempotent `eventKey` before fan-out; `text_delta` stays live-only. `SqliteEventStream` shares the store's better-sqlite3 database. The API's WS layer becomes a resume protocol: durable frames carry offsets, reconnecting clients replay from their last offset. Gates gain deterministic ordinals and default expiries enforced by the existing 5s session sweep; boot-time eager restore closes the expiry-while-down and crash-reconcile-on-touch gaps.

**Tech Stack:** TypeScript, Node 22, better-sqlite3 + Drizzle, Hono + @hono/node-ws, Vite/React 19 + Zustand, vitest.

**Source spec:** `docs/specs/2026-05-02-portable-runtime-engine-design.md` — EventStream §1924–1980, gates §1215–1365, client contract §1434–1471, schema §1912, conformance §2497. Roadmap: `docs/plans/2026-07-11-engine-v2-local-e2e-roadmap.md` Phase 2.

## Global Constraints

- Pre-1.0 migration policy: edit `packages/store-sqlite/migrations/sqlite/0000_lonely_lizard.sql` in place; `rm ~/.valet/app.db`; no numbered migrations.
- No `any`, no `as unknown as T`, no `@ts-ignore` (CLAUDE.md type-safety rules).
- Every new store/stream behavior lands with its conformance-suite test in the same task (spec line 2499).
- Kill-mid-turn / kill-mid-gate recovery is a local test in this phase, not deferred.
- Legacy packages (`worker`, `client`, `runner`) untouched.
- pi-agent-core / pi-ai pinned at 0.73.0.
- All timestamps ms epoch; ids via the existing `uid(prefix)` helper.
- Run `pnpm --filter @valet/engine test`, `pnpm --filter @valet/store-sqlite test`, and `pnpm typecheck` before every commit claim.

## Locked Design Decisions

The spec leaves gaps; these are decided. Do not re-open them mid-task — flag concerns to the coordinator instead.

1. **`EventStream` replaces `EventBus` in `ProviderBundle`.** `ProviderBundle.bus: EventBus` becomes `stream: EventStream`. `EventStream.subscribe` is the live fan-out path (same `EventFilter`). `EventBus` and `InMemoryEventBus` are deleted in Task 3 (Task 1 adds `EventStream` alongside so nothing breaks early). The API constructs `SqliteEventStream` over the same sqlite handle as the store.
2. **Offset encoding:** per-session monotonic integer, exposed as a 16-digit zero-padded decimal string (`"0000000000000042"`) so lexicographic order == numeric order (spec: "opaque, lexicographically ordered, monotonic per session"). Assigned inside the append transaction (`MAX(seq)+1` per session).
3. **eventKey enforcement:** `UNIQUE(session_id, event_key)` on the events table. Duplicate append returns the original offset (appendOnce). Deterministic keys for re-runnable emitters: settlement = `settled:{queueItemId}` (all paths — dedupe makes multi-site emission safe); gate lifecycle = `gate:{gateId}:{status}`. One-shot live-execution events use fresh `uid("ev")` keys (the default when the emitter passes none).
4. **Delta delivery shape:** `append()` is never called for `text_delta`. `subscribe` callbacks receive `BusEvent & { offset?: string }` — durable events carry their assigned offset, deltas carry none. `read()` returns `StoredBusEvent` (offset required). Clients must never advance their resume offset on a delta.
5. **Resume handshake:** the client passes its last seen offset as a WS query param — `GET /api/sessions/:id/ws?fromOffset=<offset>`. Server always sends `init` first (metadata-only, unchanged — gates flow through replay or the REST bootstrap), then if `fromOffset` is present replays durable events with offset > `fromOffset` via `EventStream.read`, then switches to live with offset-dedupe at the boundary (live events arriving during replay are buffered and deduped by offset). No inbound hello frame; `ClientHello.lastSeq` is removed.
6. **Wire frames:** `WireEvent` gains `offset?: string` (present on durable-sourced frames, absent on deltas). Per-socket `seq` stays for ordering diagnostics; the client's resume state is `lastOffset`, not `lastSeq`.
7. **Gate ordinals:** `gateId = gate:{sessionId}:{threadId}:{queueItemId}:{resumeKey}:{ordinal}`. `DecisionGate` gains `ordinal: number`; `SuspendedTurnState` gains `ordinal: number`. Live semantics: if the latest gate for `(queueItemId, resumeKey)` is pending, `requestDecision` joins it (same ordinal); if terminal, it opens a fresh gate at `ordinal + 1`. Replay recomputes the same `(resumeKey, ordinal)` from the checkpoint and matches the persisted gate. New store method `getLatestGateForResume` supplies the lookup.
8. **Gate expiry:** defaults applied in `GateManager.fromRequest` when `req.expiresAt` is absent — `credential_request` = now + 24h, `approval`/`question` = now + 72h. Durable enforcement: the existing 5s session sweep additionally expires pending gates whose `expiresAt` has passed (in-memory `setTimeout` stays as the low-latency path; the sweep is the backstop against lost timers). Expiry-while-down is handled by boot-time eager restore (decision 9) driving reconciliation, which already terminalizes elapsed gates (`terminalizeReconciledGate`, Phase 1).
9. **Eager boot restore:** new store method `listSessionIdsWithUnsettledSubmissions(): Promise<string[]>`. On API boot, `main.ts` restores each such session through `EngineHost.sessionFor` so crashed turns reconcile and lapsed gates terminalize without waiting for a user touch. Failures are logged per-session, never fatal to boot.
10. **Retention:** `EventStream.prune(sessionId, queueItemIds: string[]): Promise<number>` deletes events whose `queueItemId` is in the list; events with an unsettled or absent `queueItemId` are never touched by this method (host decides what's prunable). `EngineHost` prunes on session restore: submissions settled more than `EVENT_RETENTION_MS` (default 7 days) ago. Envelope-only events (no queueItemId) are retained until session deletion (`deleteSession` cascades the event log).
11. **Admin surface:** admin-only (existing `role === "admin"` on the auth user). `GET /api/admin/submissions` lists unsettled submissions across all sessions with lease fields; `GET /api/admin/submissions?sessionId=s_x` scopes to one session (and then includes settled items). `POST /api/admin/submissions/:sessionId/:itemId/force-settle` body `{ outcome: "failed" | "aborted", error?: string }` — new store method `forceSettle` CASes any non-settled status straight to `settled`, records the outcome, deletes attempt markers, and the route emits `submission_settled` with the deterministic key. Force-settle of an already-settled item is a 409.
12. **`submission_settled` emissions (Phase 1 carry-forward):** all 5 `settleUnclaimed` call sites in `thread.ts` emit `submission_settled` with eventKey `settled:{itemId}`. `awaitResult`'s 50ms durable poll stays as the correctness mechanism; events remain wakeups.
13. **BEGIN IMMEDIATE (Phase 1 carry-forward):** the sqlite store's read-then-write transactions (`admitSubmission`, `reserveSettlement`, `finalizeSettlement`, `setSubmissionBlocked`) and the event append use better-sqlite3 `.transaction(...).immediate(...)` to avoid deferred-upgrade `SQLITE_BUSY` under concurrent writers.
14. **Schema version bumps to `"2"`.** `ENGINE_SCHEMA_VERSION = "2"` in `migrate.ts`; the 0000 migration stamps `'2'`. Old dev DBs fail loud → `rm ~/.valet/app.db`.
15. **Web resume:** the stream store tracks `lastOffset` per session (max offset seen on durable frames). Reconnects pass `?fromOffset`; when resuming with an offset the client does NOT `reset()` the slice and does NOT refetch REST history (no flash) — it dedupes replayed frames by offset. A fresh mount (no offset) keeps today's REST-bootstrap behavior.

---

### Task 1: EventStream contract, InMemoryEventStream, conformance suite

**Files:**
- Modify: `packages/engine/src/types.ts` (add `EventStream`, `StoredBusEvent`, `DeliveredBusEvent`, `BusEvent.queueItemId`)
- Create: `packages/engine/src/providers/in-memory/event-stream.ts`
- Create: `packages/engine/src/test-helpers/event-stream-contract.ts`
- Modify: `packages/engine/src/test-helpers/index.ts`, `packages/engine/src/index.ts` (exports)
- Test: `packages/engine/test/in-memory-event-stream.test.ts`

**Interfaces:**
- Consumes: existing `BusEvent`, `EventFilter`, `Unsubscribe`, `EngineEvent` from `types.ts`.
- Produces (later tasks build on these exact shapes):

```typescript
/** BusEvent gains the retention linkage field (spec §1943-1951). */
export interface BusEvent {
  sessionId: string;
  threadId?: string;
  /** The submission whose turn produced this event. Drives retention/truncation. */
  queueItemId?: string;
  userId?: string;
  event: EngineEvent;
  timestamp: number;
}

/** Durable, offset-addressed event. Offset is 16-digit zero-padded decimal, monotonic per session. */
export interface StoredBusEvent extends BusEvent {
  offset: string;
}

/** What live subscribers receive: durable events carry offset, live-only deltas don't. */
export type DeliveredBusEvent = BusEvent & { offset?: string };

export interface EventStream {
  /**
   * Durably append and fan out to live subscribers. `eventKey` is unique per
   * session: an append whose eventKey already exists is a no-op returning the
   * original offset (appendOnce).
   */
  append(event: BusEvent, eventKey: string): Promise<{ offset: string }>;
  /** Read durable events with offset > fromOffset (exclusive), in offset order. */
  read(
    sessionId: string,
    opts?: { fromOffset?: string; limit?: number },
  ): Promise<{ events: StoredBusEvent[]; nextOffset: string }>;
  /** Live fan-out. Durable events are delivered AFTER their append commits, in offset order per session. */
  subscribe(filter: EventFilter, callback: (event: DeliveredBusEvent) => void): Unsubscribe;
  /** Live-only fan-out for text_delta: no append, no offset. */
  publishEphemeral(event: BusEvent): void;
  /** Delete durable events whose queueItemId is in the list. Returns deleted count. */
  prune(sessionId: string, queueItemIds: string[]): Promise<number>;
  /** Drop the session's entire log (called from deleteSession paths / tests). */
  deleteSession(sessionId: string): Promise<void>;
}
```

`read` is **exclusive** of `fromOffset` (the client already has that event); `fromOffset` absent ⇒ from the beginning. `nextOffset` is the offset of the last event returned (or `fromOffset` / `""` when empty) — callers pass it back to continue.

- [ ] **Step 1: Write the conformance suite** at `packages/engine/src/test-helpers/event-stream-contract.ts`, exported as `runEventStreamContract(name: string, ctx: { factory: () => Promise<EventStream> | EventStream })`, covering (each as its own `it`):
  1. append returns monotonic, lexicographically increasing offsets per session; two sessions have independent sequences.
  2. appendOnce: same `(sessionId, eventKey)` twice → second append returns the FIRST offset; `read` shows one event.
  3. Different sessions may reuse the same eventKey (uniqueness is per session).
  4. `read` with no `fromOffset` returns all in order; with `fromOffset` = Nth offset returns strictly after N; `limit` respected with correct `nextOffset` for continuation (read page 1, pass nextOffset, read page 2, no gaps/dupes).
  5. `subscribe({ sessionId })` receives appended events with their offsets, in append order; unsubscribe stops delivery.
  6. `subscribe` with `eventTypes: ["queue_state"]` filters; with a different sessionId receives nothing.
  7. `publishEphemeral` reaches subscribers with `offset === undefined` and is absent from `read`.
  8. `prune(sessionId, [itemA])` deletes only events whose `queueItemId === itemA`; events with other/absent queueItemIds survive; returns the deleted count; offsets of survivors unchanged (no renumbering).
  9. `deleteSession` empties `read` for that session and only that session.
  10. Gap-refetch invariant: after appends 1..5, `read(sessionId, { fromOffset: offsets[1] })` returns exactly 3..5 (this is what a subscriber does on observing a non-contiguous offset).

  Use a tiny helper in the suite to build events: `const ev = (sessionId: string, type = "turn_end"): BusEvent => ({ sessionId, threadId: "th-1", event: { type: "turn_end", threadId: "th-1", reason: "end_turn" } as EngineEvent, timestamp: 1 })` — vary `queueItemId` per test via spread.
- [ ] **Step 2: Wire it** in `packages/engine/test/in-memory-event-stream.test.ts` with `runEventStreamContract("InMemoryEventStream", { factory: () => new InMemoryEventStream() })`. Run: fails (class missing).
- [ ] **Step 3: Add the types** to `types.ts` exactly as above (add `queueItemId` to `BusEvent`; keep `EventBus` untouched for now — Task 3 deletes it).
- [ ] **Step 4: Implement `InMemoryEventStream`** in `providers/in-memory/event-stream.ts`: `Map<sessionId, StoredBusEvent[]>` + `Map<sessionId, Map<eventKey, offset>>` + subscriber list with filter matching (reuse the matching semantics from `InMemoryEventBus` — copy, don't import). Offset: `String(n).padStart(16, "0")`. Export from `providers/in-memory/index.ts` and package `index.ts`; export `runEventStreamContract` from `test-helpers/index.ts`.
- [ ] **Step 5: Green + typecheck.** `pnpm --filter @valet/engine test -- in-memory-event-stream` then the full engine suite (must stay green — nothing else changed) and `pnpm typecheck`.
- [ ] **Step 6: Commit** — `feat(engine): EventStream contract with in-memory reference implementation`.

---

### Task 2: SqliteEventStream + schema + BEGIN IMMEDIATE hardening

**Files:**
- Modify: `packages/store-sqlite/migrations/sqlite/0000_lonely_lizard.sql` (in place: `engine_events` table; stamp version `'2'`)
- Modify: `packages/store-sqlite/src/schema.ts` (add `engineEvents` table)
- Create: `packages/store-sqlite/src/event-stream.ts`
- Modify: `packages/store-sqlite/src/migrate.ts` (`ENGINE_SCHEMA_VERSION = "2"`)
- Modify: `packages/store-sqlite/src/store.ts` (IMMEDIATE transactions; cascade event deletion in `deleteSession`)
- Modify: `packages/store-sqlite/src/index.ts` (export `SqliteEventStream`)
- Test: `packages/store-sqlite/test/sqlite-event-stream.test.ts`

**Interfaces:**
- Consumes: Task 1's `EventStream`, `runEventStreamContract`.
- Produces: `class SqliteEventStream implements EventStream` with `constructor(sqlite: DatabaseType)` (the raw better-sqlite3 handle, same one the store wraps — live fan-out is in-process, so API code must share ONE instance between WS subscribers and the engine).

**Schema (add to `schema.ts` and the 0000 SQL):**

```sql
CREATE TABLE `engine_events` (
  `session_id` text NOT NULL,
  `seq` integer NOT NULL,
  `event_key` text NOT NULL,
  `thread_id` text,
  `queue_item_id` text,
  `user_id` text,
  `event_type` text NOT NULL,
  `payload` text NOT NULL,          -- JSON: the full EngineEvent
  `timestamp` integer NOT NULL,
  PRIMARY KEY (`session_id`, `seq`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `engine_events_event_key` ON `engine_events` (`session_id`,`event_key`);
--> statement-breakpoint
CREATE INDEX `engine_events_queue_item` ON `engine_events` (`session_id`,`queue_item_id`);
```

Offset ⇄ seq: store `seq` as integer, expose `String(seq).padStart(16, "0")`; parse inbound `fromOffset` with `Number(fromOffset)` (validate `Number.isSafeInteger`, else throw `ValidationError`).

**Implementation notes:**
- `append`: one IMMEDIATE transaction — `SELECT seq FROM engine_events WHERE session_id=? AND event_key=?` → hit: return stored offset; miss: `INSERT ... VALUES (?, (SELECT COALESCE(MAX(seq),0)+1 FROM engine_events WHERE session_id=?), ...)` then read back the assigned seq (`SELECT seq ... WHERE session_id=? AND event_key=?`). Fan out to subscribers AFTER the transaction commits.
- `subscribe`/`publishEphemeral`: in-process subscriber list, same filter semantics as InMemory (copy the matcher into a small shared helper if you like, but do not import across packages).
- `read`: `WHERE session_id=? AND seq > ? ORDER BY seq LIMIT ?` (default limit 500).
- `prune`: `DELETE FROM engine_events WHERE session_id=? AND queue_item_id IN (...)` chunked at 500 ids; return total `changes`.
- IMMEDIATE hardening in `store.ts`: convert `admitSubmission` (line ~673), `reserveSettlement` (~833), `finalizeSettlement` (~862), `setSubmissionBlocked` (~898) from `this.sqlite.transaction(fn)()` to `this.sqlite.transaction(fn).immediate()`. Leave read-only and single-statement paths as they are.
- `deleteSession` in `store.ts` additionally deletes from `engine_events` (keeps store + stream lifecycles aligned even though the stream has its own `deleteSession`).

- [ ] **Step 1: Wire the contract** in `packages/store-sqlite/test/sqlite-event-stream.test.ts`:

```typescript
import Database from "better-sqlite3";
import { runEventStreamContract } from "@valet/engine/test-helpers";
import { applyEngineMigrations } from "../src/migrate.js";
import { SqliteEventStream } from "../src/event-stream.js";

runEventStreamContract("SqliteEventStream", {
  factory: () => {
    const sqlite = new Database(":memory:");
    applyEngineMigrations(sqlite);
    return new SqliteEventStream(sqlite);
  },
});
```

Add one sqlite-specific test in the same file: two `SqliteEventStream` instances over two connections to the same **file** db — concurrent `append` bursts (50 each, interleaved via `Promise.all`) produce a dense 1..100 sequence with no duplicate seq (proves the IMMEDIATE append transaction). Run: red.
- [ ] **Step 2: Schema + version bump.** Edit `schema.ts` + 0000 SQL (table + both indexes + stamp `'2'`); set `ENGINE_SCHEMA_VERSION = "2"`. `rm -f ~/.valet/app.db`.
- [ ] **Step 3: Implement `SqliteEventStream`** per the notes.
- [ ] **Step 4: IMMEDIATE hardening + deleteSession cascade** in `store.ts`.
- [ ] **Step 5: Green.** `pnpm --filter @valet/store-sqlite test` (all suites incl. existing contracts), `pnpm --filter @valet/engine test` (unchanged), `pnpm typecheck`.
- [ ] **Step 6: Commit** — `feat(store-sqlite): offset-addressed SqliteEventStream + IMMEDIATE settlement transactions`.

---

### Task 3: Engine emission inversion — durable appends with idempotent eventKeys

**Files:**
- Modify: `packages/engine/src/types.ts` (delete `EventBus`; `ProviderBundle.bus` → `stream: EventStream`; add `emit` option types)
- Modify: `packages/engine/src/session.ts` (`emit` appends durably; sweep unchanged here)
- Modify: `packages/engine/src/thread.ts` (eventKeys + queueItemId on emissions; `submission_settled` from all 5 `settleUnclaimed` sites; `.catch` on `terminalizeReconciledGate`)
- Delete: `packages/engine/src/providers/in-memory/event-bus.ts` (`InMemoryEventBus`)
- Modify: `packages/engine/src/index.ts`, `providers/in-memory/index.ts` (export swap)
- Modify: every engine test constructing providers (`bus: new InMemoryEventBus()` → `stream: new InMemoryEventStream()`), incl. `test/kill-child.ts` and the restart-safe-gates contract
- Test: extend `packages/engine/test/happy-path.test.ts` + `packages/engine/test/reconciliation.test.ts`

**Interfaces:**
- Consumes: Task 1 `EventStream`/`DeliveredBusEvent`.
- Produces: the new emit signature every later task relies on:

```typescript
// session.ts
export interface EmitOptions {
  /** Idempotency key; defaults to uid("ev"). Deterministic on re-runnable paths. */
  eventKey?: string;
  /** Submission linkage for retention. Threads pass their runningItem/settling item id. */
  queueItemId?: string;
}

async emit(event: EngineEvent, opts?: EmitOptions): Promise<void>
```

**Design (implement exactly):**

1. `Session.emit` builds the `BusEvent` (now with `queueItemId: opts?.queueItemId`). If `event.type === "text_delta"` → `stream.publishEphemeral(busEvent)` and return. Otherwise `await stream.append(busEvent, opts?.eventKey ?? uid("ev"))`. Append failures on non-critical paths must not kill a turn: wrap in try/catch, log via the session's error channel, continue (events are the wakeup/UX plane; the store is truth).
2. **Deterministic eventKeys** (decision 3):
   - Every settlement emission (both fenced two-phase paths, `retryFinalize`, `settleReconciled`, and all 5 `settleUnclaimed` sites at thread.ts ~290, ~413, ~523, ~904, ~1122): `submission_settled` with `eventKey: \`settled:${item.id}\`` and `queueItemId: item.id`. The 4 currently-silent sites now emit; the unique key makes any double-emission across restart/reconcile paths a no-op.
   - Gate lifecycle: `decision_gate` → `gate:{gateId}:pending`; `decision_gate_resolved` → `gate:{gateId}:resolved`; `decision_gate_expired` → `gate:{gateId}:expired`; `decision_gate_withdrawn` → `gate:{gateId}:withdrawn`. (Replay/re-arm paths re-emit these; the keys dedupe them.)
   - `queue_state`, `status`, message/tool/turn events: default fresh keys, but thread emissions inside a turn pass `queueItemId: this.runningItem.id` (and the settling item's id on settlement-adjacent emissions) so retention can truncate per submission.
3. `void this.terminalizeReconciledGate(...)` call sites get `.catch((err) => this.session.emitError(...))` (or the local error-emit idiom already used in `thread.ts` — match it; the Phase 1 review flagged the bare `void` as an unhandled-rejection hole).
4. Delete `EventBus` + `InMemoryEventBus`; `ProviderBundle.stream: EventStream`. Fix all constructions (engine tests, `kill-child.ts`, restart-safe-gates contract factory, `Engine` internals referencing `providers.bus`).

- [ ] **Step 1: Write the failing tests.**
  - `happy-path.test.ts`: after a completed turn, `stream.read(sessionId)` contains (in offset order) `message_start` → `message_update`(s) → `message_end` → `turn_end` → `submission_settled`; NO `text_delta` events in the log; every turn event's `queueItemId` equals the receipt's `queueItemId`; the `submission_settled` event's envelope has `queueItemId` set and its offset is a 16-char zero-padded string.
  - `reconciliation.test.ts` (steer/abort/collect sections): after `steer` supersedes a queued item, the log contains `submission_settled` with `outcome.outcome === "superseded"` for the superseded id, keyed `settled:{id}` (assert via appendOnce: run reconciliation twice → still exactly one settled event per item). Same for an aborted queued item and a merged collect item.
- [ ] **Step 2: Red.**
- [ ] **Step 3: Implement points 1–4.** Mechanical sweep: `grep -rn "InMemoryEventBus\|providers.bus\|bus:" packages/engine/src packages/engine/test` must come back empty of `EventBus` references when done.
- [ ] **Step 4: Green.** Full engine suite (incl. kill-mid-turn — the child now wires a stream) + `pnpm --filter @valet/store-sqlite test` + `pnpm typecheck` (api/web will break on `ProviderBundle.bus` — fix the API's provider construction minimally here: build a `SqliteEventStream` in `packages/api/src/providers/node.ts` (or wherever the bundle is assembled) and pass it as `stream`; the WS layer keeps consuming `subscribe`. Full WS resume is Task 5 — this step only keeps the workspace compiling and behavior equivalent.)
- [ ] **Step 5: Commit** — `feat(engine): durable event appends with idempotent eventKeys`.

---

### Task 4: Gate ordinals, expiry defaults, durable expiry sweep

**Files:**
- Modify: `packages/engine/src/types.ts` (`DecisionGate.ordinal: number`; `SuspendedTurnState.ordinal: number`; `SessionStore.getLatestGateForResume`)
- Modify: `packages/engine/src/decision-gate.ts` (ordinal in `deterministicGateId`; expiry defaults in `fromRequest`; fix the stale "Not implemented yet" header comment — restart-safe replay HAS been implemented since Phase 1)
- Modify: `packages/engine/src/thread.ts` (`requestDecision` join-or-increment; checkpoint records ordinal; replay matches by ordinal)
- Modify: `packages/engine/src/session.ts` (sweep expires lapsed pending gates)
- Modify: `packages/engine/src/providers/in-memory/store.ts` + `packages/store-sqlite/src/store.ts` (`getLatestGateForResume`)
- Modify: `packages/engine/src/test-helpers/store-contract.ts` (gate method coverage) and `packages/engine/src/test-helpers/restart-safe-gates-contract.ts` (ordinal + expiry cases)
- Test: `packages/engine/test/decision-gates.test.ts` (or the existing gate test file — extend in place)

**Interfaces:**
- Consumes: Phase 1 gate plumbing (`GateManager`, `saveDecisionGate`, `saveSuspendedTurn`, `setSubmissionBlocked`, `reconcileGate`/`replayBlocked`/`terminalizeReconciledGate`).
- Produces:

```typescript
// types.ts — SessionStore addition
/** Latest gate (any status) for a (queueItemId, resumeKey) pair, or null. */
getLatestGateForResume(
  sessionId: string,
  threadId: string,
  queueItemId: string,
  resumeKey: string,
): Promise<DecisionGate | null>;

// decision-gate.ts
export const GATE_EXPIRY_DEFAULT_MS = {
  approval: 72 * 60 * 60 * 1000,
  question: 72 * 60 * 60 * 1000,
  credential_request: 24 * 60 * 60 * 1000,
} as const;

export function deterministicGateId(ctx: {
  sessionId: string; threadId: string; queueItemId: string; resumeKey: string; ordinal: number;
}): string; // `gate:${sessionId}:${threadId}:${queueItemId}:${resumeKey}:${ordinal}`
```

**Design (implement exactly):**

1. **Ordinal resolution in `requestDecision`:** call `getLatestGateForResume`. `null` → ordinal 0, fresh gate. Latest is `pending` → JOIN it: same gateId/ordinal, do not create a second row; re-register the wait (this is the replay short-circuit generalized — `shouldShortCircuit` merges into this path). Latest is terminal (`resolved`/`expired`/`withdrawn`) → ordinal = latest.ordinal + 1, fresh gate (a retried action after denial gets a new human decision).
2. **Checkpoint:** `saveSuspendedTurn` payload includes `ordinal`; replay (`replayBlocked` / `armPendingGateForRestart`) computes the gateId from the checkpoint's `(resumeKey, ordinal)` — never by re-deriving "latest".
3. **Expiry defaults:** `fromRequest` sets `expiresAt: req.expiresAt ?? Date.now() + GATE_EXPIRY_DEFAULT_MS[req.type]`. Every gate now has an `expiresAt`.
4. **Durable expiry sweep:** the session's existing 5s sweep (Phase 1, `session.ts`) adds: for each thread's pending gates (`store.listDecisionGates`-equivalent already backing `pendingDecisionGates()`), if `expiresAt <= Date.now()` → if the gate is armed in `GateManager`, call its `expire(gateId)` (fires the live `onExpire` path); if not armed (lost timer, e.g. re-armed row without a live waiter), run the terminalization path (`terminalizeReconciledGate` with the expired status). The in-memory `setTimeout` in `GateManager.register` stays.
5. **Store impls:** `getLatestGateForResume` = filter gates by exact `(sessionId, threadId)` and gateId prefix `gate:{sessionId}:{threadId}:{queueItemId}:{resumeKey}:`, order by `ordinal` desc, first row. Sqlite: `WHERE id LIKE ? ESCAPE '\'` on the prefix (escape LIKE metacharacters in the prefix) or add an `ordinal` column + `resume_key` column to `engine_decision_gates` — **do the columns** (`resume_key` text, `ordinal` integer, both NOT NULL; edit 0000 in place per policy; version stays "2" — same pre-release schema) and query `WHERE session_id=? AND thread_id=? AND queue_item_id=? AND resume_key=? ORDER BY ordinal DESC LIMIT 1` (also add `queue_item_id` column if the gates table lacks it). Mirror fields on the in-memory store.

- [ ] **Step 1: Write the failing tests.**
  - Contract (`store-contract.ts`): save gates at ordinals 0 and 1 for one `(item, resumeKey)` → `getLatestGateForResume` returns ordinal 1; different resumeKey → null.
  - Engine (`decision-gates.test.ts`): (a) deny a gate, tool retries `requestDecision` with the same resumeKey → NEW gateId with `:1` suffix, old gate stays `resolved`; (b) `fromRequest` with no `expiresAt` → approval gate expires ~72h out, credential ~24h (assert within a 5s tolerance of `Date.now() + default`); (c) sweep expiry: register a gate with `expiresAt = Date.now() - 1`, run one sweep pass (`session.sweepOnce()`), gate row becomes `expired`, `decision_gate_expired` appears in the event stream keyed `gate:{id}:expired`, and the blocked submission terminalizes (settles `failed` with a gate-expired error).
  - Restart contract (`restart-safe-gates-contract.ts`): extend the existing cycle to assert the persisted gate id ends in `:0` and the replayed continuation matched the SAME gateId (no `:1` twin created on replay).
- [ ] **Step 2: Red.**
- [ ] **Step 3: Implement points 1–5** (schema edits: `resume_key`, `ordinal`, `queue_item_id` on `engine_decision_gates` in schema.ts + 0000 SQL; `rm -f ~/.valet/app.db`). Fix the stale header comment in `decision-gate.ts:19-22` while in the file.
- [ ] **Step 4: Green.** Engine + store-sqlite suites, `pnpm typecheck`.
- [ ] **Step 5: Commit** — `feat(engine): gate ordinals, default expiries, durable expiry sweep`.

---

### Task 5: API — WS resume protocol, wire mappings, eager boot restore, retention hook

**Files:**
- Modify: `packages/api/src/routes/ws.ts` (offset frames, `?fromOffset` replay-then-live)
- Modify: `packages/api/src/engine/bridge.ts` (map `queue_state` + `submission_settled` to wire; keep dropping `submission_stuck` — Phase 4)
- Modify: `packages/api/src/wire/types.ts` (`WireEvent.offset?: string`; new `queue.state` + `submission.settled` wire events; delete `ClientHello.lastSeq`)
- Modify: `packages/api/src/engine/host.ts` (shared `SqliteEventStream` accessor; prune-on-restore)
- Modify: `packages/api/src/main.ts` (eager boot restore pass)
- Modify: `packages/engine/src/types.ts` + both stores + `submission-contract.ts` (`listSessionIdsWithUnsettledSubmissions`)
- Test: `packages/api/test/ws-resume.test.ts` (new), store contract additions

**Interfaces:**
- Consumes: `SqliteEventStream` (Task 2), durable appends (Task 3).
- Produces:

```typescript
// wire/types.ts additions — follow the existing WireEvent naming style
| { type: "queue.state"; sessionId: string; threadId: string; state: WireQueueState }
| { type: "submission.settled"; sessionId: string; threadId: string; queueItemId: string;
    outcome: "completed" | "failed" | "aborted" | "superseded" | "merged"; error?: string }
// every WireEvent variant gains: offset?: string  (absent on chunk/delta frames)

// engine types.ts — SessionStore addition (contract-tested in both stores)
listSessionIdsWithUnsettledSubmissions(): Promise<string[]>;
```

`WireQueueState` = `{ mode, status, activeItemId?, pendingIds: string[], collectingIds: string[], blockedGateId? }` — id lists, not full items (the wire layer stays thin; the admin surface returns full items).

**Design (implement exactly):**

1. **One `SqliteEventStream` instance** per process, constructed next to the store in the provider assembly and exposed via `engineHost.eventStream()`. Engine sessions and WS handlers share it (in-process fan-out requires the same object).
2. **WS resume (`ws.ts`):** parse `fromOffset` from the upgrade URL query. `onOpen`: auth + materialize session as today → send `init` (unchanged metadata-only shape, still includes pending gates via the existing REST-bootstrap… init currently has no gates — leave init alone; gates flow through replay or REST as today) → if `fromOffset` present: subscribe live FIRST into a buffer, then `EventStream.read(sessionId, { fromOffset })` in pages of 500, mapping each `StoredBusEvent` through `busEventToWire` and stamping `offset`; after replay, flush the buffer dropping events with `offset <= lastReplayed`; then deliver live directly. If absent: subscribe live only (today's behavior). Every outbound durable-sourced frame stamps `offset`; `chunk` frames never carry one.
3. **Bridge:** add mappings — `queue_state` → `queue.state` (map `QueueState` → `WireQueueState`), `submission_settled` → `submission.settled`. `busEventToWire` gains the envelope so mappings can read `queueItemId`: change its signature to accept `BusEvent & { offset?: string }` (it already takes `BusEvent`) and have the WS layer stamp `offset` onto the drafts it returns.
4. **Eager boot restore (`main.ts`):** after providers/host are ready and before `listen`, `const ids = await engineStore.listSessionIdsWithUnsettledSubmissions()`; for each, look up the app-side session row (need workspace/model meta for `sessionFor`) and `await engineHost.sessionFor(id, meta)` inside try/catch with a per-session `console.error`. Sessions whose app row is missing are skipped with a warning. Boot logs a one-line summary (`restored N sessions with unsettled submissions`).
5. **Retention hook (`host.ts`):** after a successful restore in `sessionFor`, fire-and-forget prune: list this session's settled items older than `EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000` (store query via existing per-session listing + `getQueueItem`; add a small helper if the store lacks a settled-before query — a plain `listSettledSubmissionsBefore(sessionId, cutoff)` store method is acceptable if needed, contract-tested) and call `stream.prune(sessionId, ids)`. Errors logged, never thrown.
6. **Store method:** `listSessionIdsWithUnsettledSubmissions` — sqlite: `SELECT DISTINCT session_id FROM engine_queue_items WHERE status != 'settled'`; in-memory equivalent. Contract test in `submission-contract.ts`: admit in two sessions, settle one fully → only the other id returned.

- [ ] **Step 1: Write the failing tests.**
  - Contract: the `listSessionIdsWithUnsettledSubmissions` case above (runs against both stores).
  - `packages/api/test/ws-resume.test.ts` (follow the existing API test bootstrap pattern — in-process server, faux engine provider): (a) connect with no offset → init only, then live events stream with offsets present on durable frames and absent on `chunk`; (b) append 5 durable events while disconnected, reconnect with `fromOffset` = offset of event 2 → frames 3–5 replay in order before any live frame, each with its offset; (c) duplicate suppression: an event appended during replay is delivered exactly once (assert by offset uniqueness across the received frame list); (d) `queue.state` and `submission.settled` frames reach the socket after a submit→settle cycle.
- [ ] **Step 2: Red.**
- [ ] **Step 3: Implement points 1–6.**
- [ ] **Step 4: Green.** API + engine + store-sqlite suites, `pnpm typecheck`. Then a manual smoke: `make dev-api-node`, open a session, `curl` a prompt, verify WS frames carry `offset` (documented in the task report, not automated).
- [ ] **Step 5: Commit** — `feat(api): offset-carrying WS frames with replay-from-offset resume + eager boot restore`.

---

### Task 6: Operator surface — admin submissions endpoints + forceSettle

**Files:**
- Create: `packages/api/src/routes/admin.ts`
- Modify: `packages/api/src/app.ts` (mount `/api/admin`)
- Modify: `packages/engine/src/types.ts` + both stores (`forceSettle`, `listAllUnsettledSubmissions`)
- Modify: `packages/engine/src/test-helpers/submission-contract.ts` (forceSettle cases)
- Test: `packages/api/test/admin-submissions.test.ts`

**Interfaces:**
- Consumes: existing auth middleware (`role === "admin"` on the authed user), `SqliteEventStream` accessor (Task 5).
- Produces:

```typescript
// engine types.ts — SessionStore additions
/** All unsettled submissions across sessions (operator surface). */
listAllUnsettledSubmissions(): Promise<QueueItem[]>;
/**
 * Operator escape hatch: CAS any non-settled status → settled with the given
 * outcome; deletes attempt markers. Throws ConflictError if already settled.
 * Returns the settled item.
 */
forceSettle(
  sessionId: string,
  itemId: string,
  outcome: "failed" | "aborted",
  error?: string,
): Promise<QueueItem>;
```

**Routes:**
- `GET /api/admin/submissions` → `{ submissions: AdminSubmission[] }` where `AdminSubmission` = the `QueueItem` lifecycle fields + lease view: `{ id, sessionId, threadId, status, outcome, error, attemptId, attemptCount, maxAttempts, ownerId, leaseExpiresAt, leaseExpired: boolean, timeoutAt, abortRequestedAt, supersededByItemId, mergedIntoItemId, createdAt, updatedAt }` (`leaseExpired = leaseExpiresAt != null && leaseExpiresAt < now`). No `content` (bodies may hold user data; the operator list is lifecycle-only). Query `?sessionId=` scopes to one session and then uses `listUnsettledSubmissions(sessionId)` plus settled items via the session's item listing if available — keep it simple: with `sessionId`, return that session's unsettled items only too; full history inspection goes through the session's own API.
- `POST /api/admin/submissions/:sessionId/:itemId/force-settle` body `{ outcome: "failed" | "aborted", error?: string }` → validates outcome, calls `store.forceSettle`, then appends `submission_settled` to the event stream with eventKey `settled:{itemId}` (idempotent against any concurrent engine settlement), returns the settled item. Already-settled → 409 `{ error, code: "conflict" }`. If the session is live in the host, also nudge it (`session.threads` kick or simply `engineHost.sessionFor(...)` touch) so a wedged in-memory state reconciles — a follow-up claim on a force-settled item is fenceless-safe because claims require non-settled status.

**forceSettle store semantics (both backends):** single transaction — `UPDATE engine_queue_items SET status='settled', outcome=?, error=?, updated_at=? WHERE session_id=? AND id=? AND status != 'settled'`; `changes === 0` → row exists? settled → `ConflictError`; missing → `NotFoundError`. Then `DELETE FROM engine_attempt_markers WHERE item_id=?`. A concurrent engine holding a fence on that item will hit `StaleAttemptError`/CAS failures on its next write and self-fence — that is the designed zombie behavior, no extra coordination needed.

- [ ] **Step 1: Write the failing tests.**
  - Contract: (a) `forceSettle` on a running item → settled with outcome, markers gone, subsequent `claimSubmission` on it returns null, subsequent `reserveSettlement` by the old attempt throws (stale); (b) forceSettle twice → `ConflictError`; (c) `listAllUnsettledSubmissions` spans sessions and excludes settled.
  - API: non-admin user → 403 on both routes; admin lists a wedged (lease-expired) submission with `leaseExpired: true`; force-settle returns 200 + settled item and a `submission.settled` frame reaches a connected WS client; repeat force-settle → 409.
- [ ] **Step 2: Red.**
- [ ] **Step 3: Implement** (store methods + contract, route file, mount).
- [ ] **Step 4: Green.** All suites + `pnpm typecheck`.
- [ ] **Step 5: Commit** — `feat(api): admin submissions surface with force-settle`.

---

### Task 7: Web — offset resume, submission-state surfaces

**Files:**
- Modify: `packages/web/src/api/ws.ts` (`?fromOffset` on reconnect; no reset on resumed connect)
- Modify: `packages/web/src/stores/stream.ts` (`lastOffset` tracking, offset dedupe, queue-state slice, settled indicators)
- Modify: `packages/web/src/wire/types.ts` (mirror the API wire changes — this file is the client copy of the wire contract; keep them identical)
- Modify: `packages/web/src/components/session/` (message-list or thread view: superseded/merged/queued indicators; verify `decision-gate-card.tsx` against unchanged gate wire shapes)
- Test: `packages/web/src/stores/stream.test.ts` (extend the existing reducer tests; if none exist for the store, create this file using the same vitest setup as neighboring tests)

**Interfaces:**
- Consumes: Task 5 wire shapes (`offset?`, `queue.state`, `submission.settled`).
- Produces: UI behavior only.

**Design (implement exactly):**

1. **`lastOffset`:** `SessionStreamState` gains `lastOffset: string` (`""` initial). The reducer updates it to `max(lastOffset, ev.offset)` (string compare — offsets are fixed-width) on every framed event that carries an offset; `chunk` never advances it. Frames with `offset && offset <= lastOffset` are dropped (replay/live-boundary dedupe). `seq`-based dedupe is removed along with `lastSeq`.
2. **Reconnect:** `useSessionWebSocket` reads the store's `lastOffset` when (re)opening; if non-empty, append `?fromOffset=` to the WS URL and SKIP the `reset(sessionId)` + REST refetch invalidation on that connect (state is continuous; replay fills the gap — no flash). First-ever connect (empty `lastOffset`) keeps today's behavior: reset + REST bootstrap of messages and gates.
3. **Queue state:** reducer handles `queue.state` → store per-thread `{ status, activeItemId, pendingIds, collectingIds, blockedGateId }`. Composer area shows a small indicator when `pendingIds.length > 0` ("N queued") and when status is `paused`/`blocked_on_decision_gate` (the gate card already covers blocked — just don't double-render).
4. **Settled indicators:** reducer handles `submission.settled` → for `superseded`/`merged`, mark the matching optimistic/user message (matched by `queueItemId` when present, else content-match fallback consistent with the existing optimistic dedupe) with a muted badge ("superseded" / "merged into next"). `completed` clears any queued badge; `failed`/`aborted` show a subtle failure badge on the turn.
5. **Gate cards:** shapes unchanged on the wire; verify resolve/withdraw round-trips still pass and that a gate re-delivered via replay (offset < live) doesn't duplicate the card (`pendingGates` map keyed by gateId already idempotent — assert it in the reducer test).

- [ ] **Step 1: Write the failing reducer tests** (`stream.test.ts`): offset advance + dedupe (feed frames offsets 1,2,2,3 + a `chunk` → 3 messages applied, `lastOffset` = 3's offset, chunk applied but no offset advance); `queue.state` populates the slice; `submission.settled` superseded marks the message; gate replay idempotence.
- [ ] **Step 2: Red.**
- [ ] **Step 3: Implement points 1–5.**
- [ ] **Step 4: Green + manual check.** `pnpm --filter @valet/web test`, `pnpm typecheck`. Manual: `make dev-local`, open a session, mid-stream reload the page → conversation continues without flash; DevTools WS tab shows `fromOffset` on the reconnect URL.
- [ ] **Step 5: Commit** — `feat(web): offset-based stream resume + submission state surfaces`.

---

### Task 8: Integration proofs — kill-mid-gate E2E, crash-mid-collect, cleanup

**Files:**
- Create: `packages/engine/test/kill-mid-gate.test.ts` + `packages/engine/test/kill-gate-child.ts` (mirror the kill-mid-turn pattern)
- Modify: `packages/engine/test/reconciliation.test.ts` (crash-mid-collect split-turn case)
- Modify: `Makefile` (extend the manual dogfood comment with the Phase 2 gate procedure)
- Chore: rebuild stale `dist/` artifacts (`pnpm -r build` or the workspace build target) — Phase 1 noted stale `resumeToolResults` references in built output

**Interfaces:** consumes everything; produces the phase's exit-criterion evidence.

**Design:**

1. **kill-mid-gate** (the roadmap exit criterion, automated): child process boots a real `Engine` over a file-backed `SqliteSessionStore` + `SqliteEventStream`, faux provider scripted so a tool calls `requestDecision` (approval, resumeKey `"kg"`); child prints `READY:{gateId}` once the gate row is `pending` and the submission is `blocked_on_decision_gate`, then hangs; parent SIGKILLs it. Parent then boots a fresh `Engine` over the same db, `restoreSession` (reconciliation re-arms the gate), resolves via `session.resolveDecision(gateId, { action: "approve", ... })`, and asserts: continuation completes (`awaitResult` → completed), the gate row is `resolved`, gateId ordinal suffix is `:0` (same gate, not a twin), the event log contains exactly one `gate:{gateId}:pending` and one `gate:{gateId}:resolved` event (appendOnce across the restart), and the event log's offsets are gap-free. 45s timeout, mirroring kill-mid-turn.
2. **crash-mid-collect split-turn** (Phase 1 carry-forward): in `reconciliation.test.ts`, simulate a crash between collect-window flush steps (admit N collecting items, run the flush partially by driving the store to the mid-flush state Phase 1's report described, then reconcile with a fresh session) and assert the documented degraded-not-corrupt behavior: a second merged item is created, all originals settle `merged`, no item is lost or double-run (every original has exactly one `mergedIntoItemId`, both merged turns settle).
3. **Makefile dogfood note:** append the Phase 2 manual procedure to the existing dogfood comment block: create session → prompt that triggers an approval gate → kill API mid-pending → restart → resolve from the web UI → verify the turn completes via replay and the browser resumed without flash.

- [ ] **Step 1: Write kill-mid-gate (red until any missing seam is exposed — reuse `kill-child.ts`'s faux-provider scripting; the gate child differs only in the scripted tool).**
- [ ] **Step 2: Write the crash-mid-collect test (red or green — if green immediately, verify it actually exercises the mid-flush state by asserting the intermediate store shape before reconciling).**
- [ ] **Step 3: Make both green.** Flake-check the kill test with 3 consecutive runs.
- [ ] **Step 4: Full-workspace gate.** `pnpm -r build`, `pnpm test` (workspace), `pnpm typecheck`.
- [ ] **Step 5: Commit** — `test(engine): kill-mid-gate E2E + crash-mid-collect split-turn proof`.

---

## Exit Criteria (from the roadmap — verified at final review + manual dogfood)

1. Browser reload mid-stream loses nothing: offset resume, no refetch flash (Task 7 manual + reducer tests).
2. Kill the server while a gate is pending, restart, resolve the gate from the UI, turn completes via replay (Task 8 automated + manual dogfood).
3. Conformance suites green: EventStream contract on both implementations; extended store/submission/restart-safe-gates contracts on both backends.

## Spec-coverage notes

- `submission_stuck` routing stays Phase 4 (bridge keeps dropping it); the event now lands in the durable log like everything else, which is all Phase 2 owes it.
- `awaitResult` semantics unchanged: linkage + 50ms durable poll is correctness; `submission_settled` events (now emitted everywhere, deduped by key) are wakeups and UI truth.
- Cross-session firehose reads (`EventFilter` without sessionId) exist only behind the admin surface; the WS route always scopes to its session (spec §1969).
- REST `/messages` remains the no-offset history path; `init` stays metadata-only (CLAUDE.md hard rule).
