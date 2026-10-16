# Event Claims Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per owner, one event reaches one assistant thread once, across subscriptions and event waiters, for every service.

**Architecture:** Ingest evaluates waiter candidates and matched assistant subscriptions together, resolves each delivery's destination with the claim as input, stamps it on the delivery row, and appends or suppresses each waiter's digest from the same decision. The dispatcher executes the stamp. The Slack mention rule and the #934 `watchingTarget` are deleted; a plugin `conversationalTwin` hook covers Slack's two-event mentions.

**Tech Stack:** TypeScript, Hono api, `@valet/engine` plugin types, Drizzle + in-place `0000_app.sql`, vitest.

**Spec:** `docs/specs/2026-10-16-delivery-threads-and-claims-design.md`, Part C, Part D (`conversationalTwin`), Part E reasons `claim_redirect` and `claim_skip`.

## Global Constraints

- Branch `feat/event-claims`, stacked on `feat/delivery-threads`; PR base `feat/delivery-threads`.
- CLAUDE.md rules as in the thread policy plan.
- Interfaces from the thread policy plan: `resolveDestination`, `Destination`, `DestinationInput.claim`, `isDeliverableTarget`, `mentionSenderActor`.
- Failure mode is duplication, never loss (INV-D6): an unstamped delivery resolves from binding and policy only.
- Workflow and `signal` targets never yield (INV-D7).

## Review Focus

1. The `slack.app_mention` event arrives before its `slack.message` twin: the mention must still redirect to the waiter's thread and the later message must append no digest (Task 3 test, both orders).
2. Two waiters of one owner in two threads, one on the channel subject and one on the Slack thread subject, and a mention in that Slack thread: the thread-subject waiter is the redirect target and the channel waiter appends its digest (Task 3 test).
3. A once-mode waiter is the redirect target: the thread receives the inbound message and exactly one `event.ended` signal (Task 3 test).
4. The claim resolver throws for one owner: that owner's delivery is unstamped and lands by policy, the waiter appends, and the receipt records the failure (Task 3 test for INV-D6).
5. A waiter whose thread is archived between ingest and dispatch: the stamped redirect dead-letters with the existing explicit-target text, and the receipt shows it (Task 4 test).

---

### Task 1: Plugin `conversationalTwin`

**Files:**
- Modify: `packages/engine/src/valet-plugin.ts` (beside `naturalSubject`: `conversationalTwin?(event: NormalizedEvent, identity: { botUserId?: string }): NormalizedEvent | null;` and validation), `packages/plugin-slack/src/subjects.ts` (or a new `twins.ts`), `packages/plugin-slack/src/plugin.ts`.
- Test: `packages/plugin-slack/src/twins.test.ts`.

- [ ] Failing tests: a `slack.message` whose text contains `<@U-BOT>` returns a `slack.app_mention` twin with the same channel, ts, user, text, subjects, and dedupe key suffix `:mention`; a message without the mention returns null; an `app_mention` returns its `slack.message` twin; a non-Slack key returns null.
- [ ] Implement; `pnpm --filter @valet/plugin-slack test twins`, `pnpm --filter @valet/engine test valet-plugin`.
- [ ] Commit `feat(plugin-slack): pair a mention with its message twin` with `Changelog: none`.

### Task 2: The delivery stamp column

**Files:**
- Modify: `packages/api/migrations/pg/0000_app.sql:1169` (`"destination" jsonb` on `event_deliveries`), `packages/api/src/schema/index.ts:2091` (`destination: jsonb("destination")`), `packages/api/src/lib/drizzle.ts:399` (`SCHEMA_REPAIRS` entry `event_deliveries.destination column`).
- Test: `packages/api/src/lib/drizzle.test.ts` (the repair applies to a database without the column).

- [ ] Failing test, implement, `pnpm --filter @valet/api test drizzle`, `make dev-clean` note in the commit body.
- [ ] Commit `feat(api): stamp each delivery's destination` with `Changelog: none`.

### Task 3: Claims at ingest

**Files:**
- Create: `packages/api/src/events/claims.ts`, `packages/api/src/events/claims.test.ts`.
- Modify: `packages/api/src/events/waiters.ts` (split `matchEventWaiters` into `evaluateWaiterCandidates(deps, orgId, service, event): Promise<WaiterCandidate[]>`, which returns `{ waiter, session, digests, accepted }` without appending, and `appendWaiterDigests(deps, candidates, decisions)`; delete `appMentionCoveredBy`, `mentionRuleSkips`, and the `appMentionCovered` dep), `packages/api/src/events/ingest.ts:275-350` (evaluate candidates, resolve claims per matched assistant subscription, stamp the delivery rows at insert, append digests per decision; error boundary per INV-D6), `packages/api/src/events/ingest.test.ts`, `packages/api/src/events/waiters.test.ts`.

**Interfaces (produces):**
```ts
export interface ClaimDecision {
  deliveries: Map<string /* subscriptionId */, Destination>;
  waiters: Map<string /* waiterId */, "append" | "suppress">;
  /** For a once waiter that is a redirect target: end it as matched after delivery. */
  endAsMatched: Set<string>;
}
export async function resolveClaims(deps: ClaimDeps, args: {
  orgId: string; event: NormalizedEvent; service: string;
  matched: MentionRuleSubscription[]; candidates: WaiterCandidate[];
  binding: (owner, event) => Promise<DestinationInput["binding"]>;
  conversational: (owner, event) => boolean;
}): Promise<ClaimDecision>;
```
Rules: per owner O of each matched assistant subscription, candidates are O's accepted waiters whose thread passes `isDeliverableTarget`. Ambient → every candidate `append`; destination `skip` with `claim:<threadId>` of the newest. Conversational → target the candidate with the longest matching subject, newest on tie; that one `suppress`, others `append`. Binding present → target the binding; a candidate in that thread `suppress`. Slack: at a `slack.message` ingest, if `conversationalTwin` yields an `app_mention` and an orchestrator subscription of O matches it with `mentionSenderActor` non-null, O's candidates `suppress`; at an `app_mention` ingest, evaluate candidates against the `slack.message` twin.

- [ ] Failing tests from Scenario C steps C1 to C6, C8 to C12 as unit vectors over `resolveClaims` with fakes, plus the Review Focus items 1 to 4.
- [ ] Implement. `pnpm --filter @valet/api test claims waiters ingest`.
- [ ] Commit `feat(api): claim events for the thread that waits on them` with a Changelog line: `An event a thread is waiting on reaches that thread once, for GitHub and Linear as well as Slack.`

### Task 4: The dispatcher executes the stamp

**Files:**
- Modify: `packages/api/src/events/dispatcher.ts` (read `delivery.destination`; execute `skip`, `target`, or `key`; unstamped → `resolveDestination` with `claim: null`; delete `watchingTarget` and its imports), `packages/api/src/events/assistant-delivery.ts` (a stamped `target` that fails `isDeliverableTarget` dead-letters with the existing text), `packages/api/src/engine/wake-watcher.ts` (end a waiter in `endAsMatched` after the delivery with one terminal signal), `packages/api/src/observability/delivery-metrics.ts` (reasons `claim_redirect`, `claim_skip`), `packages/web/src/components/events/delivery-list.tsx` (+ test: a row reads the `destination` stamp and shows `Delivered to <thread>`, `Claimed by <thread>`, or the dead-letter text; spec Part E step 2).
- Delete: `packages/api/src/events/watching-waiter.ts`, `watching-waiter.test.ts`. Keep `isDeliverableTarget` and `mentionSenderActor`.
- Test: `dispatcher.test.ts` (rewrite the #934 cases as stamp-execution cases), `wake-watcher.test.ts`.

- [ ] Failing tests: a `skip` stamp marks the row `skipped` with the reason and submits nothing; a `target` stamp delivers with the explicit target and binds the follow; an unstamped row lands by policy; Review Focus 5.
- [ ] Implement; `pnpm --filter @valet/api test dispatcher wake-watcher assistant-delivery`, `pnpm typecheck`.
- [ ] Commit `refactor(api): execute stamped destinations in the dispatcher` with `Changelog: none`.

### Task 5: Scenario C, spec errata, validation

**Files:**
- Modify: `packages/api/src/integration/event-wakeups.test.ts` (Scenario E stays; its M1 to M6 incident steps become Scenario C steps C2 to C7 in a new file), create `packages/api/src/integration/event-claims.test.ts` (C1 to C12), `scripts/e2e/lib.ts` (`INTEGRATION_CORE_FILES`), `docs/specs/2026-10-15-event-wakeups-design.md` (Part E: replace the mention rule paragraph with a pointer to the claims spec Part C; reword INV-E2; E5 note), delete `docs/specs/2026-10-15-incident-mention-routing-design.md`, the claims spec Deviations.

- [ ] Write C1 to C12 as one test file with the Scenario C universe (reuse the Scenario E fixtures).
- [ ] `pnpm --filter @valet/api test event-claims event-wakeups`, `python3 scripts/docs/docs_lint.py`, `make e2e 2>&1 | tee /tmp/e2e-claims.log`.
- [ ] Commit `test(api): run the claims acceptance scenario` and `docs: fold the mention rule into the claims spec`, both `Changelog: none`.
