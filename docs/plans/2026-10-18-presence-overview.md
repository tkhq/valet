# Presence Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Presence rail and Activity landing (spec revision 2) with the overview landing of spec revision 3: one column, one Add, a Needs attention banner, place blocks with sentence rows, an On a schedule group, and Activity as a drill-in.

**Architecture:** `routes/presence.tsx` becomes a one-column shell. `routes/presence.index.tsx` renders a new `components/presence/overview.tsx` built from existing pieces: the sentence renderers (with a no-place option), the `PresenceLine` row, the routine row, the inline `ThreadProblem`, the onboarding cards, and the wizard. `use-problem-count.ts` becomes `use-faults.ts` and returns the fault items the banner renders. The rail, the routines pane, and the rail-only tests go. One routine moves to `/presence/routines/$id`; the redirect table gains the routine rows. No api change beyond one string.

**Tech Stack:** React 19, TanStack Router and Query, Tailwind, Radix; vitest with jsdom; the e2e harness.

**Spec:** `docs/specs/2026-10-16-presence-hub-design.md` (revision 3).

## Global Constraints

- Branch `feat/presence-hub` (HEAD at `db8d3bd36` or later), stacked on `feat/event-claims`; PR base `feat/event-claims`.
- CLAUDE.md rules: ASD-STE100 copy, every error names its fix, `Changelog:` trailer on every commit, subjects of 72 characters or fewer, no `any`, no `as unknown as`, no `useState` seeded from a prop without a sync effect, no index keys.
- UI copy uses only the spec's Terminology table (INV-H2). Banned: `listener`, `automation`, `subscription`, `trigger`, `subject`, `rule`, `event waiter`. System names stay in identifiers, route paths, and API paths.
- No `TabBar` and no rail under `/presence` (INV-H5).
- Every earlier URL redirects with its search params (INV-H1).
- Every fault renders its fix where it is shown (INV-H6).
- Stage only your own files; never `git add -A`. If `.git/index.lock` exists, wait two seconds and retry.
- The local dev stack runs from this worktree (`make dev-local`, web at `localhost:5173`, api under `tsx watch`). Do not restart it.

## Review Focus

1. A workspace with a routine and no place: the overview shows only the `On a schedule` group and no onboarding cards; a workspace with neither shows the cards (Task 1 test).
2. A line whose filters name no single place (`Everywhere in Slack`): it renders once, in the service block, and never as a place block or twice (Task 1 test).
3. A pick from the banner's picker patches the line, the banner item disappears, and the same line's row under its block loses its problem line without a reload (Task 1 test, INV-H6).
4. Eleven blocks: groups collapse to headers with counts, the filter box appears, a group with a fault stays open, and typing a name opens the matching group (Task 1 test).
5. `/presence/routines?routine=sch-1&workspace=team-1` redirects to `/presence/routines/sch-1?workspace=team-1`; `/workflows?tab=scheduled&review=sch-1` redirects to `/presence/routines/sch-1` (Task 2 redirect tests).

---

### Task 1: The overview

**Files:**
- Create: `components/presence/overview.tsx` (+ test), `components/presence/place-block.tsx` (+ test), `components/presence/attention-banner.tsx` (+ test), `components/presence/use-faults.ts` (+ test; replaces `use-problem-count.ts`), `components/presence/overview-groups.ts` (+ test; pure grouping and sorting).
- Modify: `routes/presence.tsx` (one-column shell: title, `WorkspaceClause`, subtitle, `<Outlet/>`; no rail, no `nav`), `routes/presence.index.tsx` (renders `Overview`), `components/presence/sentences.ts` (`presenceSentence(sub, catalog, workflows, threads, { place: false })` omits the `<in|on> <place>` clause; `presenceSentenceParts` if cleaner), `components/presence/presence-line.tsx` (accepts `sentence` so the block passes the no-place form; the `+ Listen for…` affordance moves to the block), `components/presence/onboarding.tsx` (rendered by the overview; copy per spec Part B step 9: the line `or Add to listen somewhere, or run on a schedule.` with an **Add** button), `components/presence/routines-pane.tsx` (export the row as `RoutineRow`; the pane component stays until Task 2 deletes it), `routes/-presence-no-tabs.test.tsx` (INV-H5: no `tablist`, and no `navigation` landmark except `Breadcrumb`).
- Delete: `components/presence/presence-rail.tsx` (+ test), `components/presence/use-problem-count.ts` (+ test).

**Interfaces (produces):**
```ts
// overview-groups.ts
export type OverviewService = "slack" | "github" | "linear";
export interface PlaceBlockData { subject: string; label: string; service: OverviewService; serviceWide: boolean; lines: EventSubscriptionWire[]; activeThreadCount: number; lastActivityAt: number | null; hasFault: boolean }
export interface OverviewGroup { service: OverviewService; blocks: PlaceBlockData[] }
export function overviewGroups(places: readonly PresencePlaceWire[], lines: readonly EventSubscriptionWire[], faults: ReadonlySet<string>): OverviewGroup[]
// mid grain + service roots only; a line maps to its single place filter, else to its service root; blocks sorted by lastActivityAt desc then label; groups without blocks dropped
export const COLLAPSE_THRESHOLD = 10;
// use-faults.ts
export type Fault =
  | { kind: "line"; sub: EventSubscriptionWire; text: string }
  | { kind: "routine"; routine: Routine; text: string }
  | { kind: "delivery"; eventId: string; subscriptionId: string; text: string };
export function useFaults(): { faults: Fault[]; faultedPlaces: ReadonlySet<string>; isPending: boolean }
// same distinct-fault rule as use-problem-count.ts; `text` is the sentence the banner shows
// attention-banner.tsx
export function AttentionBanner({ faults }: { faults: Fault[] }): JSX.Element | null
// line fault: `<pinned title> is archived. Pick another thread:` + ThreadPicker (variant inline) patching the line; routine fault: `<name> is off: <disabledReason>` + Edit link to /presence/routines/$id; delivery fault: the Part F row text + link to /presence/events/$eventId
```
Copy: header button `Add` (opens `AutomationWizard` with no preselection); banner heading `Needs attention`; group headings `Slack`, `GitHub`, `Linear`, `On a schedule`; service block headers `Everywhere in Slack`, `Across GitHub`, `Across Linear` (link to the service place page); block meta `<n> active` and `<time ago>`; block footer `+ Listen for…`; schedule block footer `+ New routine` (opens the wizard with `startOn="routine"`); footer link `Activity` to `/presence/activity`; filter box `Filter places`; loading `Loading…`; a failed read `Could not load Presence. Reload the page to try again.`

- [ ] Failing tests: `overviewGroups` (mid grain only, service-wide lines once, sort, drop empty groups, faulted set), `useFaults` (one fault counted once; fixed line gone), banner (each fault kind renders its fix; a pick patches), place block (sentence rows without the place clause, switch, overflow, inline problem, paused line, `+ Listen for…` opens the wizard fixed on the place), overview (group order, the schedule block with `Next:` and `Fire now`, the empty state gate, Review Focus 1 to 4, Add opens the wizard on When with four choices), INV-H5 test.
- [ ] Implement; `pnpm --filter @valet/web test overview place-block attention-banner use-faults overview-groups presence-no-tabs sentences`; `pnpm typecheck`.
- [ ] Commit `feat(web): land Presence on an overview of places` with Changelog line: `Presence opens on an overview of every place and what Valet does there.`

### Task 2: Routes, redirects, drill-ins

**Files:**
- Create: `routes/presence.routines.$id.tsx` (renders `RoutinePage` with breadcrumb `Presence › On a schedule › <name>`; `On a schedule` links to `/presence#schedule`, the overview group's anchor), `routes/presence.routines.index.tsx` (redirect-only: `?routine=<id>` → `/presence/routines/$id`, else `/presence`).
- Modify: `routes/presence.routines.tsx` (a thin `<Outlet/>` layout), `routes/-presence-redirects.ts` (+ test): `LegacyRoute` gains `/presence/routines`; rows: `routine` present → `/presence/routines/$id` with `mapParams: ({}, s) => ({ id: s.routine })` and `mapSearch` dropping `routine`; else → `/presence`; the `/workflows?tab=scheduled|triggers` rows go to `/presence`, and with `review` to `/presence/routines/$id`; `PresencePath` gains `/presence/routines/$id` and drops `/presence/routines`; `routes/presence.activity.tsx` and `components/presence/activity-pane.tsx` (breadcrumb `Presence › Activity` via `PresenceDetailPage`; the onboarding gate leaves Activity, the overview owns it), `components/presence/page-shell.tsx` (first crumb `Presence` on every detail page; `place-page.tsx`, `rule-page.tsx`, `routine-page.tsx` crumbs updated), `components/presence/routine-page.tsx` (links and the fact strip per spec Part E step 2), `components/workflows/triggers-drawer.tsx` and any `to="/presence/routines"` with `search: { routine }` → `to="/presence/routines/$id"` (grep), `components/events/automation-wizard.tsx` (on Create, call an optional `onCreated(target: { kind: "line" | "routine"; id: string })` prop; the overview scrolls to and highlights the block that holds it for two seconds, spec Part H step 9), `packages/api/src/routes/presence.ts` (+ test) (`Pick the channel from Presence.`).
- Delete: `components/presence/routines-pane.tsx` wrapper (keep `RoutineRow`, `isRoutine`, `useRoutineSentence`, `routineWhen` in a new `components/presence/routine-row.tsx`), its pane test, `routes/-presence.routines*` tests that assert the pane.

- [ ] Failing tests: Review Focus 5 and every new redirect row; the routine page breadcrumb; the Activity breadcrumb; `onCreated` fires with the new id and the overview highlights the block; the api refusal text.
- [ ] Implement; `pnpm --filter @valet/web test presence-redirects routine-page activity-pane automation-wizard overview`; `pnpm --filter @valet/api test presence.test`; `pnpm typecheck`.
- [ ] Commit `feat(web): routine pages and Activity as Presence drill-ins` with Changelog line: `A routine has its own page under Presence; old routine links redirect.`

### Task 3: Acceptance, lint, spec

**Files:**
- Modify: `routes/-presence-acceptance.test.tsx` (P1 to P12 per revision 3), `components/presence/copy-lint.test.ts` (add the new files), `docs/specs/2026-10-16-presence-hub-design.md` (Status `implemented (revision 3)`; Deviations for anything the implementation changed; retire bullets that no longer apply).

- [ ] Rewrite the acceptance test; `pnpm --filter @valet/web test presence-acceptance copy-lint`; `pnpm --filter @valet/web test`; `pnpm typecheck`; `python3 /Users/conner/.claude/skills/writing-executable-specifications/scripts/check-prose.py docs/specs/2026-10-16-presence-hub-design.md` (no `[error]`); `python3 scripts/docs/docs_lint.py`.
- [ ] Commit `test(web): Presence overview acceptance` and `docs: record Presence overview deviations`, both `Changelog: none`.
- [ ] Controller: `make e2e 2>&1 | tee /tmp/e2e-presence-overview.log` (full output).
