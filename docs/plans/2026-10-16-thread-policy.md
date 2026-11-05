# Thread Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every assistant-waking rule (event subscription with an assistant target, schedule with a prompt) names where its deliveries land, and the hard-coded events thread and per-channel thread are gone.

**Architecture:** A shared `AssistantThreadPolicy` type is stored on the subscription target JSON and a new schedule column. A pure `resolveDestination` turns (binding, claim, policy) into a thread key with a title, an explicit target, or a skip. The dispatcher and the scheduler call it and hand the result to `deliverToOrchestrator`. The web wizard and edit dialogs gain a "Runs in" control.

**Tech Stack:** TypeScript, Hono api, `@valet/shared`, `@valet/engine` (thread creation), Drizzle + in-place `0000_app.sql`, React 19 web, vitest.

**Spec:** `docs/specs/2026-10-16-delivery-threads-and-claims-design.md`, Parts A, B, D (`naturalSubject` only), E. Part C (claims) is the next plan; this plan keeps the #934 Slack mention routing (`watchingTarget`) as the only claim source.

## Global Constraints

- Branch `feat/delivery-threads`, stacked on `feat/event-wakeups` (PR #932); PR base `feat/event-wakeups`.
- CLAUDE.md: no `any`, no `as unknown as T`, minimal `as` with a comment; ASD-STE100 prose and no em dashes; every user-facing error names its fix; commit subjects ≤72 chars with a `Changelog:` trailer on feat/fix; in-place migration edits need a `SCHEMA_REPAIRS` entry.
- Absent policy reads as `{ mode: "own" }` (spec Part A step 3). No backfill.
- Error texts, verbatim: `This rule's events have no subject to group by. Pick another thread option.`; `This thread belongs to another owner. Pick a thread in your workspace.`; `This thread is archived. Pick an open thread.`; `Pick another thread for this rule in Presence.`
- Keys and titles exactly as spec Part B step 2. `subject` keys carry no rule id.
- A skip or dead-letter creates no thread (INV-D3). Thread creation happens at delivery, never at resolution.

## Review Focus

1. A delivery retried after the first attempt created the `new` thread: the retry must land in that thread, never a second one (Task 5 test "retry reuses the delivery's thread").
2. An `existing` pin on a thread of a team execution session, delivered by a personal rule: write-time refusal with the cross-owner text (Task 2 test).
3. A Slack channel whose name is unknown at delivery: the `subject` title falls back to the channel id and never throws (Task 3 test).
4. Two rules of one owner with `subject` on the same repository: PR #12 lands in one thread (Task 5 test "subject threads are per owner").
5. A schedule whose prompt fires while its `own` thread is archived: the thread reopens and holds the prompt; the archived flag is cleared (Task 5 test).

---

### Task 1: Shared policy type and validation

**Files:**
- Create: `packages/shared/src/thread-policy.ts`, `packages/shared/src/thread-policy.test.ts`
- Modify: `packages/shared/src/index.ts` (export)

**Interfaces (produces):**
```ts
export type AssistantThreadPolicy =
  | { mode: "new" } | { mode: "subject" } | { mode: "own" }
  | { mode: "existing"; sessionId: string; threadId: string };
export const DEFAULT_THREAD_POLICY: AssistantThreadPolicy = { mode: "own" };
/** Shape check only. Returns null when valid, else the corrective text. */
export function validateThreadPolicy(value: unknown): string | null;
/** `value ?? DEFAULT_THREAD_POLICY`, after validation. */
export function readThreadPolicy(value: unknown): AssistantThreadPolicy;
```

- [ ] Failing tests: each mode validates; unknown mode → `Thread policy mode must be new, subject, own, or existing.`; `existing` without ids → `An existing thread needs sessionId and threadId.`; `readThreadPolicy(undefined)` is `own`.
- [ ] Implement; `pnpm --filter @valet/shared test thread-policy`.
- [ ] Commit `feat(shared): add the assistant thread policy type` with `Changelog: none`.

### Task 2: Storage, wire, and write validation

**Files:**
- Modify: `packages/api/src/wire/types.ts` (`EventSubscriptionTargetWire` assistant variant (stored kind `orchestrator`) gains `thread?: AssistantThreadPolicy`; `WorkflowScheduleWire` and `CreateWorkflowScheduleRequest` gain `thread?`; `WorkflowTriggerItem` schedule `detail` gains `thread`), `packages/api/migrations/pg/0000_app.sql:1131` (`"thread_policy" jsonb` on `workflow_schedules`), `packages/api/src/schema/index.ts:2031` (`threadPolicy: jsonb("thread_policy")`), `packages/api/src/lib/drizzle.ts:399` (`SCHEMA_REPAIRS` entry `workflow_schedules.thread_policy column`, `ALTER TABLE "workflow_schedules" ADD COLUMN IF NOT EXISTS "thread_policy" jsonb`), `packages/api/src/events/subscription-write.ts:36` (`validateSubscription`), `packages/api/src/routes/events.ts:845` (patch accepts `thread`), `packages/api/src/routes/workflow-triggers.ts:144,203` (schedules create and patch accept `thread`), `packages/api/src/workflows/schedule-service.ts` (read and write the column).
- Create: `packages/api/src/events/thread-policy-write.ts` with `validateExistingThread(db, orgId, owner, target): Promise<string | null>` (uses `isDeliverableTarget` from `assistant-delivery.ts`; returns the cross-owner or archived text) and `subjectModeAllowed(eventKeys, plugins): boolean` (true when any key's plugin declares `naturalSubject`; Task 3 adds the hook, so this task stubs it on `ValetPlugin.naturalSubject !== undefined`).
- Test: `subscription-write.test.ts`, `routes/events.test.ts`, `routes/workflow-triggers.test.ts`.

- [ ] Failing tests: subscription create with `thread: { mode: "existing", ... }` of another owner → 400 with the cross-owner text; archived thread → the archived text; `subject` on a schedule → `This rule's events have no subject to group by. Pick another thread option.`; a patch that sets `thread: null` clears it and reads back absent; schedule create stores and lists `thread`.
- [ ] Implement. Run `pnpm --filter @valet/api test subscription-write events.test workflow-triggers`, `pnpm typecheck`.
- [ ] Commit `feat(api): store a thread policy on rules` with a Changelog line: `Rules can choose where their deliveries land: a new thread, one per subject, the rule's thread, or an existing thread.`

### Task 3: Plugin `naturalSubject`

**Files:**
- Modify: `packages/engine/src/valet-plugin.ts:673` (beside `derivedEvents`: `naturalSubject?(event: NormalizedEvent): { subject: string; label: string } | null;` and `validateValetPlugin` accepts a function), `packages/plugin-slack/src/subjects.ts`, `packages/plugin-github/src/subjects.ts`, `packages/plugin-linear/src/subjects.ts`, each plugin's `plugin.ts` manifest.
- Test: each plugin's `subjects.test.ts`.

**Interfaces (produces):** `naturalSubject` per spec Part D table. Slack label is `#<name>` from the payload's `channel_name` when present, else the channel id. GitHub: `acme/api#12` for a pull request or issue, `acme/api` otherwise. Linear: `ENG-42` for an issue, `ENG` for a team.

- [ ] Failing tests per plugin: one event with the fine subject, one with only the coarse subject, one with no subject (returns null); Slack with no channel name returns the id label.
- [ ] Implement; `pnpm --filter @valet/plugin-slack --filter @valet/plugin-github --filter @valet/plugin-linear test`, `pnpm --filter @valet/engine test valet-plugin`.
- [ ] Commit `feat(plugins): name each event's natural subject` with `Changelog: none`.

### Task 4: The pure resolver

**Files:**
- Create: `packages/api/src/events/destination.ts`, `packages/api/src/events/destination.vectors.json`, `packages/api/src/events/destination.test.ts`.

**Interfaces (produces):**
```ts
export type Destination =
  | { kind: "target"; sessionId: string; threadId: string; reason: DestinationReason }
  | { kind: "key"; key: string; title: string; reason: DestinationReason }
  | { kind: "skip"; reason: `claim:${string}` };
export type DestinationReason =
  | "policy_new" | "policy_subject" | "policy_own" | "policy_existing"
  | "conversation_follow" | "conversation_pull_request" | "claim_redirect";
export interface DestinationInput {
  rule: { id: string; kind: "subscription" | "schedule"; name: string; policy: AssistantThreadPolicy };
  event?: { deliveryId: string; summary: string; naturalSubject: { subject: string; label: string } | null; conversational: boolean };
  fireAt?: number;
  binding: { sessionId: string; threadId: string; via: "follow" | "pull_request" } | null;
  claim: { sessionId: string; threadId: string; waiterId: string } | null;
}
export function resolveDestination(input: DestinationInput): Destination;
export function summaryTitle(summary: string): string; // ≤ 80 chars
```

- [ ] Write the vectors file first: one row per precedence branch (binding wins over claim and policy; claim ambient → skip; claim conversational → target), one per policy mode for a subscription and for a schedule, `subject` with a null natural subject → falls to `own` with reason `policy_own` and a `note` field the test asserts is logged. Each row: `{ name, input, expected }`.
- [ ] One test loads the file and asserts every row. Implement until green. No I/O in this file.
- [ ] Commit `feat(api): resolve an assistant delivery's destination` with `Changelog: none`.

### Task 5: Delivery plumbing

**Files:**
- Modify: `packages/engine/src/session.ts:214` (`ThreadInitialSettings.title?: string` → `metadata.title` in `buildThreadData`), `packages/api/src/engine/host.ts` (`ensureFreshThread(session, key, meta, actorUserId, init?: { title?: string })`; new `reopenThread(session, thread)` that clears `archivedAt` through the store), `packages/api/src/events/orchestrator-target.ts` → rename to `assistant-target.ts` (remove `EVENTS_THREAD_KEY` and `threadKeyForSignal`; `OrchestratorDeliverFn` becomes `AssistantDeliverFn` and takes `destination: Destination` in place of `threadKey`/`target`; `deliverToOrchestrator` becomes `deliverToAssistant` at every call site), `packages/api/src/events/assistant-delivery.ts` (`AssistantDeliveryArgs.destination`; a `key` destination resolves with `ensureFreshThread(..., { title })` and reopens an archived thread; a `target` destination keeps the explicit-target path; an `existing` target that fails `isDeliverableTarget` throws `Pick another thread for this rule in Presence.`), `packages/api/src/events/dispatcher.ts:300-460` (compute `binding` from the existing follow lookup and `threadForPullRequest`; compute `claim` from the existing `watchingTarget`; call `resolveDestination`; on `skip` mark the delivery `skipped` with the reason; stop using `slackEventsThreadKey` as a destination), `packages/api/src/workflows/scheduler.ts:100-112` (resolve with `fireAt` and pass `destination`), `packages/api/src/events/receipts.ts` (stage `destination`), a new `packages/api/src/observability/delivery-metrics.ts` (`valet_event_delivery_destination_total{reason}` plus `pin_unavailable`, same lazy-meter shape as `sandbox-token-metrics.ts`).
- Test: `assistant-delivery.test.ts`, `dispatcher.test.ts`, `scheduler.test.ts`, `assistant-target.test.ts`, `delivery-metrics.test.ts`.

- [ ] Failing tests: `own` creates a thread titled by the rule name and reuses it; `new` keys on the delivery id and a retry reuses the thread; `subject` threads are per owner (two rules, one thread); an archived `own` thread reopens; an `existing` pin whose thread is archived dead-letters with the text and creates no thread; a `skip` creates no thread and marks the delivery `skipped`; the scheduler lands two firings in `schedule:<id>`; the receipt stage and the counter record the reason.
- [ ] Implement. Delete `EVENTS_THREAD_KEY` and every reference. Keep `slackEventsThreadKey` for its attention-audience callers (`run-attention.ts`, `attention-wiring.ts`, `engine-deps.ts`, `providers/node.ts`).
- [ ] Run `pnpm --filter @valet/api test assistant-delivery dispatcher scheduler assistant-target delivery-metrics`, `pnpm --filter @valet/engine test session`, `pnpm typecheck`.
- [ ] Commit `feat(api): deliver by thread policy instead of the events thread` with a Changelog line: `Assistant deliveries land by each rule's thread policy; the shared events thread is no longer used.`

### Task 6: Web "Runs in"

**Files:**
- Create: `packages/web/src/components/presence/runs-in-field.tsx` (+ test), `packages/web/src/components/presence/thread-picker.tsx` (+ test; searchable list from `api.listThreads(assistantSessionId)` via `useWorkspaceAssistant()`, open threads only, newest first, title and last activity), `packages/web/src/components/presence/thread-policy-copy.ts` (+ test; `runsInLabel(policy, subjectKind, ruleKind: "listener" | "routine")` → `A new thread each time` / `One thread per <kind>` / `This listener's thread` or `This routine's thread` / `The thread <title>`).
- Modify: `packages/web/src/components/events/automation-wizard.tsx` (assistant step renders `RunsInField`; defaults: mention flow → `new`; notification or event→workflow with a natural subject → `subject`; else `own`), `packages/web/src/components/events/edit-subscription-dialog.tsx` (editable `thread`), `packages/web/src/components/events/subscription-patch.ts` (maps `thread`), `packages/web/src/components/workflows/trigger-dialog.tsx` (schedules: `new`, `own`, `existing`), `packages/web/src/api/events.ts` and `workflows.ts` (pass `thread`).

- [ ] Failing component tests: the field renders the four options and hides `subject` when `subjectKind` is null; the wizard default per flow; the picker filters by title and emits `{ mode: "existing", sessionId, threadId }`; the edit dialog submits a changed policy.
- [ ] Implement; `pnpm --filter @valet/web test runs-in thread-picker thread-policy-copy automation-wizard edit-subscription-dialog trigger-dialog`.
- [ ] Commit `feat(web): choose where a rule's deliveries land` with a Changelog line: `The automation wizard and the edit dialog offer Runs in: a new thread, one per subject, the rule's thread, or an existing thread.`

### Task 7: Scenario T, spec errata, validation

**Files:**
- Create: `packages/api/src/integration/delivery-threads.test.ts` (steps T1 to T11, with the Scenario T universe).
- Modify: `scripts/e2e/lib.ts` (`INTEGRATION_CORE_FILES` gains the file), `docs/specs/2026-07-20-event-system-design.md` (Dispatcher section: the thread heuristics paragraph points to the new spec Part B), `docs/specs/2026-08-15-workflow-triggers-ui-design.md` (assistant-prompt schedules carry a thread policy), the new spec's Deviations (anything the implementation changed; at least: `slackEventsThreadKey` stays for attention audience keys).

- [ ] Write the eleven steps as one test file, each step asserting the thread key, title, and delivery row named in the spec table.
- [ ] `pnpm --filter @valet/api test delivery-threads`, `pnpm vitest run scripts/e2e/lib.test.ts`, `python3 scripts/docs/docs_lint.py`, then `make e2e 2>&1 | tee /tmp/e2e-thread-policy.log`.
- [ ] Commit `test(api): run the thread policy acceptance scenario` and `docs: record thread policy deviations`, both `Changelog: none`.
