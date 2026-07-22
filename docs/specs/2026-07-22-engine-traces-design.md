# Engine Traces — per-turn usage/cost, start-ref stamping, settle-time patch capture

**Date:** 2026-07-22
**Status:** Draft
**Scope:** Three additive trace-completeness changes to `packages/engine`: (1) persist per-turn LLM usage and cost on the assistant `MessageEntry`; (2) stamp the sandbox workspace's repo URL, branch, and commit SHA on the session record at first-boot; (3) capture a workspace patch (`git diff --cached <start_ref>`) as a BlobStore blob when a submission settles, keyed by `sessionId + queueItemId`. Migration edits `0000_engine.sql` in place (single-file convention, `packages/store-postgres/src/migrate.ts:12-25`) and bumps `ENGINE_SCHEMA_VERSION`.

## Motivation

Valet V2's engine (`packages/engine`) is a library with durable traces (`engine_entries` transcript DAG + `engine_events` event log). We are building toward:

- (a) **production observability** — usage/cost visibility per model per session, standing rollup surfaces;
- (b) **an eval harness** that wraps the engine and runs the same task against multiple models, comparing performance *and* cost;
- (c) **a classifier pipeline** that works backwards from high/low-value production sessions to seed a curated eval set.

All three sit on trace completeness. Today there are three gaps.

**Gap 1 — usage isn't durable.** Per-turn token usage is captured live inside `Thread` (`packages/engine/src/thread.ts:186-189` declares `lastAssistantUsage`, populated at `thread.ts:2756-2769` inside the `turn_end` handler), but it is a private in-memory field used only for compaction decisions. It never lands on the `MessageEntry` that the same handler persists. Rehydration (the `messagesFromEntries` walker around `thread.ts:3207-3266`) reconstructs LLM context by fabricating zero-filled usage/cost, which proves the pi-ai `Usage` shape (`{ input, output, cacheRead, cacheWrite, totalTokens, cost: { input, output, cacheRead, cacheWrite, total } }`) is well known here — we just don't write it back.

**Gap 2 — no start ref.** `engine_sessions` (`packages/store-postgres/migrations/pg/0000_engine.sql:137-160`) and `SessionData` (`packages/engine/src/types.ts:37-60`) hold `workspace: string` as a display label (e.g. `"valet"`) and a `sandboxId`. No column records what code the sandbox actually booted with. The host clones a repo into the sandbox via the `prepareSandbox` seam (`types.ts:1188`, called from `sandbox/attachment.ts:438-451`), but the result of that clone — repo URL, branch, commit SHA — is never surfaced back to the engine or persisted. A session whose repo was on `dev-v2` at commit `abc123` on Tuesday is indistinguishable, in the trace, from the same session run against `main` at commit `xyz789` on Thursday.

**Gap 3 — no ground-truth diff.** "What did this session change on disk?" cannot be reconstructed from tool calls. Bash mutations are opaque (`sed -i`, `mv`, `rm -rf`), edit tools race with each other and with the model's imagination, and even a perfect tool-call trace tells you what the model *tried* to do, not what actually landed. We currently have no way to answer "show me the diff" for a settled submission without asking the model to introspect the sandbox — which is what we are trying to evaluate in the first place.

**Trace completeness is what unlocks the roadmap.** Without (1), a multi-model eval cannot compare cost. Without (2), a production session cannot be replayed as an eval task. Without (3), the classifier has no ground-truth signal to score sessions on. Every session that runs before (2) and (3) exist is unusable as eval seed data — that is why this ships now, as a small substrate PR ahead of the harness and classifier work.

## Context: what already exists

- **Engine event bus** already emits `turn_end`, `submission_settled`, `sandbox_status`, and friends (`packages/engine/src/types.ts:731-801`). Subscribers can consume across sessions (`eventStream.subscribe({ eventTypes })`) — this is how the attention router is wired and how a future telemetry projection can attach without engine changes.
- **BlobStore** is a first-class optional provider (`packages/engine/src/types.ts:710-718`, exposed as `providers.blobs?` on `ProviderBundle` at `types.ts:1356`) with `put(key, data, opts?) / get(key) / delete(key)`. Nothing in the engine currently writes patches; putting patches through this seam re-uses an existing, provider-swappable I/O path.
- **`prepareSandbox` seam** (`types.ts:1188`, `sandbox/attachment.ts:438-451`) runs once per (sandbox, epoch) after cold-boot and before any waiter is admitted. This is where the host clones the repo today, and therefore where the host can hand the engine a start-ref.
- **Two-phase settlement** (`thread.ts:1428-1458` in `settleTurn`) already has a well-defined seam between `reserveSettlement` and `finalizeSettlement`, with `repairRestState` running in between. This is the correct site for best-effort patch capture — it is guaranteed to run exactly once per settled item under the write fence.
- **Overlapping-but-different work:** `docs/specs/2026-07-16-usage-telemetry-design.md` proposes a new `turn_usage` engine event and an api-side `telemetry_events` projection. That spec's engine change and this one's are complementary, not conflicting; see [Relationship to the usage-telemetry spec](#relationship-to-the-usage-telemetry-spec) below.

## Decisions (locked)

1. **Usage and cost land on the assistant `MessageEntry`, not only on a bus event.** The transcript DAG must be self-contained — a consumer that reads `engine_entries` for a session (eval replay, offline scoring, forensic debugging) must not have to also read `engine_events` for the accompanying `turn_end`/`turn_usage` event to reconstruct cost. Bus events are lossy (per-submission retention, `EVENT_RETENTION_MS`); entries are durable.

2. **Migration: edit `0000_engine.sql` in place, bump `ENGINE_SCHEMA_VERSION` from `2` to `3`.** This is the enforced convention (`packages/store-postgres/src/migrate.ts:12-25` comment: "we edit `0000` in place, never add `0001`/`0002`"). Pre-1.0 the DB is expected to be wiped on version bumps (`rm -rf ~/.valet/pg`). No online migration is designed; `assertSchemaVersion` fails loud on any mismatch. Also stamp the new version in the `engine_meta` INSERT at line 118.

3. **The `turn_end` durable event payload also carries usage/cost.** Duplicating what lands on the entry costs one JSON-serialized object per turn and lets an event-bus consumer (the telemetry-projection host) run without ever touching `engine_entries`. The two paths must be written from the same `lastAssistantUsage` snapshot inside the same `turn_end` handler branch to guarantee identical values.

4. **Start-ref is captured by the host and handed to the engine through a new field on `CreateSessionOptions`, not sniffed by the engine.** Only the host knows *what it cloned*: `prepareSandbox` is arbitrary user code that could set up a workspace by tarball extraction, git clone, symlink, or none of the above. A new optional `startRef?: SessionStartRef` field on `CreateSessionOptions` (structural) is written to `engine_sessions` verbatim at `saveSession`. Absent-means-absent; the engine never derives this from `sandbox.exec("git rev-parse HEAD")`.

5. **Patch capture runs at every settle, best-effort, out of the write fence path.** Failure to capture (sandbox dead, non-git workspace, blob store rejects) never fails the settle — it logs and records skip metadata, mirroring how `Session.emit` log-and-continues on append failure. The reserve/finalize CAS is not weakened by patch I/O.

6. **Patch blob key is deterministic: `patches/{sessionId}/{queueItemId}.diff`.** No unique-per-call suffix — a duplicate settle (reconciliation, `retryFinalize`) reproduces the same key and `put` overwrites in place. Consumers key on `(sessionId, queueItemId)`; the store already treats these as the canonical dimensional pair on `engine_queue_items`.

7. **Patch reference lives on the `submission_settled` event payload AND on a new column of `engine_queue_items`.** The event field lets a live consumer link the diff without another store read; the column lets an offline reader query "which items have captured patches" in SQL. Both point to the same key.

8. **Untracked files: `git add -N` (intent-to-add), then `git diff HEAD` — index never actually mutated.** This produces one patch that includes both tracked modifications and new files, does not stage anything for a real commit, and requires no reset. `-N` records only a stub in the index that `diff` treats as an addition; a subsequent `git reset` (added below as belt-and-braces) restores a clean index for anything downstream that inspects it. This is the canonical `git stash`-free approach and works on empty and non-empty repos alike.

## Change 1 — per-turn usage and cost on `MessageEntry`

### Type changes

Add two optional fields to `MessageEntry` (`packages/engine/src/types.ts:272-297`):

```ts
export interface MessageUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface MessageCost {
  input: number;   // USD
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface MessageEntry extends BaseEntry {
  type: "message";
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  parts?: MessagePart[];
  author?: PromptAuthor;
  channel?: ChannelTarget;
  model?: string;
  stopReason?: "end_turn" | "error" | "abort";
  /** Present only on the turn's final assistant entry when the model reports usage. */
  usage?: MessageUsage;
  /** Present only when the model is in pi-ai's pricing registry; unpriced turns omit. Never zero-filled. */
  cost?: MessageCost;
  signal?: { /* unchanged */ };
}
```

The `usage.total` shape mirrors the existing private `lastAssistantUsage` (`thread.ts:187-189`), so no unit conversion is needed. `MessageCost.total` uses the pi-ai `Usage.cost.total` sum directly.

**Explicitly not stored:** `MessageEntry.model` already exists, and pi-ai's `Usage` shape does not add a per-cache-token *token count* separate from the four we capture. `turnDurationMs` is intentionally not stored on the entry — it belongs on the event (change below) and is cheap for consumers to re-derive from `message_start`→`turn_end` timestamps if needed.

### Where the write happens

The assistant `MessageEntry` is inserted at `thread.ts:2662-2678` (the `message_end` handler), *before* the `turn_end` handler runs and updates `lastAssistantUsage`. Options:

- **(A)** Move the entry write to `turn_end`. Rejected — `message_end` also emits the durable `message_end` bus event, and callers rely on the entry existing at that point (tool_execution_end re-persists via `updateEntry`, `thread.ts:2738-2743`).
- **(B, chosen)** Add an in-place `updateEntry` call in the `turn_end` handler right after `lastAssistantUsage` is captured (`thread.ts:2761-2769`). The handler already knows the entry id (`this.currentAssistantMessageId`) and holds `this.currentAssistantEntry` (mutated in `tool_execution_end`), so it mutates `entry.usage` / `entry.cost` and calls `store.updateEntry` under the same fence. This preserves ordering (`message_end` emit fires first, usage lands second) and does not change the `appendEntries` semantics.

Sketch:

```ts
case "turn_end": {
  // …existing stop-reason and error handling…
  if (event.message.role === "assistant") {
    const u = event.message.usage;
    this.lastAssistantUsage = { /* unchanged */ };
    if (this.currentAssistantEntry) {
      const entry = this.currentAssistantEntry;
      entry.usage = {
        input: u.input,
        output: u.output,
        cacheRead: u.cacheRead,
        cacheWrite: u.cacheWrite,
        total: u.totalTokens || u.input + u.output + u.cacheRead + u.cacheWrite,
      };
      if (u.cost && u.cost.total > 0) {
        entry.cost = { /* copy the five USD numbers verbatim */ };
      }
      await this.fencedWrite(() =>
        this.session.providers.store.updateEntry(this.session.id, this.id, entry, this.fence),
      );
    }
  }
  // …existing turn_end emit, now enriched with usage/cost (see Change 3 in this section)…
}
```

**"Cost is null, not zero":** the pi-ai model registry does not price every model (custom providers, dev-mode fakes). When `u.cost` is absent or its `total` is 0, do not write a `cost` field. Consumers rendering aggregate cost sum only present values — a missing model reads as "unpriced," never "$0."

### The `turn_end` engine event now carries usage/cost

`EngineEvent`'s `turn_end` variant (`types.ts:749`) is extended:

```ts
| {
    type: "turn_end";
    threadId: string;
    reason: "end_turn" | "error" | "abort";
    model?: string;
    usage?: MessageUsage;
    cost?: MessageCost;
    turnDurationMs?: number;
  }
```

Written from the same `lastAssistantUsage` snapshot inside the `turn_end` handler branch, immediately before `fencedEmit` fires the `turn_end`. `turnDurationMs` is `Date.now() - this.turnStartedAt` (a new field captured at claim/resume; sketch below). Non-assistant `turn_end`s (aborted with no assistant activity) carry none of these three fields.

### Migration (change 2)

Edit `packages/store-postgres/migrations/pg/0000_engine.sql` in place:

```sql
CREATE TABLE "engine_entries" (
  -- …existing columns unchanged…
  "usage" text,   -- JSON-serialized MessageUsage, or NULL
  "cost" text,    -- JSON-serialized MessageCost, or NULL
  "created_at" bigint NOT NULL
);
```

Add `"usage"` and `"cost"` to `ENTRY_COLUMNS` in `packages/store-postgres/src/store.ts:198-226` (both alphabetized as the existing list is unordered) and to `entryInsertParams` / the `UPDATE engine_entries` statement at `store.ts:413-431`. Serialize as JSON strings for parity with the existing `parts`/`metadata` columns. Read path (~`row.usage ? JSON.parse(row.usage) : undefined`) mirrors existing patterns.

Bump `ENGINE_SCHEMA_VERSION` from `"2"` to `"3"` in `packages/store-postgres/src/migrate.ts:12` and update the `engine_meta` INSERT (`0000_engine.sql:118`).

## Change 2 — start-ref stamping

### Type additions

New type, added near `SessionData`:

```ts
export interface SessionStartRef {
  /** Canonical clone URL, without secrets (e.g. `https://github.com/tkhq/valet.git`). */
  repoUrl: string;
  /** Fully-qualified branch as fetched (e.g. `dev-v2`), or `undefined` for detached-HEAD boots. */
  branch?: string;
  /** Full 40-char SHA. Never a short hash — replay must be unambiguous. */
  commitSha: string;
  /** Best-effort capture wall clock. Convenience only; the row's `created_at` is the source of truth. */
  capturedAt: number;
}
```

Add to `SessionData`:

```ts
export interface SessionData {
  // …existing fields…
  /** Start-ref for the sandbox workspace, captured after prepareSandbox completes. Absent for sessions that predate this field or ran without a git-backed workspace. */
  startRef?: SessionStartRef;
  // …
}
```

Add to `CreateSessionOptions` (`types.ts:1137-1236`):

```ts
export interface CreateSessionOptions {
  // …existing fields…
  /**
   * Start-ref for this session's workspace. Set by the host after `prepareSandbox`
   * completes and the workspace state is known. Persisted verbatim on the session
   * row; treated as opaque by the engine. Absent === no start-ref recorded (this
   * session is not eval-replayable).
   */
  startRef?: SessionStartRef;
  // …
}
```

### Where the host stamps it

Two acceptable host patterns; the engine does not care which:

- **(A, preferred)** The host resolves start-ref *before* `createSession` — from the clone-and-checkout it performs at session-boot orchestration time — and passes it in `CreateSessionOptions` directly. This is straightforward when the host clones out-of-band (e.g. the api pre-populates a PVC and hands the sandbox a ready workspace).
- **(B)** The host resolves start-ref *inside* `prepareSandbox`, then calls `session.setStartRef(ref)` on the engine after `createSession` returns but before the first submission is admitted. This is required when the clone happens inside the sandbox itself.

**(B)** implies a new `Session.setStartRef(ref: SessionStartRef): Promise<void>` method that updates `this.options.startRef` in memory and persists via `store.saveSession`. Idempotent, single-shot: subsequent calls throw `ValidationError` if the recorded start-ref differs (a session's start conditions are immutable by definition — a second call with a different ref indicates a host bug, not a legitimate state change).

The engine defines no policy about *how* the host captures start-ref. A typical `prepareSandbox` invocation for git-backed workspaces will run:

```
git -C <workspace> config --global --add safe.directory <workspace>
url=$(git -C <workspace> remote get-url origin)
sha=$(git -C <workspace> rev-parse HEAD)
branch=$(git -C <workspace> rev-parse --abbrev-ref HEAD)  # HEAD if detached
```

…and pass `{ repoUrl: url, commitSha: sha, branch: branch === "HEAD" ? undefined : branch, capturedAt: Date.now() }` to `setStartRef`. The engine does not run these commands; the host does.

### Migration

Edit `0000_engine.sql`:

```sql
CREATE TABLE "engine_sessions" (
  -- …existing columns unchanged…
  "start_ref" text,  -- JSON-serialized SessionStartRef, or NULL
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL
);
```

Add `start_ref` to the `saveSession` INSERT / ON CONFLICT UPDATE (`packages/store-postgres/src/store.ts:270-298`) and to the row hydration path (`store.ts:1160-1190` region — `sessionFromRow`-shaped code). No new index required: the query "give me the start-ref for this session" is by primary key.

### Why not a metadata blob

`SessionData.metadata?: Record<string, unknown>` already exists. Rejected as the home for start-ref because:
- `metadata` is intentionally free-form host-owned scratch space with no engine semantics. Start-ref is engine-semantic (submission-outcome replay tooling needs to read it without knowing about host conventions).
- SQL indexes and joins over metadata JSON are more expensive and less discoverable than a named column.
- A future eval harness will query `SELECT id, start_ref FROM engine_sessions WHERE …` — that query should not hinge on a magic JSON path.

### Impact on sessions that predate this field

Sessions created before this migration have `start_ref = NULL`. They are **not eval-replayable** — that is inherent to the change, not a bug. The eval harness must filter for `start_ref IS NOT NULL` when seeding tasks. This is a one-time cost that shrinks with every new session; it is the whole reason the field ships now rather than later.

## Change 3 — settle-time patch capture

### What gets captured

At every submission settlement, produce a unified diff of the sandbox workspace against the session's start-ref, using untracked-inclusive semantics that do not require a stash:

```
git -C <workspace> config --global --add safe.directory <workspace>   # idempotent, no-op if set
git -C <workspace> add -N .                                            # intent-to-add for untracked
patch=$(git -C <workspace> diff <start_ref>)                           # unified diff, includes new files
git -C <workspace> reset -q                                            # belt-and-braces: restore clean index
```

**Why `git add -N` instead of `git add -A`:** `-A` fully stages every change, which permanently mutates the index — every downstream reader (subsequent tools, subsequent turns, subsequent reconciliation) sees a staged-but-uncommitted repo. `-N` records only a stub that `git diff` treats as "new file, all lines added," producing an equivalent patch, but leaves the index effectively clean. The trailing `git reset -q` clears even the `-N` stubs, guaranteeing the workspace's git state after capture is byte-identical to before capture.

**Command sequence choice, alternatives considered and rejected:**
- `git stash --include-untracked` + `git stash show -p` — creates and immediately removes a stash entry, mutates reflog, and races if a concurrent tool is mid-`git`.
- `git format-patch <start_ref>..HEAD` — only captures committed changes; misses everything the session did without committing (the common case).
- `git add -A && git diff --cached && git reset` — works, but the intermediate state is a fully staged repo. If capture crashes between `add` and `reset`, the sandbox is left in a partially-staged state. `-N` narrows the window.

### Where it runs in the engine

Inside `Thread.settleTurn` (`packages/engine/src/thread.ts:1428-1458`), between `reserveSettlement` and `finalizeSettlement`, alongside the existing `repairRestState` call:

```ts
private async settleTurn(item: QueueItem, turnFailure?: { error: unknown }): Promise<void> {
  // …existing guards…
  const outcome = this.decideTurnOutcome(current, turnFailure);
  try {
    await store.reserveSettlement(this.session.id, this.id, item.id, outcome, fence);
    await this.repairRestState(item, fence);
    const patchRef = await this.capturePatch(item);   // NEW: best-effort, never throws
    await store.finalizeSettlement(this.session.id, this.id, item.id, fence, { patchRef });
    // …existing marker delete + emit…
  }
  // …
}
```

Also runs from `settleUnclaimed` sites (superseded/aborted-in-queue) via a smaller helper — the same call, minus the fence. Skipped for `merged` and `superseded` outcomes where the item never got a claim (no tool ran, so there is definitionally no diff to capture); the metadata reflects `"skipped:no_work"` in these cases.

### `capturePatch` — the best-effort helper

New method on `Thread` (or a small helper module `packages/engine/src/patch-capture.ts`), signature:

```ts
interface PatchCaptureResult {
  status: "captured" | "skipped" | "failed";
  reason?: string;               // human-readable when not captured
  blobKey?: string;              // `patches/{sessionId}/{queueItemId}.diff` when captured
  patchBytes?: number;           // uncompressed bytes; useful for cost/observability
  truncated?: boolean;           // true when patch exceeded the size cap
}

async function capturePatch(
  session: Session,
  item: QueueItem,
): Promise<PatchCaptureResult>;
```

Contract:

1. **No throws.** Every path returns a `PatchCaptureResult`. An unexpected exception is caught inside the helper and converted to `{ status: "failed", reason: err.message }`, then logged with `console.error("[engine] patch capture failed:", …)` — the log-and-continue idiom already used for heartbeat/sweep failures (`session.ts:181-206`).

2. **Early-out preconditions, in order:**
   - `session.providers.blobs === undefined` → `{ status: "skipped", reason: "no_blob_store" }`. The engine is optional-blob by design.
   - `session.options.startRef === undefined` → `{ status: "skipped", reason: "no_start_ref" }`. Cannot diff against nothing.
   - Sandbox attachment not `ready` (query via `session.attachment.status` — a hibernated/released sandbox reports `suspended`/`released`) → `{ status: "skipped", reason: "sandbox_${state}" }`. Do not force a re-provision to capture a diff.

3. **Non-git workspace detection.** Run `git -C <workspace> rev-parse --is-inside-work-tree`. Any non-zero exit → `{ status: "skipped", reason: "not_a_git_workspace" }`. Do not fabricate a diff for tarball-based sandboxes.

4. **Size cap: 2 MiB uncompressed, head-only truncation, marker at the end.** Default `MAX_PATCH_BYTES = 2 * 1024 * 1024`. When `patch.length > MAX_PATCH_BYTES`, store the first `MAX_PATCH_BYTES - marker.length` bytes followed by:

   ```
   \n\n[TRUNCATED: original patch was N bytes; only the first 2 MiB stored]\n
   ```

   Truncation is marked in the result (`truncated: true`) and in a queryable field on the queue item (below). We prefer head-only over reject-entirely because a truncated patch is still cross-checkable ("did any file change under `packages/engine`?") and useful for the classifier; rejecting a large diff throws away signal we can never recover.

5. **BlobStore put.** `blobs.put(key, encoder.encode(patch), { contentType: "text/x-diff" })` with `key = \`patches/${sessionId}/${queueItemId}.diff\``. Deterministic key, `put` overwrites on retry.

6. **Command sequence** (see [What gets captured](#what-gets-captured) for the exact shell). Executed via `sandbox.exec(command, { cwd: workspace, timeout: 30_000 })`. A `sandbox.exec` throw is caught and returned as `{ status: "failed", reason: "sandbox_exec: ${err.message}" }`.

### Where the patch reference lives

Two persistence surfaces, both pointing at the same blob key:

**(a) On `engine_queue_items`.** New nullable columns:

```sql
"settle_patch_status" text,      -- 'captured' | 'skipped' | 'failed'
"settle_patch_reason" text,      -- human-readable, only when status != 'captured'
"settle_patch_blob_key" text,    -- 'patches/{sessionId}/{queueItemId}.diff' when captured
"settle_patch_bytes" integer,    -- uncompressed size (post-truncation if truncated)
"settle_patch_truncated" integer,-- 0 or 1
```

Written inside `finalizeSettlement`. The single transactional finalize already writes settlement outcome — piggybacking on it keeps patch metadata in the same critical section. The `SessionStore.finalizeSettlement` signature grows an optional trailing `patchRef?: PatchCaptureResult` argument; existing callers that pass nothing observe today's behavior.

**(b) On the `submission_settled` engine event.** Extend the payload:

```ts
| {
    type: "submission_settled";
    sessionId: string;
    threadId: string;
    queueItemId: string;
    outcome: SubmissionOutcome;
    patch?: {
      status: "captured" | "skipped" | "failed";
      reason?: string;
      blobKey?: string;
      bytes?: number;
      truncated?: boolean;
    };
  }
```

Live consumers (the classifier's ingestion path, an eval harness watching for its own submissions to finish) get patch linkage without a second store read; offline consumers query the queue-item column. Both surfaces are populated from the same `PatchCaptureResult` object — the event fires *after* `finalizeSettlement` returns, mirroring today's `emitSettled` ordering, so the column and event never disagree.

### Failure modes and what each yields

| Situation | Detected by | Result | User-visible effect |
|---|---|---|---|
| Blob store not configured | `providers.blobs === undefined` | `skipped:no_blob_store` | Settle succeeds; column reflects skip |
| Session had no start-ref | `options.startRef === undefined` | `skipped:no_start_ref` | Same — expected for pre-migration sessions |
| Sandbox hibernated at settle | `attachment.state !== 'ready'` | `skipped:sandbox_${state}` | Same — replay is not eval-critical for these outcomes |
| Non-git workspace | `git rev-parse --is-inside-work-tree` nonzero | `skipped:not_a_git_workspace` | Same |
| Sandbox exec throws | try/catch inside helper | `failed:sandbox_exec:...` | Same; error logged; settle still succeeds |
| Patch exceeds size cap | `patch.length > MAX_PATCH_BYTES` | `captured` with `truncated: true` | Blob stored with truncation marker |
| `blobs.put` rejects | try/catch inside helper | `failed:blob_put:...` | Same |
| No mutating tool calls but diff non-empty (or vice versa) | Post-hoc consumer check | (n/a — cross-check is out of scope, see [Out of scope](#out-of-scope)) | Consumer flag |

### Migration for change 3

Edit `0000_engine.sql`:

```sql
CREATE TABLE "engine_queue_items" (
  -- …existing columns unchanged…
  "settle_patch_status" text,
  "settle_patch_reason" text,
  "settle_patch_blob_key" text,
  "settle_patch_bytes" integer,
  "settle_patch_truncated" integer,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL
);
```

Add the five columns to whatever `queueItemInsertParams` / update statements exist in `packages/store-postgres/src/store.ts`. No new index — reverse lookup ("which items have patches") is expected to be low-frequency and can scan.

## Relationship to the usage-telemetry spec

`docs/specs/2026-07-16-usage-telemetry-design.md` proposes a new `turn_usage` engine event fired inside the `turn_end` handler, feeding an api-side `telemetry_events` projection.

These specs are **complementary**:

- **This spec** (Engine Traces) makes usage/cost *durable inside the engine* — on the `MessageEntry` (source of truth for the transcript DAG) and on the `turn_end` bus event (belt-and-braces). This is what a replay-from-entries eval harness reads.
- **The usage-telemetry spec** builds an api-side aggregation over the bus events. It does not depend on entry storage.

The overlap is the "bus event carries usage" line. Once this spec ships, the usage-telemetry spec's proposed `turn_usage` variant becomes redundant: the `turn_end` event now carries the same data. Recommendation: in a follow-up, retire the `turn_usage` proposal in the telemetry spec and have the projection consume the enriched `turn_end`. This is a spec-hygiene note, not a change to either implementation.

The **cost is null, not zero** convention is shared with the telemetry spec (its decision 1: "cost … absent otherwise (never guessed)"). This spec uses the same rule for `MessageEntry.cost`.

## Failure modes (spec-wide)

- **Schema-version mismatch on an existing DB.** Pre-1.0 behavior applies: `assertSchemaVersion` fails loud, operator wipes `~/.valet/pg`. Called out here because three separate table changes ship in one bump — the wipe is more painful than a normal single-field bump. No online migration is designed.
- **Store write failure on the new `updateEntry` inside `turn_end`.** Routes through `fencedWrite`; a `StaleAttemptError` is the only special case, handled exactly as it is at `thread.ts:2740-2743` today. Any other exception surfaces via the existing turn-failure path.
- **`turn_end` event with usage but the accompanying `updateEntry` fenced out.** Consumers that trust the entry alone will not see usage for the aborted-mid-write turn; the event still carries it. Documented consequence: entries are eventually-consistent under stale-fence conditions, events are not. For eval replay this is acceptable — a stale-fenced turn is by definition a superseded attempt, not the one whose outcome we're replaying.
- **Very large patch on a low-blob-store backend.** 2 MiB caps the biggest write. The InMemoryBlobStore (`packages/engine/src/index.ts:49`) has no per-item size limit; the postgres/S3/GCS-backed BlobStores that ship later will need to allow at least this. Called out for future implementers.
- **Sandbox `exec` timeout during patch capture.** The helper sets a 30s timeout. On timeout, the helper returns `{ status: "failed", reason: "sandbox_exec_timeout" }` and the settle proceeds. Downstream: the sandbox may briefly hold a `-N` stub; the next tool call's own git operation will still work (the stub is a no-op for a subsequent `git add`).

## Out of scope

- **The eval harness itself.** How multi-model comparison is orchestrated, task-manifest format, results storage, and UI live in a separate spec. This PR is the substrate.
- **The classifier pipeline.** Feature extraction, labeling, model choice, and the human-in-the-loop curation surface are separate.
- **Eval-results storage.** No new tables for "here is task X's outcome across models Y, Z." Ships with the harness.
- **Cross-check between tool-call trace and captured diff.** "Trace shows zero mutating tool calls but diff is non-empty (or vice versa)" is a consumer-side integrity signal, worth building on top of the substrate but not gating this PR. Follow-up spec.
- **Retroactive backfill.** No attempt to derive start-ref or a diff for sessions that predate this change. Documented, accepted, not solved.
- **A UI for viewing captured patches.** The blob is queryable via `BlobStore.get`; a viewer is a separate frontend concern.
- **Store parity beyond postgres.** Only postgres is implemented today (`packages/store-postgres`); there is no sqlite store to keep in lockstep. When a second store lands, it inherits these columns.
- **Alternative capture cadences.** Per-tool-call patches, per-turn patches, and periodic snapshots are all evaluable extensions; this PR ships one patch per settle because that is the coarsest useful granularity and the cheapest to reason about.

## Open questions

1. **Should `MessageCost` carry the pricing source (e.g. `"pi-ai:2026-07"` vs. `"custom-provider-registry"`)?** Right now cost is opaque USD numbers. If pi-ai's registry updates rates mid-half, historical entries lose reproducibility. Proposal: add `costSource?: string` to `MessageCost`, populated from pi-ai when available. Deferred — decide after we look at whether pi-ai exposes this.

2. **Belt-and-braces `git reset` after capture: keep or drop?** `git add -N` alone leaves stubs the next tool's `git add` would sweep up harmlessly. The trailing `reset -q` is defensive. Drop if `sandbox.exec` overhead per settle becomes a concern; the win is one round trip. Suggest: keep for the first release, revisit after we have production settle latency percentiles.

3. **`SessionStartRef.repoUrl` normalization.** Should the engine or host canonicalize `git@github.com:tkhq/valet.git` → `https://github.com/tkhq/valet.git`? Argument for canonicalization: eval-seed queries join by repo URL and shouldn't fail on SSH-vs-HTTPS. Argument against: engine has no business normalizing host-supplied strings. Lean: host canonicalizes, engine stores verbatim.

4. **Patch capture for the `superseded` outcome.** Currently spec'd as skipped for items never claimed. But a claimed-then-superseded item *did* run some tool calls before supersession — should its partial diff be captured? Probably yes, keyed the same way. Deferred to implementation review; the seam supports either choice.

5. **Do we need a `saveStartRef` fence?** `Session.setStartRef` in host pattern (B) writes to `engine_sessions` outside a claim fence. If a concurrent host re-creates the session and races on the row, one write wins. Acceptable because the second write throws `ValidationError` on divergent content (decision 4); low-consequence for identical content.

## Exit criteria

Run a session against a real repo:

1. Assistant `MessageEntry` rows carry non-empty `usage` for every turn where the model reported usage, and `cost` where pi-ai priced the model.
2. `SELECT id, start_ref FROM engine_sessions WHERE id = '…'` returns the session's `{ repoUrl, branch, commitSha, capturedAt }` verbatim.
3. Modify a file via a bash tool and complete the turn; `SELECT settle_patch_blob_key FROM engine_queue_items WHERE id = '…'` returns a key; `BlobStore.get` on that key returns a valid unified diff that includes the change.
4. Point the sandbox at a non-git tarball workspace; run a submission; the row records `settle_patch_status = 'skipped'`, `settle_patch_reason = 'not_a_git_workspace'`. Settle still succeeds.
5. Kill the sandbox provider mid-submission; `settle_patch_status = 'failed'` or `'skipped'` depending on where the failure lands. Settle still succeeds.
6. `assertSchemaVersion` post-migration returns `"3"`; a DB stamped `"2"` is rejected loud.

## Testing

- **Engine unit:** `turn_end` handler writes `usage`/`cost` onto the entry when pi-ai reports them; omits when the model reports zeros or no cost; fenced-out writes swallow `StaleAttemptError`. Table-driven cases for the truncation marker, the empty-diff case, the non-git case, and the missing-blob-store case.
- **Patch-capture unit:** every branch of `PatchCaptureResult.status` × `reason` reachable by a stub `Sandbox` + `BlobStore`. Snapshot test on the exact shell command sequence emitted.
- **Store contract:** round-trip an entry with `usage` and `cost` set; an entry with only `usage` set; an entry with neither. Same for `SessionData.startRef` and the five queue-item patch columns.
- **Integration:** end-to-end session under sandbox-docker with a real git repo → assert entry rows, session row, queue-item row, blob presence, event payload. Same integration on a tarball workspace → assert skip.
- **Migration:** existing `dev-v2` engine DB is rejected on version mismatch (spec: "wipe and recreate"); a fresh DB comes up at `"3"`.

## Verification note — where prior research already checked

Field / line references above were re-verified in the current tree at `188a117a` (dev-v2 tip). Notes:

- `MessageEntry` was at `types.ts:272-297` per the prior research and remains at `types.ts:272-297`. No drift.
- `lastAssistantUsage` was cited at `thread.ts:186-189` and lives at `thread.ts:186-189` (declaration) / `thread.ts:2756-2769` (capture). No meaningful drift (prior "187-189" vs current "186-189" is a one-line comment-vs-declaration difference).
- pi-ai cost visibility cited at `thread.ts:3237` is at `thread.ts:3232-3239` in the rehydration path.
- The `EngineEvent` union cited by the usage-telemetry spec at `types.ts:676-746` currently lives at `types.ts:731-801` — drift of ~55 lines, expected.

**No contradictions found between prior research and the current code.** The "captured but never persisted" characterization of `lastAssistantUsage` is accurate: the only write of `lastAssistantUsage` is the assignment at `thread.ts:2763-2769`; the only read is `thread.ts:2115` (compaction). The value never reaches `store.appendEntries` or `store.updateEntry` today.
