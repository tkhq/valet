# Presence Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Presence section (revision 1, tabs) as a rail of places with an Activity landing, move Workflows back to its own nav entry, and make every line of copy use the revision 2 vocabulary (presence, place, routine; no listener, automation, rule).

**Architecture:** `routes/presence.tsx` becomes a two-pane shell (rail + `<Outlet/>`) on the Settings rail idiom. The rail reads the existing `GET /api/presence/places` and filters to the mid grain. The place, rule, routine, and activity panes are restructured from the revision 1 components. The wizard gains a live sentence preview and a When/Do first step. The sentence renderers switch to the `When …, <do>.` grammar. No api change: every read already exists.

**Tech Stack:** React 19, TanStack Router and Query, Tailwind, Radix; vitest with jsdom; the full-stack e2e harness.

**Spec:** `docs/specs/2026-10-16-presence-hub-design.md` (revision 2).

## Global Constraints

- Branch `feat/presence-hub` (HEAD at `d43cff66c` or later), stacked on `feat/event-claims`; PR base `feat/event-claims`.
- CLAUDE.md rules: ASD-STE100 copy, every error names its fix, `Changelog:` trailer on every commit, subjects of 72 characters or fewer, no `as unknown as`, no `any`.
- UI copy uses only the spec's Terminology table (INV-H2). Banned in `components/presence/**`, the presence routes, and every dialog the section opens: `listener`, `automation`, `subscription`, `trigger`, `subject`, `rule`, `event waiter`. System names stay in code identifiers, route paths, and API paths.
- No `TabBar` anywhere under `/presence` (INV-H5).
- Every revision 1 URL and every pre-hub URL redirects with its search params (INV-H1).
- Parity only (INV-H3): the rail, the panes, the wizard preview and When/Do step, and the copy. No new api endpoint.
- Stage only your own files; never `git add -A`. If `.git/index.lock` exists, wait two seconds and retry.
- The local dev stack runs from this worktree (`make dev-local`, web at `localhost:5173`). Web edits hot-reload. Do not restart it.

## Review Focus

1. A workspace with places but no routines: the rail shows `Routines` with count 0, and the Routines pane shows its empty state, not the onboarding cards (Task 2 and Task 5 tests).
2. A place whose only lines are paused by a team: the rail row shows the count, no active dot, no problem dot; the page row reads `Paused: the team already listens for this.` (Task 3 test).
3. A rule with a problem in a team workspace the viewer cannot edit: the inline problem line shows text and no picker, and the rail problem count still counts it (Task 3 test, Task 2 test).
4. The wizard opened from `#incidents` with the When step: the preview reads `When someone mentions Valet in #incidents, reply in a new thread.` before any field is touched, and switching Do to `Work on it` changes it to `…, work in its own thread.` (Task 6 test).
5. `/presence/listeners/<id>?workspace=team-1` redirects to `/presence/rules/<id>?workspace=team-1` (Task 2 redirect test).

---

### Task 1: Workflows back to `/workflows`

**Files:**
- Move (git mv): `routes/presence.workflows.index.tsx` → `routes/workflows.index.tsx` (replace the redirect-only file), `routes/presence.workflows.$workflowId.tsx` → `routes/workflows.$workflowId.tsx`, `routes/presence.runs.$runId.tsx` → `routes/workflows.runs.$runId.tsx`, `routes/presence.runs.index.tsx` → `routes/workflows.runs.index.tsx` (new path `/workflows/runs/`), and their tests `routes/-presence.workflows.*.test.tsx`, `-presence.runs.*.test.tsx` → `-workflows.*.test.tsx`.
- Delete: `routes/presence.workflows.tsx`, `routes/presence.runs.tsx`.
- Modify: `routes/workflows.tsx` (layout with a small header: `Workflows` title, `WorkspaceClause`, and two links `Workflows` and `Runs` styled as the Threads page's segment links; no `TabBar`), `routes/workflows.runs.$runId.tsx` and `workflows.$workflowId.tsx` (route paths), every `to="/presence/workflows..."` and `to="/presence/runs..."` in `src/` (grep; includes `components/workflows/*`, `components/presence/*`, `routes/*`), `components/layout/top-nav.tsx` (add `{ to: "/workflows", label: "Workflows" }` after Presence), `routes/-presence-redirects.ts` (remove the `/workflows*` rows and their `LegacyRoute` members; add `LegacyRoute` members `/presence/workflows`, `/presence/workflows/$workflowId`, `/presence/runs`, `/presence/runs/$runId` with rows to `/workflows`, `/workflows/$workflowId`, `/workflows/runs`, `/workflows/runs/$runId`, each `mapSearch: (s) => s`), new redirect-only route files `routes/presence.workflows.tsx`, `routes/presence.workflows.$workflowId.tsx`, `routes/presence.runs.tsx`, `routes/presence.runs.$runId.tsx` (each `beforeLoad: redirectToPresence(<its path>)`), `routes/-presence-redirects.test.ts` (rows), `components/presence/page-shell.tsx` (`PresenceListPath` drops the workflows and runs members).

**Interfaces (produces):** `PresencePath` gains `"/workflows" | "/workflows/$workflowId" | "/workflows/runs" | "/workflows/runs/$runId"`. Later tasks link to `/workflows/runs/$runId` for a run.

- [ ] Failing tests: the moved page tests at their new paths; redirect rows for the four `/presence/workflows*` and `/presence/runs*` URLs; the top nav shows `Workflows`.
- [ ] Implement; `pnpm --filter @valet/web test workflows presence-redirects top-nav`; `pnpm typecheck`.
- [ ] Commit `feat(web): give Workflows its own nav entry again` with Changelog line: `Workflows and Runs are back at /workflows with their own nav entry.`

### Task 2: The rail shell

**Files:**
- Create: `components/presence/presence-rail.tsx` (+ test), `components/presence/places.ts` (the `SERVICE_NAMES`, `isServiceRoot`, and a new `isMidGrain(place)` moved out of `places-tab.tsx`), `components/presence/use-problem-count.ts` (+ test), `routes/presence.rules.$id.tsx` (from `presence.listeners.$id.tsx`, moved), `routes/presence.listeners.$id.tsx` (redirect-only, `beforeLoad: redirectToPresence("/presence/listeners/$id")`), `routes/-presence-no-tabs.test.tsx` (INV-H5).
- Modify: `routes/presence.tsx` (shell), `routes/presence.index.tsx` (Activity at `/presence`, `validateSearch: readActivitySearch`), `routes/-presence-redirects.ts` (`/events` Channels row → `/presence`; the Subscriptions review row → `/presence/rules/$id`; new `LegacyRoute` `/presence/listeners/$id` → `/presence/rules/$id`, `mapParams: sameParams`), `components/presence/page-shell.tsx` (`PresenceDetailPage` becomes a pane header: a `Breadcrumb` of `{ label, to?, params?, search? }[]` instead of one back link; no outer `pageClass` wrapper, because the shell owns the page frame), every `to="/presence/listeners/$id"` → `to="/presence/rules/$id"`.
- Delete: `routes/-presence.test.tsx` (the tabs frame test), `PresenceTabsFrame`, `PRESENCE_TABS`, `presenceTabFor`, `routes/-presence.index.test.ts`.

**Interfaces (produces):**
```ts
// presence-rail.tsx
export interface RailPlace { subject: string; label: string; service: PresencePlaceService; count: number; active: boolean; problem: boolean }
export function railGroups(places: readonly PresencePlaceWire[], problems: ReadonlySet<string>): Array<{ service: PresencePlaceService; root: PresencePlaceWire | undefined; places: RailPlace[] }>
export const RAIL_FILTER_THRESHOLD = 8;
export function PresenceRail(): JSX.Element;
// use-problem-count.ts
export function useProblemCount(): { count: number; problemPlaces: ReadonlySet<string> } // rules with `problem` + routines with `disabledReason` + log items whose deliveries include status "dead" in the last 24 h
```
Rail order and copy (spec Part B): a `New routine` button (opens `TriggerDialog` `schedulesOnly`), `Activity` with the problem count as a danger badge when > 0, `Routines` with the routine count, then a group per service with a header link to the service-wide place (`Everywhere in Slack`, `Across GitHub`, `Across Linear`; the header is the row whose `subject` is the service root) and mid-grain rows: Slack channels (`slack:<team>/<channel>`), repositories (`github:<owner>/<repo>`, no `#`), Linear teams (`linear:team/<KEY>`). A group with no root count and no places does not render. Past `RAIL_FILTER_THRESHOLD` places, a text input `Filter places` appears and groups render collapsed (a `<details>` per group, open for the selected place's group). Mobile: a `DropdownMenu` as in `SettingsRail`, trigger label `<group> / <place>` or `Presence`. `aria-label="Presence"` on the `nav`. Rail width `sm:w-60`. Active row class matches `SettingsRail`.

Shell: title `Presence` + `WorkspaceClause`, subtitle `Where Valet is, and what it does there.`, then `flex sm:flex-row gap-10` with `<PresenceRail/>` and a `min-w-0 flex-1` pane holding `<Outlet/>`.

- [ ] Failing tests: `railGroups` keeps only mid-grain rows, puts the service root as `root`, drops empty groups, sets `problem` from the set; the rail shows counts and the `New routine` button; `/presence` renders Activity; INV-H5 test renders the shell with a memory router at each `/presence*` route and asserts `queryByRole("tablist")` is null; redirect rows; `useProblemCount` sums the three sources.
- [ ] Implement; `pnpm --filter @valet/web test presence-rail problem-count presence-redirects presence-no-tabs`; `pnpm typecheck`.
- [ ] Commit `feat(web): lay Presence out as a rail of places` with Changelog line: `Presence is a rail of places with Activity as its landing page.`

### Task 3: Sentence grammar and copy sweep

**Files:**
- Modify: `components/presence/sentences.ts` (+ test): rename `listenerSentence` → `presenceSentence` with the Part C grammar `When <events> [from <sender>] <in|on> <place>, <do>[, as <appearance>].` (`in` for Slack and Linear, `on` for GitHub; without a place, `When <events>[ from <sender>], <do>.`); `<do>` rows per spec Part C step 2 (`reply in a new thread`, `work in a new thread each time`, `work in one thread per <pull request | issue | channel>`, `work in its own thread`, `work in the <title> thread`, `run <workflow>`); `routineSentence` → `<schedule in words>, <name>: <do>.`; keep `activitySentence`, `eventInWords`, `eventPlace`, `cronInWords`, `runsInLabel`.
- Rename: `components/presence/listener-rows.tsx` → `presence-rows.tsx` (`useListenerSentence` → `usePresenceSentence`, `ListenerRow` → `PresenceRow`, `ListenerBadges` → `PresenceBadges`), `components/presence/listener-page.tsx` → `rule-page.tsx` (`ListenerPage` → `RulePage`; the Task 4 restructure follows), `api/listener.ts` → `api/rule.ts` (`useListenerDeliveries` → `useRuleDeliveries`, `useListenerReceipts` → `useRuleReceipts`).
- Copy sweep (string literals and JSX text only): `components/presence/**`, `components/events/automation-wizard.tsx`, `edit-subscription-dialog.tsx`, `automation-review.tsx`, `delivery-list.tsx`, `delivery-copy.ts`, `event-log.tsx`, `receipts-panel.tsx`, `team-slack-setup.tsx`, `delivery-preferences.tsx`, `components/workflows/trigger-dialog.tsx`, `triggers-drawer.tsx`, `routes/workflows.index.tsx`. Replacements: a noun phrase for one line of presence becomes its sentence, its name, or `this` (`Turn off this` is wrong; write `Turn off <name>`); `listeners and routines` → `What starts it`; `New listener` → `Listen for…`; `No listener here yet.` → `Nothing is set up here yet.`; `Paused: a team listener covers the same events.` → `Paused: the team already listens for this.`; `This listener's thread is archived. Pick another thread.` → `<title> is archived. Pick another thread:` (the title comes from `usePinnedThreadTitle`; fallback `The pinned thread`); `This routine's thread is archived…` → same form; `Runs when a listener hears its event` → `Runs when its event happens`; wizard title `New ${flowName}` → `Listen for…` or `New routine`; create button `Create`; `Set by <name>` stays.
- Modify: `components/presence/copy-lint.test.ts`: `BANNED = ["listener", "automation", "subscription", "trigger", "subject", "rule", "event waiter"]`; add the swept files to its list; the allow comment stays `// copy-lint: allow <word>` for a quoted example only.

**Interfaces (produces):** `presenceSentence(sub, catalog, workflows, threads): string`, `routineSentence(routine, workflows, threads): string`, `usePresenceSentence(subs, knownThreads?)`, `PresenceRow({ sub, sentence })`.

- [ ] Failing tests: one per `<do>` row and the `in`/`on` rule; the routine form; the copy lint over the new list fails before the sweep.
- [ ] Implement; `pnpm --filter @valet/web test sentences copy-lint presence-rows`; `pnpm typecheck`.
- [ ] Commit `feat(web): write Presence lines as When sentences` with Changelog line: `Presence lines read as sentences: When X happens in a place, Valet does Y.`

### Task 4: The place page and the rule page

**Files:**
- Modify: `components/presence/place-page.tsx` (+ test): header (name, service, `scopeLabel` dropped from the subtitle), **Valet here** section with one `PresenceLine` per line (sentence linked to `/presence/rules/$id`, a `Switch` with `aria-label="Turn <on|off> <name>"`, an overflow `DropdownMenu` with `Edit`, `Appears as`, `Delete`; `Edit` opens `EditSubscriptionDialog`, `Appears as` opens it on its appearance field, `Delete` opens `ConfirmDialog` with `Delete "<name>"?`), the inline problem line under a row (`ThreadProblem` without its box border, text `<title> is archived. Pick another thread:`), `Paused: the team already listens for this.` under a paused personal row, a `Listen for…` button (`Plus` icon) that opens `AutomationWizard` with `preselectedPlace`, then **Threads** (`PlaceThreads`, with `One thread per pull request` / `One thread per issue` for a repository or team), **Appears as** when any line sets one (inline `AppearanceSettings` on change), **Recent activity** (ten rows, `View all` link to `/presence/activity` with `q=<label>`). Empty place: `Nothing is set up here yet.` + the button. The pane header uses `PresenceDetailPage` with breadcrumb `[{ label: "Presence", to: "/presence" }, { label: <name> }]`.
- Modify: `components/presence/rule-page.tsx` (+ test): breadcrumb `[{ label: <place label>, to: "/presence/places/$subject" }, { label: sub.name }]` (the place from `placeOfSubject` over the rule's first place filter; without one, `Presence`); the sentence as the `h1`; a fact strip `dl` with `When` (events in words), `Do` (the `<do>` phrase), `Runs in` (`runsInLabel`), `Appears as` (name or `Valet`), and an `Edit` button; the on/off switch; the problem line; **Deliveries** as sentences via `DeliveryList`; **Receipts** under a `<details>` with summary `Receipts` for admins only.
- Delete: `components/presence/all-listeners-table.tsx` (+ test), `components/presence/places-tab.tsx` (+ test) after Task 2 moved its helpers.

- [ ] Failing tests: the five sections in order; the switch patches `enabled`; the overflow menu items; the inline problem line and picker; the paused copy; read-only hides the picker (Review Focus 3); the rule page breadcrumb, fact strip, and receipts disclosure.
- [ ] Implement; `pnpm --filter @valet/web test place-page rule-page`; `pnpm typecheck`.
- [ ] Commit `feat(web): show a place as sentences with inline controls` with `Changelog: none`.

### Task 5: Routines and Activity panes

**Files:**
- Modify: `components/presence/routines-tab.tsx` → rename `routines-pane.tsx` (+ test): `RoutinesPane`; header `Routines` with `New routine`; rows with the Part E sentence, `Next: <toLocaleString>` or `Off`, a `Switch` (`useUpdateSchedule` `enabled`), `Fire now`; empty state `No routine yet. Select New routine to have Valet act at a set time.`; `routine-page.tsx` breadcrumb `[{ label: "Routines", to: "/presence/routines" }, { label: name }]` and a fact strip (`When`, `Do`, `Runs in`).
- Modify: `components/presence/activity-tab.tsx` → `activity-pane.tsx` (+ test): chips `All`, `Problems`, `Slack`, `GitHub`, `Linear` (the service chips filter rows client-side by `eventKey` prefix; `status=problems` maps to the existing log filter), a `Place` text input bound to `q`; receipts under a `<details>` for admins; `ActivitySearch` gains `service?: "slack" | "github" | "linear"`. Onboarding empty state (spec Part C step 8): when `usePresencePlaces` returns no place and the routines list is empty, the pane shows `Valet is not present anywhere yet.`, three cards linking to `/integrations` (`Connect Slack`, `Connect GitHub`, `Connect Linear`), and `or add a routine` opening the routine dialog. `routes/presence.activity.tsx` and `presence.index.tsx` read the new search.
- Modify: `routes/-presence-redirects.ts` `activitySearch` keeps working (no new legacy key).

- [ ] Failing tests: the chips filter; the place input writes `q`; onboarding shows only with no places and no routines (Review Focus 1); routine rows show `Next:`, the switch, and `Fire now`.
- [ ] Implement; `pnpm --filter @valet/web test routines-pane activity-pane routine-page`; `pnpm typecheck`.
- [ ] Commit `feat(web): Routines and Activity panes` with `Changelog: none`.

### Task 6: The wizard

**Files:**
- Modify: `components/events/automation-wizard.tsx` (+ test), `components/events/automation-review.tsx`:
  1. A preview line at the top of the dialog, under the step header: `<p aria-live="polite" data-testid="wizard-preview">` with the sentence from the shared renderers. Build a draft from state: for event outcomes, an `EventSubscriptionWire`-shaped draft `{ eventKeys, filters, target: { kind, assistant|workflowId, thread: effective policy, appearance } }` passed to `presenceSentence`; for `schedule`, a `RoutineLike` passed to `routineSentence` with `name` = the typed name or `this routine`. Delete `describeAutomation` and use the preview sentence in the review step too.
  2. Step 1 becomes **When** and **Do**. `When` radios: `Someone mentions Valet in Slack`, `Something happens on GitHub`, `Something happens in Linear`, `On a schedule`. `Do` radios (shown for the first three): `Reply` (Slack only), `Follow a Slack thread` (Slack only), `Work on it`, `Run a workflow`. The pair maps onto the existing `Outcome`: mention + Reply → `reply`; Slack + Follow → `thread`; any service + Work on it → `notify` with the service preselected in the match step; any service + Run a workflow → `workflow`; schedule → `schedule`. `Advanced: pick events and filters` stays as a `<details>` under the radios that selects `advanced`. Launched from a place, the `When` radios show only that service's row and it is selected. Launched from Routines (`startOn="routine"`), the schedule step opens first. Launched from a workflow, `Do` is fixed on `Run a workflow`.
  3. Titles: `Listen for…` for event flows, `New routine` for the schedule flow; the final button reads `Create`.
  4. `Runs in` shows `runsInLabel` as a sentence `Runs in: <label>` with a `Change` button that reveals `RunsInField`.
  5. `Appears as` behind a `<details>` with summary `Appears as`.
- `components/workflows/trigger-dialog.tsx`: title `New routine` when `schedulesOnly`.

- [ ] Failing tests: Review Focus 4; the When/Do mapping to each `Outcome`; the place-fixed When step; titles; the preview text equals the review step's sentence.
- [ ] Implement; `pnpm --filter @valet/web test automation-wizard trigger-dialog`; `pnpm typecheck`.
- [ ] Commit `feat(web): wizard reads the choice back as a sentence` with Changelog line: `The Listen for wizard shows the sentence it will create as you choose.`

### Task 7: Acceptance, lint, validation, spec

**Files:**
- Modify: `routes/-presence-acceptance.test.tsx` (steps P1 to P12 over the new routes), `components/presence/copy-lint.test.ts` (confirm the full list), `docs/specs/2026-10-16-presence-hub-design.md` (Status `implemented`; add Deviations for anything the implementation changed, such as the `Follow a Slack thread` Do option, the service chips as client-side filters, and the `q` place search).
- Delete: any file revision 1 left unused (`pnpm --filter @valet/web exec knip` is not set up; grep for unused exports in `components/presence/**`).

- [ ] Rewrite the acceptance test; `pnpm --filter @valet/web test presence-acceptance copy-lint`.
- [ ] `pnpm typecheck`; `python3 scripts/docs/docs_lint.py`; `make e2e 2>&1 | tee /tmp/e2e-presence-rail.log` (full output, never piped through tail or grep).
- [ ] Commit `test(web): Presence rail acceptance` and `docs: record Presence rail deviations`, both `Changelog: none`.
