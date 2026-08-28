# Team dashboard — the home page follows the workspace switcher

**Status: implemented 2026-08-27.**

## Problem

Every list page (`/sessions`, `/workflows`, `/memory`, `/events`, `/skills`)
follows the workspace switcher. The home page does not: it always renders the
caller's personal assistant (identity hero, personal memory, personal usage).
With the switcher on a team, the home page answers questions about the wrong
workspace. A member wants to know what the team's assistants have done, what
the team's workflows are doing, and what the team spends.

## Decision

One home URL. `/` branches on the active workspace scope:

- Personal scope renders the existing personal dashboard, unchanged.
- Team scope renders the team dashboard described here.

An org-wide dashboard is out of scope. The switcher has no org workspace, and
adding one is its own design.

## The team dashboard

The hero is an activity feed: what the team's agents did, newest first. The
personal identity motif does not apply — a team has several assistants and no
single persona.

```
Security                                  3 members
Assistants: Security Sentinel (working) · 2 more

Activity
  ▸ Security Sentinel ran "Audit PR #441"    settled · 12m
  ▸ triage-workflow #88                      failed · 1h
  ▸ Security Sentinel ran "Rotate creds"     running

[ Workflows ]  [ Usage (team, 7d) ]
[ Artifacts ]  [ Memory ]
```

The feed merges two reads, client-side, by `createdAt` descending, capped at
15 rows:

1. **Assistant runs** — child sessions the team's assistants spawned
   (`GET /api/teams/:id/children`, new). Each row names the assistant that
   ran it. The response is the 20 newest watches PLUS every still-running
   watch (each read bounded at 20): a running child older than the window
   must not read as idle because quick runs settled after it started.
2. **Workflow runs** — team-owned runs (`GET /api/workflows/runs`, existing
   owner filter).

Feed rows link to the child session or the run page. An assistant with an
unsettled child renders as "working" in the header line — presence derives
from the feed, not from a live-session probe.

Cards below the feed:

- **Workflows** — enabled count and the most recent runs; links to
  `/workflows` (already workspace-scoped).
- **Usage** — team spend for the 7d window from the breakdown endpoint with
  the new team scope.
- **Artifacts** — the team's five most recent artifacts, by `updatedAt`.
- **Memory** — the team memory tree's stats (files, journal days, pinned),
  same derivation as the personal card; links to `/memory`.

Each card degrades independently: its own loading row, its own error row
with a Retry control. A failed card never blanks the page.

## API additions

Three small reads. No new tables, no schema change.

### 1. `GET /api/teams/:id/children`

The team mirror of `GET /api/orchestrator/children`: `child_watches` ⋈
`agent_sessions` for EVERY assistant the team owns, newest first, capped at
20. Response rows extend `OrchestratorChildSummary` with `assistantId` and
`assistantName`, so the feed can attribute a run to the assistant that
spawned it.

Authorization: team membership, the same rule that gates
`GET /api/teams/:id/members`. Non-members get 404 (existence-hiding).

### 2. Usage scope `team:<id>`

`resolveUsageScope` gains a third arm: `scope=team:<teamId>` resolves when
the caller is a member of that team; otherwise `"forbidden"` (403). The
WHERE clause filters `cost_entries` by `owner_type = 'team' AND owner_id =
<id>` — the view already carries both columns. Every team member may read
their team's spend: spend is a team resource like team memory and team
workflows, and those are member-visible. `UsageBreakdownResponse.scope`
widens to `"me" | "org" | "team"`. The CSV export accepts the same scope.

`byUser` is admin-gated: the org scope always reports it, and a team scope
reports it when the caller administers the team (team admin or org admin).
A plain member reads the team's aggregate by use case, model and day —
never colleagues' individual spend. The CSV export follows the same rule:
a plain member's export carries the team's turns with the user_id column
blank.

The `/usage` page exposes the scope: every team the caller is a member of
gets a button beside "My usage", and "Organization" stays org-admin-only.
Teams an org admin only administers (`callerRole` null) get no button —
the Organization scope covers them. The CSV export follows the selected
scope and labels the file with the team name.

### 3. Artifacts owner filter

`GET /api/artifacts?ownerType=team&ownerId=<id>` lists the team's artifacts
(member-gated, 404 for non-members). Without the filter the route behaves
as before (caller's own; org admins see org-wide). New service function
`listArtifactsForOwner(db, orgId, owner)`.

## Web composition

- `routes/index.tsx` branches on `useWorkspaceScope()`: `teamId === undefined`
  renders the existing `Dashboard`; a team renders `TeamDashboard`.
- `TeamDashboard` (`components/dashboard/team-dashboard.tsx`) owns the
  header, feed, and cards. The feed merge is a pure exported function
  (`mergeTeamFeed`) so ordering, capping, and attribution are unit-tested
  without queries.
- New hooks: `useTeamChildren(teamId)` (30s refetch — runs move), a
  team-scoped artifacts list, and a breakdown query with the team scope.
  Workflow runs reuse `useRuns` with the owner filter; memory stats reuse
  the tree endpoint with `ownerType/ownerId`.

## Error and empty states

- A brand-new team (no assistants, no runs) gets an empty-state feed that
  says what fills it: "No agent activity yet. Open the team's assistant or
  enable a workflow."
- Feed reads failing renders an ErrorRow + Retry in the feed slot; cards
  fail independently.
- The switcher's fallback rule (a stored team the caller left resolves to
  personal) already guards the branch input.

## Testing

- API integration: children route (membership gate, join shape, assistant
  attribution, newest-first cap); usage team scope (member reads, non-member
  403, org/me arms unchanged); artifacts owner filter (member reads team
  rows, non-member 404, unfiltered behavior unchanged).
- Web: `mergeTeamFeed` unit tests (ordering, cap, attribution fallback);
  route branch test (personal vs team scope); TeamDashboard render tests
  (feed rows, empty state, per-card error isolation) following the
  `-index.test.tsx` mock pattern.
- `make e2e` scorecard before shipping.
