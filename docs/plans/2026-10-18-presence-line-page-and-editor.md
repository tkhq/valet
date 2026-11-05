# Presence Line Page and Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement spec revision 4: a line's page that answers what it is, whether it works, what it did and skipped, and how it works; and one full-height editor that creates and edits lines and routines, replacing the wizard and the edit dialog.

**Architecture:** One new api read, `GET /api/event-subscriptions/:id/activity`, merges a line's deliveries (acted) with the receipt decisions that skipped it (skipped), gated per entry by place visibility, and returns the health counts. The web page is rebuilt from the mockup's frame 6 with the existing `Sentence`, `Ref`, `ServiceMark`, `ThreadProblem`, and gating helpers. The editor is a new `LineEditor` sheet built from the wizard's extracted steps (`WhenDoStep`, `ScheduleMatchStep`, the event picker, the filter editor, `RunsInField`, appearance fields) rearranged as sections, with the side pane fed by `wizardDraft`/`presenceSentenceParts`. `AutomationWizard`, `EditSubscriptionDialog`, and `TriggerDialog` are deleted once every launch point opens the editor.

**Tech Stack:** Hono api, React 19, TanStack Router and Query, Tailwind, Radix Dialog, vitest.

**Spec:** `docs/specs/2026-10-16-presence-hub-design.md` revision 4 (Part D, Part E step 2, Part F step 2, Part H, Terminology, acceptance P5 to P7, P13, P16, P18, P19, INV-H8). Visual target: the mockup `presence-roster.html` frames 6 (line page) and 7 (editor).

## Global Constraints

- Branch `feat/presence-hub`, PR #953, base `feat/event-claims`.
- CLAUDE.md rules: ASD-STE100 copy, every error names its fix, `Changelog:` trailer per commit, subjects ≤72 chars, no `any`, no `as unknown as`, `useState` from props paired with a sync effect, no index keys, alert-don't-auto-repair.
- UI copy bans listener, automation, subscription, trigger, subject, rule, event waiter, delivery, receipt, `Runs in`. The copy lint's banned list grows by the last three.
- Stage only your own files; never `git add -A`. If `.git/index.lock` exists, wait two seconds and retry.
- The dev stack runs from this worktree; do not restart it.
- Headless screenshots: copy `/private/tmp/claude-501/-Users-conner-code-valet/cd16fba6-0180-4f19-84aa-017df7f94649/scratchpad/shoot.mjs` into `packages/browser-runtime/` as `.shoot-tmp.mjs`, run `node .shoot-tmp.mjs <outdir> <url>` there, delete the copy.

## Review Focus

1. A member (not an admin) opens a line that names `acme/api`: skipped entries for events on `acme/web` do not appear, while skipped entries for `acme/api` events do (Task 1 api test, Task 2 page test).
2. A line that never acted: the health strip reads `never` for last acted and `0` for the count, the pulse renders 30 empty bars, and no error (Task 2 test).
3. Editing a line's **Where** from `Its own thread` to `The Platform CI thread` and saving keeps the line's name, events, and conditions unchanged in the PATCH body (Task 3 test compares the body with the original line).
4. Opening the editor from `+ Listen for…` on `#incidents`, then switching the service to GitHub, drops the `#incidents` condition and re-adds nothing silently; the side pane sentence has no place until a condition names one (Task 3 test).
5. Esc with unsaved changes asks `Discard your changes?`; Esc with none closes at once (Task 3 test).

---

### Task 1: The line activity api

**Files:**
- Create: `packages/api/src/services/line-activity.ts` (+ test).
- Modify: `packages/api/src/routes/events.ts` (mount `GET /api/event-subscriptions/:id/activity`), `packages/api/src/wire/types.ts`, `packages/api/src/services/event-log.ts` (reuse `placeOfSubject`/`placeCovers` and the delivery outcome mapping), the receipts store read (grep the receipts service for `subscriptions` decisions).

**Interfaces (produces):**
```ts
export interface LineActivityEntryWire {
  id: string;                      // delivery id, or `receipt:<receiptId>` for a skipped entry
  kind: "acted" | "skipped";
  at: number;
  eventId: string | null;
  eventKey: string;
  place: string | null;            // the event's place key
  placeLabel: string | null;
  // acted
  outcome?: EventDeliveryWire["destination"] & { status: EventDeliveryWire["status"]; thread?: EventDeliveryThreadRef; runId?: string; deadText?: string };
  tookMs?: number;                 // deliveredAt - createdAt when both exist
  // skipped
  reason?: "filters" | "sender" | "off" | "claimed" | "other";
  reasonText?: string;             // the filter in words for `filters`
}
export interface LineActivityResponse {
  entries: LineActivityEntryWire[];
  nextCursor?: string;
  lastActedAt: number | null;
  actedLast30Days: number;
  perDay: number[];                // 30 numbers, oldest first, acted counts per UTC day
}
// GET /api/event-subscriptions/:id/activity?before=<cursor>&limit=50
```
Rules: deliveries of the line become `acted` entries (superseded dead rows excluded); receipt decisions for the line with outcome `filter_excluded`, `authorization_denied`, `disabled`, or `key_mismatch`, plus deliveries skipped by a claim, become `skipped` entries; a skipped entry whose event place is not one the line names (by its place filters; a line with no place filter names its service) is returned only when the caller is an org admin; the same read gate as `GET /api/event-subscriptions/:id/deliveries` applies to the line itself; `reasonText` for `filters` reads the first failing filter in words (`the repository filter`, `the channel filter`, `the branch filter`), else `its filters`.

- [ ] Failing tests: acted entries with `tookMs`; each skipped reason; Review Focus 1 (member vs admin); counts and `perDay` boundaries (a delivery 29 days ago counts, 31 days ago does not); paging; the 404 text names its fix.
- [ ] Implement; `pnpm --filter @valet/api test line-activity events.test copy-lint`; `pnpm typecheck`.
- [ ] Commit `feat(api): a line's activity, acted and skipped` with Changelog line: `A line's page can list what it acted on and what it skipped, with the reason.`

### Task 2: The line page and the routine page

**Files:**
- Create: `components/presence/health-strip.tsx` (+ test; the ruled row with the pulse), `components/presence/how-it-works.tsx` (+ test; the three columns with explanations), `components/presence/line-activity.tsx` (+ test; the timeline with chips and `Show earlier`), `components/presence/diagnostics.tsx` (the admin disclosure; moves the receipt rendering out of `rule-page.tsx`), `api/line-activity.ts` (query hook).
- Modify: `components/presence/rule-page.tsx` (+ test) to the Part D step 1 order; `routine-page.tsx` (+ test) to Part E step 2 (health strip from the schedule's runs: `last fired`, firings in 30 days, the pulse; How it works: When = schedule words and zone, Do, Where; Activity = firings); `components/presence/sentences.ts` (the explanation sentences: `whereExplanation(policy, subjectKind)`, `doExplanation(target, appearance)`, `whenExplanation(filters)`; tests); `components/events/delivery-list.tsx` stays for the event page.
- Delete: the `Deliveries` and `Receipts` sections of `rule-page.tsx`; the `Runs in` fact label (the strip is gone; How it works replaces it).

Copy (exact): health strip labels `last acted` / `last fired`, `times in 30 days`, `never`; chips `All`, `Acted`, `Skipped`; `Show earlier`; skipped reasons `skipped, not for this line: <filter>`, `skipped, the sender is not allowed`, `skipped, the line was off`, `skipped, another line claimed it`; acted outcomes `worked in <thread>`, `replied in <thread>`, `started <workflow> run`, `could not reach <thread>, it is archived`; the status line `set up by <creator> <time ago>`; `Diagnostics` heading with `For organization admins: the intake trail for each event, stage by stage.`

- [ ] Failing tests: the section order; Review Focus 2; the pulse has 30 bars with the last emphasized; chips filter kinds; skipped entries for a member vs an admin (mocked responses); explanations per policy; the routine page's anatomy; the proposal section still renders above the strip; gating still disables `Change` links.
- [ ] Implement; `pnpm --filter @valet/web test rule-page routine-page health-strip how-it-works line-activity diagnostics sentences copy-lint`; `pnpm typecheck`; one headless screenshot of a line page against frame 6.
- [ ] Commit `feat(web): a line's page with health, how it works, and activity` with Changelog line: `A line's page shows whether it works, how it works, and what it acted on or skipped.`

### Task 3a: The editor sheet

**Files:**
- Create: `components/presence/editor/line-editor.tsx` (the sheet: Radix Dialog full height, two panes, Esc and discard guard), `editor/section.tsx` (the row with name, summary, `Change`/`Close`, one open at a time), `editor/when-section.tsx` (service choices with `ServiceMark size="md"`, events `Common` + `More events`, conditions as pills + `Add a condition`, the creator-scope pill, the schedule control for `On a schedule`), `editor/do-section.tsx` (three cards, instructions with `Insert a detail from the event`, workflow picker, assistant choice), `editor/where-section.tsx` (policy cards with explanations, inline thread picker, the `When <team> also listens` sub-option), `editor/appears-section.tsx`, `editor/name-section.tsx` (suggested name from the sentence), `editor/side-pane.tsx` (`This line reads`, `For example`, warnings, permissions note, footer), `editor/draft.ts` (the draft state type, `draftFromLine(sub)`, `draftFromRoutine(schedule)`, `bodyFromDraft(draft)` → create/patch bodies, `suggestedName(parts)`, `exampleSteps(draft)`), plus tests for each.
- Reuse: `WhenDoStep`'s service logic (`connectedServices`, `isConnected`), the event picker (`Common`/`More events` from Task B), the filter editor's field catalog, `ScheduleMatchStep`'s day/time/zone control, `RunsInField`'s picker, the appearance inputs, `wizardDraft`/`presenceSentenceParts`/`routineSentenceParts` for the side pane, the collision notice logic for warnings.
- Do not yet delete the wizard or the dialogs; Task 3b switches the launch points.

Interfaces (produces):
```ts
export type EditorMode = { kind: "create"; preselected?: { place?: PreselectedPlace; workflowId?: string; schedule?: boolean } } | { kind: "edit"; line: EventSubscriptionWire } | { kind: "edit-routine"; routine: Routine } | { kind: "review"; line: EventSubscriptionWire; replaces?: { id: string; name: string } };
export function LineEditor(props: { open: boolean; onOpenChange(open: boolean): void; mode: EditorMode; onSaved?(result: { kind: "line" | "routine"; id: string }): void }): JSX.Element;
```
Layout: `DialogContent` with `h-[100dvh] sm:h-[calc(100dvh-4rem)] max-w-[1180px] grid sm:grid-cols-[7fr_5fr]`; the form pane scrolls; the side pane sticky; on phone the sentence card is a sticky header above the form.

- [ ] Failing tests: sections render with summaries; one open at a time; create opens When; edit shows all summarized; the side pane sentence equals `presenceSentence(bodyFromDraft(...))` for every mode; Review Focus 3, 4, 5; the schedule control produces the cron; the name suggestion; disabled Save with its reason; phone layout.
- [ ] Implement; `pnpm --filter @valet/web test line-editor section when-section do-section where-section side-pane draft`; `pnpm typecheck`; one headless screenshot of the editor against frame 7.
- [ ] Commit `feat(web): one full-height editor for lines and routines` with Changelog line: `Creating and editing a line happens in one full-height editor with a live sentence.`

### Task 3b: Launch points and removal

**Files:**
- Modify: every place that opens `AutomationWizard`, `EditSubscriptionDialog`, or `TriggerDialog` (grep): `overview.tsx` (`Add`, `+ Listen for…`, `+ New routine`), `place-page.tsx`, `presence-line.tsx` (Edit, Appears as), `routine-row.tsx`, `rule-page.tsx` (Edit, `Change` links open the editor on a section: add `initialSection?: "when" | "do" | "where" | "appears" | "name"` to `EditorMode`), `routine-page.tsx`, `attention-banner.tsx`, `components/workflows/triggers-drawer.tsx` (`Add`), `team-slack-setup.tsx` if it opens the wizard, the proposal `Turn on` (review mode).
- Delete: `components/events/automation-wizard.tsx` (+ test), `automation-review.tsx`, `edit-subscription-dialog.tsx` (+ test), `components/workflows/trigger-dialog.tsx` (+ test), `wizard-preview.ts` if `draft.ts` absorbed it, `when-do-step.tsx`/`schedule-step.tsx` if their logic moved into the sections (keep them if the sections import them).
- Modify: `components/presence/copy-lint.test.ts` (file list: the editor folder; banned list + `delivery`, `receipt`, `Runs in`), and sweep any `Runs in` label left in `thread-policy-copy.ts` / `sentences.ts` `runsInLabel` (rename to `whereLabel`).

- [ ] Failing tests: INV-H8 (open from Add, a place row, a workflow, a line's Edit, a proposal's Turn on; same section list); each launch point passes the right mode; `Change` opens the named section; the old components are gone (`grep` test or `tsc`).
- [ ] Implement; the whole web suite; `pnpm typecheck`; `pnpm --filter @valet/web exec tsc --noEmit`.
- [ ] Commit `feat(web): open the editor everywhere and retire the wizard` with Changelog line: `Every Add, Edit, and Turn on opens the same editor.`

### Task 4: Acceptance and spec

**Files:**
- Modify: `routes/-presence-acceptance.test.tsx` (P5, P6, P7, P13, P16 to the editor; new P18, P19), `docs/specs/2026-10-16-presence-hub-design.md` (Status `implemented (revision 4)`; Deviations `Revision 4` list), the plan's leftovers.

- [ ] Tests; the web suite; `pnpm typecheck`; `check-prose` (no errors); `docs_lint`.
- [ ] Commit `test(web): Presence acceptance for the line page and the editor` and `docs: record revision 4 deviations`, both `Changelog: none`.
- [ ] Controller: `make e2e 2>&1 | tee /tmp/e2e-presence-r4.log`.
