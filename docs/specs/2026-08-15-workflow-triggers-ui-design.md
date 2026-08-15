# Workflow Triggers UI + Workflows Hub Redesign

Date: 2026-08-15
Status: Approved design
Branch target: `dev-v2`

## Goal

Give scheduled triggers (and event triggers) a user-facing surface in the
web app, and redesign the Workflows page into a tabbed hub. The v2 backend
for schedules already exists; this work exposes it over REST and builds the
UI on top.

## Current state (dev-v2)

- `workflow_schedules` table (`packages/api/src/schema/index.ts`): cron +
  IANA timezone, `targetKind: workflow | orchestrator`, `prompt` for the
  orchestrator target, `enabled`, `lastFiredAt`, `nextFireAt`.
- `schedule-service.ts`: `nextFireAt()` cron evaluation,
  `createWorkflowSchedule`, `listWorkflowSchedules`,
  `deleteWorkflowSchedule`. There is no update, no enable/disable, and no
  fire-now.
- `scheduler.ts` (`WorkflowScheduler`): 30s poll over due rows. It fires a
  workflow run (idempotent derived runId) or an orchestrator prompt.
  Catch-up collapses to at most one run after downtime. No changes needed.
- `trigger-service.ts`: event triggers are `event_subscriptions` rows with a
  `{ kind: "workflow", workflowId }` target. `createWorkflowTrigger`,
  `listWorkflowTriggers`, `deleteWorkflowTrigger`, `listEventTypes`
  (catalog). No update and no enable/disable.
- Management today is agent-tool-only (`workflows.create_schedule` etc. in
  `actions.ts`). There is no REST surface and no UI.
- The web Workflows page (`packages/web/src/routes/workflows.index.tsx`) is
  a flat list: name, run count, Run, Delete.

### Scope note: webhooks

dev-v2 has no per-workflow webhook-secret feature. Inbound webhooks enter
through the event-webhooks ingress and become events; a workflow reacts to
them through an event trigger. The unified Triggers surface therefore
covers two kinds: `schedule` and `event`. If a direct per-workflow webhook
endpoint lands later, it joins the normalized list as a third kind.

## Decisions

1. **Aggregated read, kind-specific writes.** One endpoint returns all
   triggers normalized for the list UI. Creates, updates, and deletes go
   through kind-specific endpoints that wrap the existing services. No
   storage unification; `workflow_schedules` and `event_subscriptions`
   stay as they are.
2. **No scheduler changes.** The poll loop, idempotency, and catch-up
   behavior are already correct.
3. **Tabbed hub.** The Workflows page becomes three tabs: Workflows,
   Runs, Triggers. The workflow editor page gets a scoped triggers panel
   that reuses the same components.
4. **Orchestrator-target schedules are first-class.** They have no
   workflowId. The global Triggers tab is their only home.

## API design (`packages/api`)

New route file `src/routes/workflow-triggers.ts`, mounted with the other
authenticated routes and owner-scoped like `routes/workflows.ts`
(cross-owner access returns 404).

Aggregated read:

- `GET /api/workflows/triggers` — normalized list, optional
  `?workflowId=` filter. Item shape:
  `{ kind: "schedule" | "event", id, workflowId?, name, enabled, detail }`.
  For schedules, `detail` carries `cron`, `timezone`, `targetKind`,
  `prompt?`, `input?`, `nextFireAt`, `lastFiredAt`. For event triggers,
  `detail` carries `eventKeys` and `filters`.

Schedules (wrap `schedule-service`):

- `POST /api/workflows/schedules` — body: `name`, `cron`, `timezone?`,
  target (`{ kind: "workflow", workflowId, input? }` or
  `{ kind: "orchestrator", prompt }`), `enabled?`. Invalid cron returns 400
  with the parse error and an example expression.
- `PATCH /api/workflows/schedules/:id` — partial update of the same
  fields, including `enabled` for toggle. A cron or timezone change
  recomputes `nextFireAt`.
- `DELETE /api/workflows/schedules/:id`
- `POST /api/workflows/schedules/:id/run` — fire now, through the same
  code path the scheduler uses, without moving `nextFireAt`.

Service change: add `updateWorkflowSchedule` and a fire-now entry point to
`schedule-service.ts` / `scheduler.ts`. The scheduler's per-fire logic is
extracted so the route and the poll loop share it.

Event triggers (wrap `trigger-service`):

- `POST /api/workflows/event-triggers` — body: `workflowId`, `name`,
  `eventKeys`, `filters?`, `enabled?`.
- `PATCH /api/workflows/event-triggers/:id` — partial update including
  `enabled`.
- `DELETE /api/workflows/event-triggers/:id`
- `GET /api/workflows/trigger-catalog` — `listEventTypes()` output so the
  UI can offer event keys and filter fields.

Service change: add `updateWorkflowTrigger` to `trigger-service.ts`.

Global runs (for the Runs tab):

- `GET /api/workflows/runs` — recent run summaries across the owner's
  workflows (workflowId, workflow name, status, outcome, startedAt),
  newest first, limit parameter with a sane default (50).

No migrations. No engine changes.

## Web design (`packages/web`)

`workflows.index.tsx` becomes a tabbed hub (Radix Tabs, existing Tailwind
idiom). Route-level tab state so each tab is linkable.

- **Workflows tab** — upgraded rows/cards: name, last-run status chip
  (reuse `run-status-chip`), run count, trigger badges (clock icon for
  schedules with next-fire tooltip, bolt icon for event triggers), and the
  existing Run / Edit / Delete actions.
- **Runs tab** — global recent-runs list from `GET /api/workflows/runs`;
  each row links to the run detail page.
- **Triggers tab** — the unified list, grouped by workflow with an
  "Orchestrator" group for workflowId-less schedules. Each row: kind icon,
  name, summary (cron + "next fire in …" for schedules; event keys for
  event triggers), enable/disable switch, edit, delete. "New trigger"
  opens a dialog: kind picker, then either the schedule form
  (name, cron, timezone, target picker, prompt or workflow + input) or the
  event form (workflow, event key from the catalog, filters). The cron
  field shows a live "next fire" preview (computed from the API response
  after save; client-side preview via a small cron helper if one already
  exists in the tree, otherwise omitted).
- **Editor page** (`workflows.$workflowId.tsx`) — a scoped Triggers panel
  next to the existing runs section, reusing the same list and dialog
  components with `workflowId` fixed.

New API client hooks in `packages/web/src/api/workflows.ts` following the
existing TanStack Query pattern, with invalidations from writes to the
aggregate list.

## Error handling

- Every 4xx from the new routes names the corrective action
  (CLAUDE.md rule). Example: invalid cron → "Invalid cron expression
  'x'. Use 5 fields, for example '0 9 * * 1-5'."
- Deleting a workflow that has triggers: triggers are deleted with it
  (schedules already disable on missing workflow; the delete route also
  removes them so the list does not show orphans).
- The scheduler already disables a schedule when its cron stops parsing or
  its workflow disappears; the UI shows disabled state.

## Testing

- API integration tests (existing pattern in `packages/api`):
  schedule CRUD round-trip incl. toggle and fire-now; event-trigger CRUD;
  aggregate read merges both kinds and honors `?workflowId=`; ownership
  scoping returns 404; invalid cron returns 400 with the corrective
  message; global runs endpoint ordering and limit.
- Service tests: `updateWorkflowSchedule` recomputes `nextFireAt`;
  fire-now does not advance `nextFireAt`.
- Web component tests beside the existing `-workflows.*.test.tsx` files:
  tab rendering, trigger list rows, new-trigger dialog validation.
- Full `make e2e` scorecard before the PR.

## Delivery

- Branch `conner/workflow-triggers-ui` off `dev-v2`, PR against `dev-v2`.
- Commits per discrete task; this spec is maintained in the same PR when
  the design shifts.
