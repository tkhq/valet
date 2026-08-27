# Workflow approval UX — inline policy gates, approval scopes, policy-form typeahead

Status: implemented (2026-08-14).
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
3. The policy-override form in Settings (`policy-overrides-section.tsx`) uses
   free-text inputs for service and action ids; the org policy form uses bare
   `<select>` dropdowns. A typo in the override form silently creates a
   useless policy, and neither form shows risk levels while choosing.

This spec covers workflow tool-node gates only. The explicit `approval` node
and the interactive-session gate card (`decision-gate-card.tsx`, which already
offers approve-once / approve-for-session / always-allow) are unchanged,
except where the shared resolution route is hardened (section 5).

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

`WorkflowInvokeActionRequest` gains one optional field:

```ts
approval?: { resolvedBy: string; note?: string; via: 'signal' }
```

The tool node sets `approval` only when it holds an approved, unconsumed
resolution signal for this invocation (section 2). Enforcement honors it for
exactly that invocation: a `require_approval` decision with `approval` present
executes and audits `resolvedBy`. This is how "approve once" works — the
durable signal is the authorization; no grant row is written. The field is
host-internal (interpreter → invoker); it never crosses an HTTP boundary.

`enforceWorkflowPolicy` changes:

- Decision `require_approval`, no covering grant, no `approval` field →
  return the `requiresApproval` member. Do NOT persist this outcome in the
  `action_invocations` dedup table — a stored `requiresApproval` row would
  short-circuit the approved retry at `selectStoredResult` and never re-reach
  enforcement. Only `ok:true` and terminal `ok:false` results are stored.
  `parseStoredResult` must reject such a row defensively if one exists.
- Policy resolution throws (for example, a database error on the
  `action_policies` query) → return `requiresApproval` with
  `provenance: "resolver_error"`. Fail closed to a pause, matching the
  session path. This converts the motivating incident (failed SELECT → failed
  run) into a paused run.
- Decision `deny` → `{ ok: false, error }` as today. Deny is terminal, not
  pausable.
- `requiresApproval` + `approval` field + provenance `resolver_error` →
  execute. The human resolution is the authorization when the policy engine
  cannot be consulted. Without this rule, an approval that cannot write or
  read a grant re-parks forever and the sweep hot-loops on the unconsumed
  signal (15 s wake cycle, no progress).

### 2. Tool node: park on the approval signal

`executeTool` (`packages/workflow/src/nodes/tool.ts`) handles the new outcome.

**Park.** On `requiresApproval` with no matching resolution signal:

1. Write gate context into the intent checkpoint's `effects`: `gateParams`
   (rendered params, truncated to 8 KB, `gateParamsTruncated` flag),
   `riskLevel`, `provenance`, and — when inside a `foreach` — the iteration
   item value (`gateItem`, same truncation rule). Params re-render
   deterministically on re-drive (same upstream checkpoints), so the params
   the approver saw are the params that execute.
2. If the node sets `approvalTimeout`, compute `timeoutAt` once on first park
   and persist it in `effects` (read-back, do not re-read the clock — the
   `wait`/`approval` rule).
3. Fire `onApprovalPending` once, keyed off "gate effects did not already
   exist". This notification is best-effort: a crash between the effects
   write and the hook suppresses it (same window the approval node has); the
   run page is the source of truth.
4. Park on `{ kind: 'signal', signalType, timeoutAt }`. `timeoutAt` MUST be
   on the wait condition — both timeout drivers (`scheduleWake` and the
   sweep's `hasDueTimerWait`) read it from there, not from `effects`.

**Signal naming (pinned).** For a node at iteration `i`
(`iterationSuffix` = `""` at top level, `":{i}"` inside `foreach`):

- `signalType` = `approval:{nodeId}{iterationSuffix}`
- resolution `signalId` = `approval:{nodeId}{iterationSuffix}:resolution`

The route and the executor must use these exact strings. Each `foreach`
iteration gates independently.

**Resume.** On re-drive with a matching unconsumed signal:

- **Approved** → call `invokeAction` with the `approval` field set from the
  signal payload, then write the terminal checkpoint atomically with the
  consume via `consumeSignalAndCheckpoint`. Invoke-first, consume-second:
  `consumeSignalAndCheckpoint` only writes terminal checkpoints, and the
  invoker's dedup on `invocationId` makes the crash window (invoked, not yet
  consumed) safe — the re-drive re-invokes and receives the stored result.
- **Denied** → honor the per-node `onDeny` knob via
  `consumeSignalAndCheckpoint`:
  - `'fail'` (default): node `failed`, error names the denier.
  - `'skip'`: node `completed` with
    `{ approved: false, policyDenied: true, resolvedBy, note? }`.
- **Timeout** (`timeoutAt` passed, no signal) → denial with
  `resolvedBy: 'timeout'`, honoring `onDeny`; terminal checkpoint via
  `completeCheckpoint` (no signal to consume).

**`fromOutput` edges.** `booleanOutputOf` in the interpreter is extended for
tool nodes: a completed tool checkpoint is boolean-true unless
`result.policyDenied === true` (the skip result also carries
`approved: false` for the existing reader). This makes
`fromOutput: 'false'` edges activate on a skipped denial and
`fromOutput: 'true'` edges activate on normal completion.

New optional `ToolNode` fields (`packages/workflow/src/dag/nodes.ts`):
`onDeny?: 'fail' | 'skip'` and `approvalTimeout?: string` (duration,
validated at definition time like `approval.timeout`).

**`onApprovalPending`** grows optional fields:
`kind: 'approval' | 'policy_gate'`, `service`, `action`, `params`,
`iteration`. `prompt` becomes optional; for policy gates the host derives the
notification title as `Approval needed: {service}.{action}` and the body from
the workflow name + node id. The attention-row dedupe key MUST include the
iteration suffix (`{runId}:{nodeId}{iterationSuffix}`) — the current
`{runId}:{nodeId}` key would swallow every notification after iteration 1.
The existing attention `href` (`/workflows/runs/{runId}`) is the deep link;
channel deliverers get it for free and remain the mobile story for v1.

### 3. Approval scopes

The gate card offers three approve scopes and deny:

| Scope | Mechanism | Covers |
| --- | --- | --- |
| `once` (default) | The resolution signal itself (section 1's `approval` field). No grant row. | This one invocation. The next `foreach` iteration gates again. |
| `run` | Run-scoped runtime grant for the gated node's `(service, qualified actionId)`, derived server-side. | All later iterations and any later node that calls the same action in this run, regardless of params. |
| `always` | Durable org-level `allow` policy via the existing session-gate write path (`pol:approval:{orgId}:{actionId}`, qualified fqid), plus the run-scoped grant so the current run resumes immediately. Admin-only. | Every future run and session, org-wide. |

Grants sit at precedence rung 1 (below org deny, above everything else) —
unchanged. No invocation-scoped grant kind exists; `once` is signal-borne.

Audit: the enforcement pass that parks writes no terminal audit row. On
resolution, the invoker's normal outcome path stamps the row; the
`updateInvocationOutcome` status union widens to
`"completed" | "error" | "approved" | "denied" | "cancelled" | "timeout"`
and gains `resolvedBy`. Run cancellation while parked and gate timeout both
stamp their status from the settle/timeout path so no audit row is left
dangling.

### 4. Resolution route

`POST /api/workflows/runs/:runId/approvals/:nodeId` body:

```ts
{ approved: boolean; note?: string; scope?: 'once' | 'run' | 'always';
  iteration?: number }
```

Hardening (applies to approval-node resolutions too — shared route):

1. **Parked-gate check.** The route resolves the target node (searching
   `foreach` body nodes, whose ids do not appear in `definition.nodes`) and
   verifies the run is currently parked on exactly
   `approval:{nodeId}{iterationSuffix}` with no unconsumed resolution signal.
   Otherwise 409 (`Gate already resolved by {user}` / `Run is not waiting on
   this gate`). This kills pre-approval (resolving before params exist),
   resolution races that silently discard the loser's decision, and grant
   writes against settled or cancelled runs.
2. **Authorization.** Who may resolve: the run owner (user-owned) or any team
   member (team-owned) — today's `ownedRun` rule, now stated. The org for
   every grant/policy write comes from the run row, never the caller's
   session org, and the route asserts the caller is a member of the run's
   org. `scope: 'always'` additionally requires org admin; the admin check
   runs before any write (order: authz → grant/policy writes → signal
   insert). A non-admin sending `always` gets 403 naming the corrective
   action ("Ask an org admin, or approve for the rest of this run."), and
   nothing is written.
3. **Server-derived grants.** For `scope: 'run'`/`'always'`, the granted
   `(service, actionId)` comes from the parked node's definition — the
   free-form `grantActions` array is removed from the route body. (It was an
   unvalidated grant mint: any approver could smuggle grants for unrelated
   high-risk actions.) Consequence for explicit `approval` nodes: their
   resolutions can no longer mint grants — the executor's `onApprovalGrant`
   path stays but the route never feeds it. Blanket coverage now comes from
   a policy gate's `run` scope or an org policy.
4. **Humans only.** The agent-callable `workflows.resolve_approval` action
   refuses to resolve policy gates (`approval:{nodeId}` waits on `tool`
   nodes) and refuses to run at all from a workflow tool-node invocation
   context (the synthetic `wf:invoke:` session id) — a workflow must not
   approve its own or another run's gates. Its error names the corrective
   action ("A human must resolve this gate from the run page."). Policy-gate
   resolution is HTTP-principal-only by construction, not by prompt.
5. **Timeout.** After `timeoutAt` has passed, resolution returns 409
   `Gate timed out`.

The signal payload records `resolvedBy`, `note`, `scope`, and
`resolvedVia: 'web'` for the audit trail.

### 5. Run-page UI

**Wire.** `GetWorkflowRunResponse` gains `pendingGates[]`: one entry per
parked gate — `{ nodeId, kind: 'approval' | 'policy_gate', iteration?,
service?, action?, riskLevel?, provenance?, gateParams?, gateParamsTruncated?,
gateItem?, timeoutAt?, onDeny? }`. Selective fields, not raw checkpoint
`effects` (which carry invocation ids the client has no business seeing).
`ListWorkflowRunsResponse` items gain `needsApproval: boolean`, computed
server-side from the run's wait conditions.

**`PolicyGateCard`** (`packages/web/src/components/workflows/policy-gate-card.tsx`),
one card per pending policy gate — the page renders all of them, not the
first. Visual language: the session gate's amber treatment
(`border-amber-300 bg-amber-50/70`, dark variants) — amber is the app's
"the machine is waiting on you" signal. The author-placed `ApprovalCard`
stays plain paper; the two being distinct is a feature.

```
┌─ amber card ─────────────────────────────────────────────────────────┐
│ (!) POLICY GATE · RUN PAUSED                                         │
│     linear.save_issue  [high]            Gated by an org policy.     │
│                                                                      │
│ │ Policy check failed — approval requested as a safe fallback.       │  ← resolver_error only
│                                                                      │
│ ▸ Parameters (2.1 KB)          ▸ Item 4 of 12: {"title": …}          │  ← native <details>;
│                                                                      │    item row only in foreach
│ [ Optional note…                                            ]        │
│                                                                      │
│ [ Approve once │ ▾ ]        [ Deny ]     Iteration 4 · times out 2h  │
└──────────────────────────────────────────────────────────────────────┘
```

- **Split-button, not four peers.** Left segment: primary `Approve once`
  (safe default, `rounded-r-none`). Right segment: chevron opening the
  existing `DropdownMenu` with:
  - **Approve for rest of run** — sublabel: "Covers every later call to
    {service}.{action} in this run ({N} foreach iterations remain)." N comes
    from the foreach source length in checkpoints; the sublabel states that
    coverage is param-blind.
  - **Always allow** — sublabel: "Writes an org-wide allow policy." Opens a
    confirm step naming the blast radius ("Allows {action} for every user
    and run in this org") with a link to the org policies settings page
    where it can be revoked. Non-admin: item disabled with inline
    "(org admin only)" suffix; `isAdmin` fails closed while `useMe()` loads.
- **Deny** is a separate `danger` button with a visible gap — never a third
  segment (a misclick between approve and deny must be impossible).
  Microcopy under the row, driven by the node's `onDeny`: "Denying fails
  this node." / "Denying skips this node; downstream nodes can branch on the
  denial."
- **States.** Pending (as drawn; `timeoutAt` renders "times out in
  {relative}"); busy (buttons disabled, spinner in the pressed one); raced
  (mutation 409 → "This gate was already resolved. Refreshing…" +
  invalidate `useRunDetail`; the page polls at 5 s, so refetch on error
  too); other errors surface the server's message (which names the
  corrective action per repo rule). `provenance: "resolver_error"` renders
  the degraded-policy warning line.
- **Resolved.** The card unmounts on refetch; the resolution stays legible
  on the checkpoint row: "Approved (rest of run) by {resolvedBy} · {note}" /
  "Denied by {resolvedBy}" / "Timed out". A deny-skipped checkpoint renders
  as a denial chip, never as a green success.

**RiskBadge** (new, shared with the combobox): `low` neutral, `medium`
`bg-amber-500/15 text-amber-700`, `high` `bg-orange-500/15 text-orange-700`,
`critical` `bg-danger-500/15 text-danger-600` (dark variants alongside;
numeric amber/orange scales are available per the Tailwind config note).

**Run status.** A `RunStatusChip` replaces the raw status span in the run
header: parked on a gate → amber "Needs approval"; parked otherwise →
neutral "Waiting"; running → moss "Running"; settled → existing outcome
badge. The runs drawer pill uses the same amber "needs approval" state via
`needsApproval`. Detection lives in one helper
(`findPendingGates(run)` in `run-detail-helpers.ts`) that recognizes both
approval-node and tool-node gates; header, cards, and `statusByNodeId` key
off it.

### 6. Policy-form typeahead

A shared `ServiceActionCombobox`
(`packages/web/src/components/settings/service-action-combobox.tsx`)
replaces the service/action inputs in `policies-section.tsx` (currently bare
`<select>`s) and `policy-overrides-section.tsx` (currently free text).

- **No new dependency.** The repo has no Radix Popover and no cmdk; the
  option set is tens of items. Port v1's hand-rolled input + positioned
  listbox (`TypeaheadCombobox`, `packages/client/.../action-policy-dialog.tsx`)
  restyled to v2 tokens (`border-line bg-paper shadow-lg`, `bg-ink-wash`
  highlight).
- Data source: the existing `usePlugins()` query (`GET /api/plugins`). No new
  endpoint.
- **Two flat modes, no cascade.** The v2 target model is exactly-one-of
  `service | actionId | riskLevel`, so an action target has no selected
  service to filter by. Service mode: rows show display name, mono id, and
  an action-count badge. Action mode: rows show action name, the full mono
  fqid (`service.action` — the service rides in the row), and a `RiskBadge`.
  Risk-level targets keep the plain `<select>`.
- **Interaction.** Focus opens the full list (parity with the `<select>` it
  replaces); typing filters case-insensitively on label + id. Arrow keys
  move the highlight (free-text row included), Enter selects, Escape closes,
  Tab/click-outside commits typed free text. ARIA combobox/listbox roles
  with `aria-activedescendant` (v1 skipped this; do not).
- **Free text stays allowed** — pinned last row, visibly labeled:
  `Use "{query}" — not in the installed catalog`. Empty state: `No matches
  for "{q}". Press Enter to use it as a literal id.` Loading state: spinner
  row; free text still committable.

### 7. Error handling summary

- Policy resolver throws → node parks, `provenance: "resolver_error"`; the
  card shows the degraded warning; an approved resolution executes on the
  signal's authority (section 1) instead of livelocking.
- Denial → `onDeny` (`fail` default, `skip` opt-in with a boolean-false
  output).
- Gate timeout → denial with `resolvedBy: 'timeout'`; late resolutions 409.
- Resolution of a non-parked/already-resolved gate → 409 with the prior
  decision when known.
- Non-admin `scope: 'always'` → 403 with corrective action; nothing written.
- Agent/self resolution of a policy gate → refused with corrective action.
- Malformed resolution payloads → 400; the parked node is untouched.

Note for operators: the screenshot failure that motivated this spec was the
`action_policies` SELECT itself throwing. In dev that usually means the PGlite
data dir predates the policies migration (pre-1.0 migrations edit `0000` in
place). Run `make dev-clean` and restart the stack.

## Testing

- `packages/workflow` `tool.test.ts`: park on `requiresApproval`; approved
  resume passes the `approval` field and invoke-then-consume order; crash
  between invoke and consume re-drives through invoker dedup; deny with
  `onDeny: 'fail'` and `'skip'`; skip result activates `fromOutput: 'false'`
  and completion activates `'true'`; timeout fires via the wait condition's
  `timeoutAt`; independent gates and signal names per `foreach` iteration;
  params/item truncation; no double `onApprovalPending`; `resolver_error`
  approve executes.
- Interpreter tests: `booleanOutputOf` tool-node extension.
- `packages/api` route tests: parked-gate 409s (pre-approval, double
  resolution, settled run, timeout); org-from-run-row and cross-org
  rejection; non-admin `always` → 403 with nothing written; server-derived
  `run` grant uses the qualified fqid; `foreach` body-node lookup +
  `iteration` suffixing; agent/self resolution refused; audit rows stamped
  approved/denied/cancelled/timeout with `resolvedBy`.
- Invoker tests: `requiresApproval` never stored in `action_invocations`;
  `parseStoredResult` rejects a legacy stored one; `approval`-field
  execution audits `resolvedBy`.
- `packages/web` tests: `PolicyGateCard` split-button scopes, admin gating
  (fail-closed during load), always-allow confirm, raced-409 state, deny
  microcopy per `onDeny`, multiple simultaneous gates; `RunStatusChip`
  mapping; `ServiceActionCombobox` filtering, free-text row, keyboard nav,
  ARIA; both settings forms wired.
- Validation: clean `make e2e` scorecard.

## Out of scope

- Changes to the explicit `approval` node's executor or the session gate
  card (the shared resolution route hardening in section 4 does apply to
  approval-node resolutions).
- Channel-based approval delivery beyond the existing attention `href` deep
  link.
- Param-matcher editing in the override form; param-bound grants (run-scope
  coverage is param-blind and the UI says so).
- Org-admin break-glass resolution of user-owned runs.


## Deviations

1. **gateItem / "Item N of M" / remaining-iteration count not yet rendered.**
   The wire ships `gateItem` from the intent checkpoint effects. The run-page
   card does not yet render it as "Item N of M" or a remaining-iteration count.
   Wire the UI in a follow-up.

2. **409 copy differs from spec strings in one route.**
   The resolution route returns `"this approval gate has already been resolved"`.
   The spec used "already resolved" (lowercase, no article). The route copy is
   the authoritative string; the UI card detects 409 by HTTP status, not by
   matching message text.

3. **Approval-node resolutions no longer mint grants.**
   The `grantActions` field is removed. The route rejects any request that
   includes it with a 400. Scope `"run"` and `"always"` write a runtime grant
   only for tool-node (policy gate) resolutions. Approval-node resolutions use
   the signal as the authorization for that one invocation; no grant row is
   written.
