# Workflow permissions preview + one-click pre-approval

Status: implemented.

## Problem

A workflow run is unattended. When a tool node's action resolves to
`require_approval`, the run parks on a policy gate until a person visits the
run page — without a deadline, unless the node declares `approvalTimeout`.
The author learns this only after the first run stalls. Nothing in the
editor says "this workflow cannot run unattended", and nothing lets the
author fix that ahead of the run.

## Decisions

### 1. Predict gates server-side, per tool node

`GET /api/workflows/:id/permissions` walks the stored definition's tool
nodes and resolves each `(service, qualified actionId)` with the same
`resolveActionPolicy` core the run-time invoker uses (`appliesIn:
"workflow"`, the caller's `userId`, no execution id). The prediction must be
server-side: org policies are readable only by org admins, so a member's
client cannot compute it.

Response: one entry per tool node — `nodeId`, `service`, `action`,
qualified `actionId`, `riskLevel`, `mode` (`allow` | `require_approval` |
`deny` | `unknown`), `provenance`.

Bounds of the prediction:

- Approval nodes are absent by design. An author-placed approval node is an
  intended gate, not a permission requirement.
- An action absent from the static plugin catalog (a dynamic MCP action)
  reports `mode: "unknown"`. Discovery (`resolveActions`) touches
  credentials, and a read endpoint must not.
- Param matchers evaluate against the node's static params. A template
  value (`{{ ... }}`) can flip a matcher at run time, so the prediction is
  advisory, not a guarantee.
- Sessions spawned by `session`/`orchestrator` nodes gate inside the child
  session with their own scope; their tool use is not statically knowable
  and is out of scope here.

### 2. Pre-approval writes bounded per-user overrides, not grants

There is no pre-run grant: `runtime_grants` are scoped to a live session or
execution and die with it. The existing self-service mechanism for "this
action may run without asking me" is the per-user policy override
(`action_policy_overrides`, precedence rung 2), whose write path
(`upsertOverride`) rejects an `allow` that would bypass an org
`deny`/`require_approval` policy.

`POST /api/workflows/:id/permissions/allow` writes one `allow` override per
gating action. Rules:

- The `(service, actionId)` set is derived server-side from the stored
  definition. The optional `actionIds` body field can only narrow it; an id
  outside the gating set is a 400. This is the same server-derivation rule
  that removed `grantActions` from the approval route (approval-UX spec,
  Deviations #3) — the client cannot mint an override for an unrelated
  action.
- Bounds-check rejections come back as `blocked: [{ actionId, reason }]`
  with HTTP 200: a partially satisfiable request writes what it can and
  names what it cannot.
- An override applies to every workflow and session of that user, not only
  this workflow. The UI copy states this before the write. A
  workflow-scoped rule would need `appliesIn` on the overrides table and a
  matcher change in the pinned resolution core; deliberately not done here.

### 3. UI: amber badges + a pre-approve dialog

- Per-node: `FlowNodeData.gate` (`require_approval` | `deny`) draws a
  shield badge on the canvas card — amber for a predicted gate (amber is
  the app's "the machine is waiting on you" signal), danger wash for an org
  deny. `unknown` draws nothing: badging the unpredictable would cry wolf.
- Per-workflow: the editor header shows an amber pill —
  "N action(s) need approval" — counting unique gating ACTIONS, not nodes.
  Clicking it opens a dialog that lists each qualified actionId with its
  `RiskBadge` and states the user-wide blast radius; confirm calls the
  bulk-allow route. Blocked actions render as a persistent notice under the
  header naming the org-admin corrective action.
- The permissions query key sits under `qkWorkflows.detail(id)`
  (`["workflows", id, "permissions"]`), so a definition save refetches the
  predictions with the detail.

## Wire

- `GET /api/workflows/:id/permissions` → `GetWorkflowPermissionsResponse`
- `POST /api/workflows/:id/permissions/allow`
  (`AllowWorkflowPermissionsRequest`) → `AllowWorkflowPermissionsResponse`

Both routes are owner-scoped like every other `/api/workflows/:id/*` route:
cross-owner access 404s.

## Files

- `packages/api/src/workflows/permissions.ts` — analysis + bulk allow.
- `packages/api/src/routes/workflows.ts` — the two routes.
- `packages/api/src/routes/workflow-permissions.test.ts` — route tests.
- `packages/web/src/api/{client,workflows}.ts` — client + hooks.
- `packages/web/src/components/workflows/editor/{flow-node,canvas,editor}.tsx`
  — badge + prop threading.
- `packages/web/src/routes/workflows.$workflowId.tsx` — header badge,
  dialog, blocked notice.

## Known limitations

- The prediction reads the STORED definition. An unsaved draft edit badges
  after the save (the detail invalidation refetches it).
- `unknown` actions are excluded from both the badge and the bulk allow; a
  run that reaches one can still gate on its resolved risk level.
- Team-owned workflows: the prediction and the overrides are for the
  CALLING user. A run started by a teammate resolves against that
  teammate's overrides.
