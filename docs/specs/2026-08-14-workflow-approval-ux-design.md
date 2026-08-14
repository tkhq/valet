# Workflow approval UX — inline policy gates, approval scopes, policy-form typeahead

Status: approved design, not yet implemented.
Date: 2026-08-14.
Related: `2026-07-16-action-policies-audit-design.md` (policy engine, grants, audit),
the workflow node-completion plan (`tool` node), and the Phase 5 `approval` node.

## Problem

A workflow `tool` node that hits a `require_approval` policy fails today. The
enforcement path (`enforceWorkflowPolicy`, `packages/api/src/plugins/action-invoker.ts`)
returns `{ ok: false, error: "... requires an approval node or a runtime grant" }`,
the node checkpoints `failed`, and downstream nodes skip. The run settles as
failed. A policy-resolver database error fails the node the same way.

Three UX gaps follow:

1. A run cannot pause for approval unless the author added an explicit
   `approval` node upstream.
2. An approver cannot cover later `foreach` iterations of the same tool with
   one approval. The grant plumbing exists (`grantActions` →
   `onApprovalGrant` → run-scoped runtime grants) but no UI exposes it.
3. The policy forms in Settings (`policies-section.tsx`,
   `policy-overrides-section.tsx`) use free-text inputs for service and
   action ids. A typo silently creates a useless policy.

This spec covers workflow tool-node gates only. The explicit `approval` node
and the interactive-session gate card (`decision-gate-card.tsx`, which already
offers approve-once / approve-for-session / always-allow) are unchanged.

## Design

### 1. Contract: a third `invokeAction` outcome

`WorkflowInvokeActionResult` (`packages/workflow/src/engine-deps.ts`) becomes:

```ts
type WorkflowInvokeActionResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string }
  | { ok: false; requiresApproval: true; riskLevel?: RiskLevel;
      provenance?: PolicyProvenanceSource }
```

`enforceWorkflowPolicy` returns the `requiresApproval` member when the policy
decision is `require_approval` and no grant covers the invocation.

Fail closed to a pause: when policy resolution throws (for example, a database
error on the `action_policies` query), the host catches the error and returns
the `requiresApproval` member with `provenance: "resolver_error"` instead of
failing the node. This matches the session path's fail-closed posture. A
`deny` decision still returns `{ ok: false, error }` — deny is terminal, not
pausable.

### 2. Tool node: park on the approval signal

`executeTool` (`packages/workflow/src/nodes/tool.ts`) handles the new outcome:

1. Write the rendered params into the intent checkpoint's `effects`
   (`gateParams`, truncated to 8 KB with a `gateParamsTruncated` flag), plus
   `riskLevel` and `provenance`. The run page reads these to show what the
   approver is approving.
2. If the node sets `approvalTimeout`, compute and persist `timeoutAt` in
   `effects` on first park (read-back, do not re-read the clock — same rule
   as `wait` and `approval`).
3. Fire `onApprovalPending` once per park (keyed off "park state did not
   already exist"), carrying `{ runId, nodeId, service, action, params }` so
   existing notification delivery works unchanged.
4. Park on `{ kind: 'signal', signalType: 'approval:{nodeId}{iterationSuffix}' }`.
   The iteration suffix (same convention as `invocationId`) gives each
   `foreach` iteration its own independent gate.

On re-drive with a matching unconsumed signal:

- **Approved** → consume the signal and proceed to `invokeAction`. The
  approval wrote a covering grant first (section 3), so enforcement passes.
- **Denied** → honor the new per-node `onDeny` knob:
  - `'fail'` (default): node `failed` with a message that names the denier.
  - `'skip'`: node `completed` with `{ policyDenied: true, resolvedBy,
    note? }` so `fromOutput` edges can branch on the denial.
- **Timeout** (`timeoutAt` passed, no signal): treated as a denial with
  `resolvedBy: 'timeout'`, honoring `onDeny`.

New optional `ToolNode` fields (`packages/workflow/src/dag/nodes.ts`):
`onDeny?: 'fail' | 'skip'` and `approvalTimeout?: string` (duration,
validated at definition time like `approval.timeout`).

Signal consumption reuses `consumeSignalAndCheckpoint`, so resolution stays
atomic with the checkpoint write and crash+replay is safe.

### 3. Approval scopes are grants

Every approval writes a runtime grant before the resolution signal is sent, so
the retried `invokeAction` passes without a special "pre-approved" flag:

| Scope | Grant written | Covers |
| --- | --- | --- |
| `once` (default) | Invocation-scoped grant, keyed to the exact `invocationId` | This one invocation. The next `foreach` iteration gates again. |
| `run` | Run-scoped grant for `(service, actionId)` — the existing `onApprovalGrant` shape | All later iterations and any later node that calls the same action in this run. |
| `always` | Durable org-level `allow` policy via the existing session-gate write path (`pol:approval:{orgId}:{actionId}`) | Every future run and session, org-wide. Admin-only. |

Invocation-scoped grants are a new grant kind in the policies service. The
precedence core already checks grants at rung 2; the invocation-scoped kind
matches only when the candidate `invocationId` equals the grant's.

The resolution route `POST /api/workflows/runs/:runId/approvals/:nodeId`
grows optional body fields:

```ts
{ approved: boolean; note?: string; scope?: 'once' | 'run' | 'always';
  iteration?: number }
```

`iteration` disambiguates gated `foreach` children (the route suffixes the
signal type and signal id the same way the executor does). A non-admin caller
sending `scope: 'always'` receives 403 with an error that names the
corrective action ("Ask an org admin, or approve for this run."). The `always`
scope also writes the run-scoped grant so the current run resumes without
waiting for policy-cache effects.

Audit: the pending decision row keeps `resolvedMode: "require_approval"`;
resolution stamps `status: "approved"` or `"denied"`, plus `resolvedBy` and
`matchedGrantId`, through the existing `updateInvocationOutcome` path.

### 4. Run-page UI

- `run-detail-helpers.ts` learns to detect a run parked on a tool-node gate
  (signal wait on a `tool` node) and to surface `service`, `action`,
  `gateParams`, `riskLevel`, and `provenance` from the intent checkpoint.
- A `PolicyGateCard` (sibling of `ApprovalCard`,
  `packages/web/src/components/workflows/`) renders: `service.action`, a risk
  badge, collapsible params JSON (with a truncation notice when
  `gateParamsTruncated`), an optional note field, and the buttons
  **Approve once**, **Approve for rest of run**, **Always allow** (admin
  only), and **Deny**. `provenance: "resolver_error"` renders a warning that
  the policy engine could not be consulted.
- The run header shows a distinct "waiting for approval" state while parked,
  not "settled/failed".

### 5. Policy-form typeahead

A shared `ServiceActionCombobox` (`packages/web/src/components/settings/`)
replaces the free-text service and action inputs in both
`policies-section.tsx` (org policies) and `policy-overrides-section.tsx`
(per-user overrides).

- Data source: the existing `usePlugins()` query (`GET /api/plugins`), which
  returns every service with its actions and risk levels. No new endpoint.
- Service field: suggests services, each with an action-count badge.
- Action field: filters to the selected service; each item shows the action
  name and a risk-level badge.
- Free text stays allowed (an id can predate or outlive the installed plugin
  set); the combobox filters as the user types and supports keyboard
  navigation. Build on the existing Radix primitives (popover + input), in
  the spirit of v1's `TypeaheadCombobox`
  (`packages/client/src/components/settings/action-policy-dialog.tsx`).

### 6. Error handling summary

- Policy resolver throws → node parks with `provenance: "resolver_error"`
  (never fails the node for an infrastructure error).
- Denial → `onDeny` (`fail` default, `skip` opt-in).
- Gate timeout → denial with `resolvedBy: 'timeout'`.
- Non-admin `scope: 'always'` → 403 with corrective action.
- Malformed resolution payloads → 400 from the route; the parked node is
  untouched.

Note for operators: the screenshot failure that motivated this spec was the
`action_policies` SELECT itself throwing. In dev that usually means the PGlite
data dir predates the policies migration (pre-1.0 migrations edit `0000` in
place). Delete `~/.valet/pg` and restart the stack.

## Testing

- `packages/workflow` `tool.test.ts`: park on `requiresApproval`; resume on
  approve; deny with `onDeny: 'fail'` and `'skip'`; timeout; independent
  gates per `foreach` iteration; params truncation; crash+replay re-drive
  idempotency (no re-mint, no double `onApprovalPending`).
- Store conformance: iteration-suffixed approval signals.
- `packages/api` route tests: each scope writes the right grant/policy;
  non-admin `always` → 403; `iteration` disambiguation; audit rows stamped
  on resolution.
- Policies service tests: invocation-scoped grant matching in the precedence
  core; resolver-error fail-closed mapping.
- `packages/web` tests: `PolicyGateCard` scope buttons and admin gating;
  `ServiceActionCombobox` filtering, free text, keyboard navigation; both
  settings forms wired.
- Validation: clean `make e2e` scorecard.

## Out of scope

- Changes to the explicit `approval` node or the session gate card.
- Channel-based approval delivery beyond the existing `onApprovalPending`
  notification path.
- Param-matcher editing in the override form.
