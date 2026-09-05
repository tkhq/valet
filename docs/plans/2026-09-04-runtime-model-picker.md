# Runtime Model Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the session header's model picker synchronized with the concrete model currently serving an active submission, including an agent-initiated `switch_model`, without changing the user's persisted thread or session selection.

**Architecture:** The engine owns a transient, queue-item-correlated active-model snapshot and emits it when a submission starts, switches models, or settles. The API exposes that snapshot as `model.state` live events and seeds it after subscribing during the WebSocket handshake. The web store tracks the snapshot separately from persisted configuration, and the picker uses it only for its closed trigger label while selection, reasoning controls, and mutations continue to use the persisted model.

**Tech Stack:** TypeScript, Valet engine events, Hono WebSockets, React 19, Zustand, TanStack Query, Vitest, Testing Library

---

## File map

- `packages/engine/src/types.ts`: Define the active/idle engine model-state event shapes.
- `packages/engine/src/thread.ts`: Own the current queue-item/model snapshot and emit lifecycle changes.
- `packages/engine/test/model-switching.test.ts`: Prove start, agent switch, role override, and matching-settlement behavior.
- `packages/engine/test/fenced-emit.test.ts`: Prove stale attempts cannot publish model state over a successor.
- `packages/engine/test/reconciliation.test.ts`: Prove restart continuations expose and clear active model state.
- `packages/api/src/wire/types.ts`: Define active and idle `model.state` wire frames.
- `packages/api/src/engine/bridge.ts`: Translate engine `model_state` events to wire frames.
- `packages/api/src/engine/bridge.test.ts`: Lock the bridge mapping for active and idle states.
- `packages/api/src/routes/ws.ts`: Seed every thread's current model state after installing the live subscription.
- `packages/api/src/routes/ws.seed.test.ts`: Prove reconnects observe both active and idle model snapshots.
- `packages/api/src/cli/stream.ts`: Keep the exhaustive CLI wire-event guard in sync.
- `packages/api/src/cli/stream.test.ts`: Prove the CLI yields model-state frames.
- `packages/web/src/stores/stream.ts`: Track active models by thread and queue item, with correlated clearing.
- `packages/web/src/stores/stream.test.ts`: Cover live updates, explicit idle frames, and settlement races.
- `packages/web/src/components/session/model-picker.tsx`: Separate the displayed runtime model from the configured selection.
- `packages/web/src/components/session/model-picker.test.tsx`: Prove the trigger changes without changing checkmarks or reasoning support.
- `packages/web/src/components/session/session-header.tsx`: Feed the active thread snapshot into the picker and explain runtime/configured differences.
- `packages/web/src/components/session/session-header.test.tsx`: Prove the header follows the active thread and falls back to configuration.
- `docs/specs/2026-08-24-thread-model-pinning-and-compaction-design.md`: Record the approved transient-state contract.

### Task 0: Commit the reviewed plan before implementation

**Files:**

- Modify: `docs/specs/2026-08-24-thread-model-pinning-and-compaction-design.md`
- Create: `docs/plans/2026-09-04-runtime-model-picker.md`

- [x] **Step 1: Verify and commit the reviewed documents**

Run `git diff --check`, then commit the approved design and execution plan before changing runtime code.

```bash
git add docs/specs/2026-08-24-thread-model-pinning-and-compaction-design.md docs/plans/2026-09-04-runtime-model-picker.md
git commit --amend --no-edit
```

Expected: the worktree is clean and the amended design commit contains both documents.

### Task 1: Add the engine's correlated active-model lifecycle

**Files:**

- Modify: `packages/engine/src/types.ts`
- Modify: `packages/engine/src/thread.ts`
- Modify: `packages/engine/test/model-switching.test.ts`
- Modify: `packages/engine/test/fenced-emit.test.ts`
- Modify: `packages/engine/test/reconciliation.test.ts`

- [x] **Step 1: Add failing engine tests**

Extend the model-switching harness to capture engine events while a submission is blocked in the agent loop. Assert:

1. Claiming queue item `q-1` emits active state with `queueItemId: "q-1"` and the concrete catalog id formed as `${agent.state.model.provider}/${agent.state.model.id}`.
2. The queue-item model is exposed before pre-turn compaction can invoke the LLM, then a role model override replaces it before the main agent run.
3. `setModel(next, "tool:switch_model")` updates the same queue item's active state after the live agent is retargeted.
4. Settling that item emits the paired idle state.
5. Settling an unrelated merged or superseded item does not clear the running item's snapshot.
6. `currentModelState` returns the same active snapshot while running and the canonical idle shape afterward.
7. A stale attempt cannot deliver an active, switched, or idle model-state event after a successor owns the fence.
8. Both `replayBlocked` and `driveResumeToCompletionInner` expose the resolved model before `agent.continue()` and clear it on successful, error, and settlement-failure exits.
9. If the initial or recovery active-state publish detects a stale fence, neither the provider nor `agent.continue()` runs for that attempt, but the thread still clears its running item and active model, reports idle state, restores the normal model and prompt overlays, and runs the next prompt normally.

Use exact event matching so active frames require both strings and idle frames require both nulls.

- [x] **Step 2: Run the focused engine test and verify failure**

Run: `pnpm --filter @valet/engine test model-switching fenced-emit reconciliation`

Expected: FAIL because `model_state` and `currentModelState` do not exist.

- [x] **Step 3: Define and implement the engine state**

Add a discriminated engine event shape for active and idle frames. In `Thread`, store only the active pair:

```ts
type ActiveModelState = { queueItemId: string; model: string };

get currentModelState(): ActiveModelState | null {
  return this.activeModelState ? { ...this.activeModelState } : null;
}
```

Add helpers that:

- derive the concrete id from the actual `PiModel` as `${model.provider}/${model.id}`;
- emit only after the live model has been applied;
- update the current running item's model after an agent switch;
- clear and emit idle only when the settling queue item matches the stored `queueItemId`.

Use `fencedEmit` for every active, switched, and idle transition whenever an attempt fence exists. Make the state helper report whether fencing marked the attempt stale. Publish the queue-item state immediately after applying its resolved model and before pre-turn compaction; if publication detects stale ownership, skip compaction and `runAgent` through structured control flow that still reaches the existing model-restoration and claim-cleanup `finally` blocks. If `applyRoleForTurn(item)` changes the model, replace the state inside the existing overlay `try/finally` before `runAgent` and apply the same structured skip. In `replayBlocked` and `driveResumeToCompletionInner`, publish after `applyResolvedKeyForResume` and before `agent.continue()`, skip only the continuation when ownership is stale, and continue through settlement checks plus running-item/fence cleanup. Route terminal cleanup through the matching helper, including recovery and exceptional settlement paths, without clearing on per-round `turn_end`.

- [x] **Step 4: Run the focused engine test**

Run: `pnpm --filter @valet/engine test model-switching fenced-emit reconciliation`

Expected: PASS.

- [x] **Step 5: Commit the engine lifecycle**

```bash
git add packages/engine/src/types.ts packages/engine/src/thread.ts packages/engine/test/model-switching.test.ts packages/engine/test/fenced-emit.test.ts packages/engine/test/reconciliation.test.ts
git commit -m "fix: publish active submission model"
```

### Task 2: Carry model state through the API and reconnect handshake

**Files:**

- Modify: `packages/api/src/wire/types.ts`
- Modify: `packages/api/src/engine/bridge.ts`
- Modify: `packages/api/src/engine/bridge.test.ts`
- Modify: `packages/api/src/routes/ws.ts`
- Modify: `packages/api/src/routes/ws.seed.test.ts`
- Modify: `packages/api/src/cli/stream.ts`
- Modify: `packages/api/src/cli/stream.test.ts`

- [x] **Step 1: Add failing bridge and handshake tests**

Add bridge tests for both shapes. The production mapper is `busEventToWire`
and returns an array, so assert against its single mapped member:

```ts
expect(busEventToWire(activeEvent)).toEqual([expect.objectContaining({
  type: "model.state",
  threadId,
  queueItemId: "q-1",
  model: "anthropic/claude-opus-4-1",
})]);
expect(busEventToWire(idleEvent)).toEqual([expect.objectContaining({
  type: "model.state",
  threadId,
  queueItemId: null,
  model: null,
})]);
```

In the live WebSocket integration harness, spy on the public thread getter to return active and idle values. Instrument `providers.eventStream.subscribe` to prove subscription occurs before getter evaluation. Assert `init` remains first and every thread receives exactly one snapshot. Add a `fromOffset` reconnect case where replayed and subscription-buffered model events surround the snapshot; the final observed state must be the newest event, never an older snapshot.

Add a CLI socket fixture that sends `model.state`. Assert `streamSession` accepts and yields it in order, which also forces the exhaustive `WIRE_EVENT_TYPES` record to include the discriminant.

- [x] **Step 2: Run the focused API tests and verify failure**

Run: `pnpm --filter @valet/api test bridge.test ws.seed.test stream.test`

Expected: FAIL because the wire event and handshake seed are absent.

- [x] **Step 3: Add the wire contract and bridge mapping**

Define `model.state` as two union members so TypeScript rejects mixed active/idle fields. Map `model_state` in the engine bridge without changing the existing persisted `model_switched` event. Add `"model.state"` to the CLI's exhaustive wire-event record.

- [x] **Step 4: Seed snapshots after live subscription**

In the WebSocket open flow, preserve `init` as the first frame and existing queue/status seeds. Install the event-stream subscription, then send one authoritative `model.state` snapshot per thread. Use `thread.currentModelState` for active state and send both fields as null for idle state. Keep replay ordering and offset handling unchanged.

- [x] **Step 5: Run the focused API tests**

Run: `pnpm --filter @valet/api test bridge.test ws.seed.test stream.test`

Expected: PASS.

- [x] **Step 6: Commit the API contract**

```bash
git add packages/api/src/wire/types.ts packages/api/src/engine/bridge.ts packages/api/src/engine/bridge.test.ts packages/api/src/routes/ws.ts packages/api/src/routes/ws.seed.test.ts packages/api/src/cli/stream.ts packages/api/src/cli/stream.test.ts
git commit -m "fix: stream active model state"
```

### Task 3: Track active models without settlement races

**Files:**

- Modify: `packages/web/src/stores/stream.ts`
- Modify: `packages/web/src/stores/stream.test.ts`

- [x] **Step 1: Add failing store tests**

Test that the reducer:

1. Stores `{ queueItemId, model }` under the frame's thread on an active `model.state`.
2. Replaces the model for a second active frame with the same queue item.
3. Removes the thread entry on an explicit idle frame.
4. Removes it on a matching `submission.settled` fallback.
5. Keeps it when a different queued, merged, or superseded item settles.
6. Keeps other threads' entries throughout.
7. Clears the entire transient map on `init` before handshake snapshots reseed it.

- [x] **Step 2: Run the focused store test and verify failure**

Run: `pnpm --filter @valet/web test stream.test`

Expected: FAIL because `activeModelByThread` and `model.state` handling do not exist.

- [x] **Step 3: Implement the store slice and selector**

Add `activeModelByThread: Record<string, { queueItemId: string; model: string }>` to the empty session state. Reset it in the existing `init` case. Handle `model.state` with immutable set/delete updates. At the start of `submission.settled`, clear only when the stored queue item id matches, then continue the existing message-badge behavior even if no matching message exists. Export a narrow per-thread selector for the header.

- [x] **Step 4: Run the focused store test**

Run: `pnpm --filter @valet/web test stream.test`

Expected: PASS.

- [x] **Step 5: Commit web stream state**

```bash
git add packages/web/src/stores/stream.ts packages/web/src/stores/stream.test.ts
git commit -m "fix: track active models by submission"
```

### Task 4: Display runtime state without mutating picker semantics

**Files:**

- Modify: `packages/web/src/components/session/model-picker.tsx`
- Modify: `packages/web/src/components/session/model-picker.test.tsx`
- Modify: `packages/web/src/components/session/session-header.tsx`
- Modify: `packages/web/src/components/session/session-header.test.tsx`

- [x] **Step 1: Add failing picker tests**

Render `ModelPicker` with `currentId="l"` and `displayId="anthropic/claude-opus-4-1"`. Assert the closed trigger labels Opus, while opening the menu still checks Large and uses Large's configured target to enable or disable reasoning choices. Cover a runtime id absent from the catalog and verify its raw id is a safe trigger fallback.

- [x] **Step 2: Run the focused picker test and verify failure**

Run: `pnpm --filter @valet/web test model-picker.test`

Expected: FAIL because `displayId` is not accepted and the trigger still uses `currentId`.

- [x] **Step 3: Implement the display-only prop**

Add optional `displayId` to `ModelPickerProps`. Compute the trigger label from `displayId ?? currentId`; leave catalog readmission, selected checkmarks, mutation values, and `thinkingLevelsFor` based on `currentId`.

- [x] **Step 4: Add failing header integration tests**

Seed the stream store with active model state for the selected thread. Assert the header passes the runtime model as the display id and the persisted thread/session model as the current id. Switch active threads and assert the trigger follows the selected thread. Send idle state and assert it falls back to configuration. When runtime and configured ids differ after Anthropic normalization, assert the tooltip names both; equivalent bare/namespaced ids should not produce a false difference.

- [x] **Step 5: Run the focused header test and verify failure**

Run: `pnpm --filter @valet/web test session-header.test`

Expected: FAIL because the header does not consume active model state.

- [x] **Step 6: Connect the header and tooltip**

Read the active model for `activeThread.id`, calculate the persisted configured model exactly as today, and pass both values into the picker. Update the tooltip so a difference is explicit, for example `Currently using X for this submission. Configured as Y.` Preserve the existing thread/session scope explanation and use `sameModelSpec` to avoid reporting equivalent Anthropic forms as different.

- [x] **Step 7: Run focused web tests**

Run: `pnpm --filter @valet/web test model-picker.test session-header.test stream.test`

Expected: PASS.

- [x] **Step 8: Commit the model-picker integration**

```bash
git add packages/web/src/components/session/model-picker.tsx packages/web/src/components/session/model-picker.test.tsx packages/web/src/components/session/session-header.tsx packages/web/src/components/session/session-header.test.tsx
git commit -m "fix: show the active model in session header"
```

### Task 5: Validate the complete change and prepare the PR

**Files:**

- Modify if implementation details changed: `docs/specs/2026-08-24-thread-model-pinning-and-compaction-design.md`
- Modify: `docs/plans/2026-09-04-runtime-model-picker.md`

- [x] **Step 1: Finalize plan/spec documentation before review**

Record any verified implementation deviations now, mark completed plan checkboxes, and commit the documentation. The final reviewer and validation must inspect the final documentation rather than a later edit.

```bash
git add docs/specs/2026-08-24-thread-model-pinning-and-compaction-design.md docs/plans/2026-09-04-runtime-model-picker.md
git commit -m "docs: finalize runtime model picker plan"
```

- [ ] **Step 2: Run package-level regression tests**

Run:

```bash
pnpm --filter @valet/engine test
pnpm --filter @valet/api test
pnpm --filter @valet/web test
```

Expected: PASS.

- [ ] **Step 3: Run repository typechecking and diff checks**

Run:

```bash
pnpm typecheck
git diff --check origin/dev-v2...HEAD
git status --short
```

Expected: PASS with no TypeScript or whitespace errors and an empty status.

- [ ] **Step 4: Run the mandatory end-to-end suite**

Run: `make e2e`

Expected: PASS. Capture and inspect the complete output; do not infer success from truncated logs.

- [ ] **Step 5: Request code review and address findings**

Review the complete diff against `origin/dev-v2`, the design amendment, and this plan. Fix any correctness, race, protocol, or test-coverage findings, commit the fixes, then repeat the affected focused tests, package tests, typecheck, diff/status checks, and mandatory end-to-end suite.

- [ ] **Step 6: Push and open the pull request**

Push `fix/runtime-model-picker`, then open a PR targeting `dev-v2` using `.github/PULL_REQUEST_TEMPLATE.md`. Keep the body under 300 words, explain that runtime display is separate from persisted selection, and list the exact validation commands and outcomes.
