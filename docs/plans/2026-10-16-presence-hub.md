# Presence Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One nav entry, Presence, replaces Events and Automation, with places, listeners, routines, activity, workflows, and runs rendered in one vocabulary.

**Architecture:** New `/presence*` routes and a `components/presence/` tree reuse the existing wizard, edit dialog, event log, receipts, workflow, and run components. One sentence renderer per object kind. A `GET /api/presence/places` endpoint aggregates subjects. Old routes become redirects. The `presence` target field is renamed `appearance` with an accept-both window.

**Tech Stack:** React 19, TanStack Router and Query, Tailwind, Radix; Hono api; vitest; the full-stack e2e harness.

**Spec:** `docs/specs/2026-10-16-presence-hub-design.md`.

## Global Constraints

- Branch `feat/presence-hub`, stacked on `feat/event-claims`; PR base `feat/event-claims`.
- CLAUDE.md rules; reuse primitives from `src/components/primitives/` and delete the code a change replaces.
- UI copy uses only the spec's Terminology table (INV-H2). Banned in `components/presence/**` and the presence routes: `subscription`, `trigger`, `subject`, `event waiter`, `automation`.
- Parity only (INV-H3): no feature beyond the rows, the place page, Runs in, and the acceptance steps.
- Every old URL redirects with its search params (INV-H1).

## Review Focus

1. `/events?tab=receipts&status=problems` redirects to Activity with the legacy status mapped as `events.index.tsx` maps it today (Task 3 test).
2. A listener whose filters name two channels renders under "Everywhere in Slack" and not twice under each channel (Task 5 test).
3. A team workspace's thread picker lists only the team execution session's open threads (Task 1 of the thread policy plan built the picker; Task 5 test for the scope).
4. A delivery row stamped `skip` with `claim:<threadId>` where the thread was later archived: the Activity sentence still renders `claimed by <thread>` with a disabled link (Task 7 test).
5. A write that carries both `presence` and `appearance` is refused with `Send appearance, not presence.` (Task 1 test).

---

### Task 1: Rename `presence` to `appearance` and `orchestrator` to `assistant`

**Files:**
- Modify: `packages/shared/src/presence.ts` → `appearance.ts` (`Appearance`, `validateAppearance`, constants; keep a deprecated `Presence` alias for one release), `packages/api/src/wire/types.ts` (`appearance?: Appearance` on both target variants and on schedules), `packages/api/src/routes/events.ts:845` and `packages/api/src/routes/workflow-triggers.ts` (accept both on write, emit `appearance`, refuse both with `Send appearance, not presence.`), `packages/api/src/events/subscription-write.ts`, the dispatcher's read of the stored field (read both names), every web file that imports `Presence` (about 32 files; `components/presence-settings.tsx` becomes `components/presence/appearance-settings.tsx` with the label **Appears as**).
- Also: the target discriminator `kind: "orchestrator"` → `"assistant"`, the wire field `orchestrator` → `assistant`, the schedule `target_kind` value, each with accept-both on write and `assistant` on read (spec Part H steps 5 and 6); the web `TargetChoice` and `describeTarget`.
- Test: route tests for accept-both and the refusal, for both renames; a stored-row read test with each old value.

- [ ] Failing tests, implement, `pnpm typecheck`, `pnpm --filter @valet/api test events.test workflow-triggers subscription-write`, `pnpm --filter @valet/web test appearance`.
- [ ] Commit `refactor: rename the reply identity from presence to appearance` with a Changelog line: `The reply identity on a rule is now called Appears as, and rules target the assistant.`

### Task 2: Places and feeders API

**Files:**
- Create: `packages/api/src/routes/presence.ts`, `packages/api/src/services/presence-places.ts` (+ test).
- Modify: `packages/api/src/app.ts` (mount), `packages/api/src/wire/types.ts` (`PresencePlaceWire`, `ListPresencePlacesResponse`, `ListThreadFeedersResponse`).

**Interfaces (produces):**
```ts
export interface PresencePlaceWire {
  subject: string; label: string; service: "slack" | "github" | "linear";
  parent: string | null; listenerCount: number; activeThreadCount: number; lastActivityAt: number | null;
}
// GET /api/presence/places?scope=<workspace>  -> { places: PresencePlaceWire[] }
// GET /api/presence/places/:subject            -> { place, listeners, threads: { subject, following, active }, activity }
// GET /api/presence/feeders?sessionId&threadId -> { listeners: [{ id, name }], routines: [{ id, name }] }
```
Sources per spec Part B step 1. A listener with no single place maps to its parent subject.

- [ ] Failing tests: grouping, parent mapping, counts, the 30-day activity window, workspace scoping, feeders for `own`, `existing`, and `subject` threads.
- [ ] Implement; `pnpm --filter @valet/api test presence-places presence`.
- [ ] Commit `feat(api): list the places Valet is present in` with `Changelog: none`.

### Task 3: Routes, nav, redirects

**Files:**
- Create: `packages/web/src/routes/presence.tsx` (layout with `TabBar`), `presence.index.tsx` (Places), `presence.places.$subject.tsx`, `presence.listeners.$id.tsx`, `presence.routines.tsx`, `presence.activity.tsx`, `presence.events.$eventId.tsx`, `presence.workflows.tsx`, `presence.workflows.index.tsx`, `presence.workflows.$workflowId.tsx`, `presence.runs.tsx`, `presence.runs.$runId.tsx`, `packages/web/src/routes/-presence-redirects.ts` (the table) and its test.
- Modify: `events.tsx`, `events.index.tsx`, `events.$eventId.tsx`, `workflows.tsx`, `workflows.index.tsx`, `workflows.$workflowId.tsx`, `workflows.runs.$runId.tsx`, `channel.tsx` (each becomes `beforeLoad: () => { throw redirect(...) }` using the table), `components/layout/top-nav.tsx:191-198` (one entry, `Presence`, subtitle per spec).

- [ ] Failing tests: one per redirect row, including every legacy `tab` value and `channel?key=`.
- [ ] Implement with page shells; `pnpm --filter @valet/web test presence-redirects top-nav`.
- [ ] Commit `feat(web): add the Presence hub routes and redirects` with a Changelog line: `Events and Automation merge into one Presence section; old links redirect.`

### Task 4: Sentence renderers

**Files:**
- Create: `packages/web/src/components/presence/sentences.ts` (+ test): `listenerSentence(sub, catalog, workflows, threads)`, `routineSentence(schedule, workflows, threads)`, `activitySentence(event, delivery)`, `runsInLabel` (moved from `thread-policy-copy.ts` in the thread policy plan; delete the old file).

- [ ] Failing tests: one per `<does>` row in spec Part C step 1 and Part D step 1, every Activity outcome in Part E step 1, `in` vs `on` by service.
- [ ] Implement; `pnpm --filter @valet/web test sentences`.
- [ ] Commit `feat(web): render listeners, routines, and activity as sentences` with `Changelog: none`.

### Task 5: Places tab and place page

**Files:**
- Create: `components/presence/places-tab.tsx`, `place-page.tsx`, `place-threads.tsx`, `all-listeners-table.tsx` (+ tests).
- Modify: `routes/presence.index.tsx`, `routes/presence.places.$subject.tsx`; `components/events/automation-wizard.tsx` accepts `preselectedPlace` and `preselectedWorkflowId`.
- Delete: `components/channels/channels-panel.tsx` and the `channel.tsx` page body it replaces.

- [ ] Failing tests: grouping by service, parent rows, counts, the five page sections in order, **Add** opens the wizard with the place preselected, the **All listeners** toggle, Review Focus 2 and 3.
- [ ] Implement; `pnpm --filter @valet/web test places-tab place-page all-listeners`.
- [ ] Commit `feat(web): show the places Valet is present in` with `Changelog: none`.

### Task 6: Listener page and Routines tab

**Files:**
- Create: `components/presence/listener-page.tsx`, `routines-tab.tsx`, `routine-page.tsx`, `problem-badge.tsx` (+ tests).
- Modify: `routes/presence.listeners.$id.tsx`, `routes/presence.routines.tsx`; `components/events/delivery-list.tsx` (rows read the `destination` stamp: `Delivered to <thread>`, `Claimed by <thread>`, dead-letter text).
- Delete: `components/events/subscriptions-panel.tsx`, `components/workflows/trigger-list.tsx` after the triggers panel moves (Task 8).

- [ ] Failing tests: sentence, enable or disable, edit with Runs in, Appears as, delivery rows per reason, the archived-pin badge and inline picker, the paused copy `Paused: a team listener covers the same events.`, routine fire now.
- [ ] Implement; `pnpm --filter @valet/web test listener-page routines-tab delivery-list`.
- [ ] Commit `feat(web): listener and routine pages` with `Changelog: none`.

### Task 7: Activity tab

**Files:**
- Create: `components/presence/activity-tab.tsx` (+ test) wrapping `components/events/event-log.tsx` rows with `activitySentence`.
- Modify: `routes/presence.activity.tsx`, `routes/presence.events.$eventId.tsx` (move the event page body).

- [ ] Failing tests: each outcome sentence, receipt disclosure, the event page's payload and redeliver, Review Focus 4.
- [ ] Implement; `pnpm --filter @valet/web test activity-tab`.
- [ ] Commit `feat(web): show activity as sentences` with `Changelog: none`.

### Task 8: Workflows and Runs tabs

**Files:**
- Modify: `routes/presence.workflows*.tsx`, `routes/presence.runs*.tsx` (mount the existing workflow and run components), `components/workflows/triggers-drawer.tsx` (render listeners and routines with the sentence renderers; **Add** opens the wizard with the workflow preselected).
- Delete: the Triggers and Templates tab code in the old `workflows.index.tsx` after the move (Templates content moves under Workflows).

- [ ] Failing tests: the tabs render the moved content; the editor panel sentences.
- [ ] Implement; `pnpm --filter @valet/web test presence.workflows presence.runs triggers-drawer`.
- [ ] Commit `feat(web): move workflows and runs under Presence` with `Changelog: none`.

### Task 9: Thread card and subject headers

**Files:**
- Modify: `components/session/background-work.tsx` (+ test): `Fed by: <links>` from `GET /api/presence/feeders`; `components/session/session-header.tsx`: a subject thread names its place.

- [ ] Failing tests: feeders render under the waiting entry; a non-fed thread shows nothing new; a subject thread header shows the place label.
- [ ] Implement; `pnpm --filter @valet/web test background-work session-header.
- [ ] Commit `feat(web): show what feeds a thread` with `Changelog: none`.

### Task 10: Copy lint, acceptance, validation

**Files:**
- Create: `packages/web/src/components/presence/copy-lint.test.ts` (greps the presence tree and routes for the banned words outside code identifiers), `scripts/e2e/presence-hub.ts` (steps H1 to H12 over the full stack through the existing `fullstack-scenario.ts` harness and the browser runtime).
- Modify: `scripts/e2e/lib.ts` (a `presence-hub` row in the fullstack group), the hub spec's Deviations.

- [ ] Write the lint test and the scenario; run `make e2e E2E_ARGS="--only presence-hub"` until green.
- [ ] `pnpm typecheck`, `python3 scripts/docs/docs_lint.py`, `make e2e 2>&1 | tee /tmp/e2e-presence.log`.
- [ ] Commit `test(web): lint Presence copy and run the hub scenario` and `docs: record Presence hub deviations`, both `Changelog: none`.
