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
nodes — including a `foreach` node whose body is a tool node, which gates
at run time exactly like a top-level one — and resolves each `(service,
qualified actionId)` with the same precedence core the run-time invoker
uses (`resolvePolicyDecision` over one `loadPolicyRows` snapshot,
`appliesIn: "workflow"`, the stored workflow's team scope or the caller's personal scope, no execution id). A
foreach-body action is attributed to the foreach node's id, the card the
editor draws. The prediction must be server-side: org policies are readable
only by org admins, so a member's client cannot compute it.

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

- Team workflows return HTTP 400 without writing overrides. The error directs the caller to a team admin and Settings → Policies.
- Team previews include that team's policies and exclude personal overrides. The stored workflow supplies the team ID after authorization.
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

The assistant reads the same prediction through the `workflows.get_permissions`
action (risk level `low`). It reads the definition with the assistant's owner,
so it applies the same owner check and returns the same `nodes`, plus
`unchecked`: the agent and sub-workflow steps whose actions are checked only
when they run. Without it, the assistant saw only the definition and told users
that steps an org policy allows still needed approval.

Two node fields say where the policy mode alone is not the answer. The mode
reads a template parameter literally, as a workflow grant does. When a policy or
override for the action matches on a parameter the step fills in at run time,
the node carries `runtimeParams: true`, because the run can resolve differently
once it renders the value. Matcher paths parse the way the matcher reads them,
so `to[0]` overlaps a templated `to`, and the whole-object path `""` overlaps
every template. On a team workflow, `sharedAccount: true` marks a step whose
team has no live connection of its own for the service while a current member
shares one (`membersSharing`; never GitHub, which the invoker never borrows). A
dead team connection (`isDeadConnection`) does not count, because the invoker
skips it for a share. The invoker may then ask that member on every run. It
does not when the person who starts the run shares their own account, or when a
team 1Password item covers the service. The check reads credential and share
rows only, so the preview reads no secret, no vault, and refreshes no token.

## Files

- `packages/api/src/workflows/permissions.ts` — analysis + bulk allow.
- `packages/api/src/routes/workflows.ts` — the two routes.
- `packages/api/src/workflows/actions.ts` — the `workflows.get_permissions` assistant action.
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
  run that reaches one can still gate on its resolved risk level. That run's
  approval card can allow it for later runs (see "Run approval card for a Tool
  step").


## Run approval card for a Tool step (2026-10-20)

A Tool step that policy holds parks the run and shows an approval card on the run page. The card puts **Approve once** first, as the primary button, with **Approve for rest of run** in its menu. **Approve and stop asking** is a secondary button after it. Its confirmation says that Valet runs the action now and that later runs of this workflow run it without asking, until someone changes the steps or resets saved permissions. When the rendered parameters have a `name`, `title`, `subject` or `summary` text field, the card shows it above the raw parameters (`actionParamsLabel` in `@valet/shared`). The approval notification title adds it: `Approval needed: linear.save_project for "<name>"`. Slack renders the title as markdown, so the title puts a space after `]` to keep `[text](url)` in a parameter from becoming a link.

Approve and stop asking sends scope `workflow`. `resolveWorkflowApproval` saves a workflow grant through `prepareWorkflowPermissions`, which grants only actions the review reports as gating. The review reports a Tool step's dynamic action, which includes every MCP action, as `unknown`, so before this change the card always returned 403. The run already resolved that action, and the gate's checkpoint records the policy source in `effects.provenance`. When that source is `risk_default` or `plugin_default`, the card's workflow scope now grants exactly the parked step's action, also in a foreach body. Before it saves, the server reads the current rules again with the risk the gate recorded. An org or team rule or an override added since the run parked refuses the grant, including a rule on any parameter. The owner or team admin rule, the step check, and the definition lock still apply. For any other source (org policy, team policy, override, resolver error), the card still returns 403 and writes nothing. At run time an org or team rule and a personal override still win over a workflow grant (`resolvePolicyDecision`).

The review keeps showing such a step as "Checked at runtime". Reset saved permissions removes the grant, and any step change revokes it.

## Explicit build-time approval (2026-10-18)

A save allows nothing. This covers a browser save, an assistant save, a copy, a team copy and a template install. A review of the 2026-10-16 design showed why. An assistant turn that read untrusted content could save a workflow that sends mail to an attacker and then start it, and the save counted as the person's approval. One unrelated human save could also grant steps that someone else added.

A person allows a workflow's steps explicitly, once, when it is built, in one of two ways:

- The workflow page's Review permissions dialog. When any step needs approval, or the viewer has a shared account the workflow would use without their consent, a banner above the steps says so and opens the dialog.
- `workflows.allow_permissions`, an editor-assistant action. It shows one approval card that lists each step that needs approval with its exact parameters, the viewer's shared accounts, and any action an explicit policy still holds. The workflow name appears on one line, cut to 80 characters. Only the person's own signed-in prompt can call it. The card names that person as its approver (`context.approver`), so `answersGate` refuses everyone else, including a team API key, which records its minting admin as the resolver. Agent credentials cannot answer an approval card. Save results (`save_workflow`, `patch_workflow`, `update_model`, `add_aggregate`) list `needsApproval` and tell the assistant to call it once. The `workflows.resolve_approval` card names its approver the same way.

Both paths call `allowWorkflowPermissions` with the review token of the definition that was shown. Action grants need the workflow owner or a team admin. A member can allow only their own shared accounts.

A grant covers the steps that were reviewed. Any step change revokes action grants and account consent, whoever makes it. A layout-only change keeps them. The policy lookup (`loadPolicyRows`) also refuses a workflow grant to a run whose steps differ from the saved steps, so a run that started before an edit does not use a grant made after it.

For team workflows, an approval also allows the approving person's accounts already shared with that team for the declared tool and agent-step services, excluding GitHub. This includes services with dynamic tools and foreach tool bodies. `workflow_account_grants` binds consent to the organization, workflow, team, member, service and share generation. It does not grant team-wide account consent. Another member approves their own account. Human review nodes remain explicit decisions. The review's `accountConsent.pending` lists the viewer's own shared services that still need consent.

Saved workflow consent applies to direct tool invocation contexts and to agent steps for the services they list (`2026-10-17-agent-step-workflow-grants-design.md`). Sandbox scripts keep their existing separate account approval paths.

A run's account gate also offers the lender "Always allow for this workflow".
It needs the lender's signed-in browser answer. It saves the same
`workflow_account_grants` row for that one service, only while the run's steps
match the saved definition, and only for the share generation the card showed.
Otherwise it returns `stale_workflow` or writes nothing. "Always allow for this
team" stays the wider choice.

Borrowing checks the live run owner, actor, team membership, source account,
share generation, and saved definition. A run with different steps cannot use
this consent.

Definition saves, snapshots, revocation, and new grants commit together under
the definition lock. The Review permissions action also authorizes the person's
shared accounts, including when no action needs a policy grant. Reset saved
permissions removes both kinds of grant. A member can also stop use of their own shared accounts without resetting action permissions or another member's consent. Existing workflows are not silently
backfilled, and parked approval gates are not answered during deployment.

The application schema repair adds the grant table and lookup index without
deleting existing folders, workflows, credentials, or approval history.

Permission review returns a definition token for the exact stored graph, ownership, and credential-service scope shown. The dialog displays the named team and complete direct-tool service scope, including allowed and dynamic actions, and keeps that scope and token while open. Confirmation checks it under the definition lock before saving action or account grants. Missing tokens fail closed; changed definitions return a conflict and require a fresh review.
