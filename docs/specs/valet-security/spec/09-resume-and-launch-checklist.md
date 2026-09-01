# Part 09: Resume from Terminal and Pre-Launch Checklist

*Depends on: Part 00, Part 01, Part 04, Part 05, Part 06, Part 08. Conformance: L1+ (server-side gates and route behavior); L3 pulls in the pivot round.*

## Purpose

Two user-visible gaps in v0/v1:

1. **Terminal-state trap.** An engagement can reach a terminal state (`completed` / `failed` / `cancelled`) with unresolved `security_needs.status = 'open'` rows. The flat needs surface (M-P4c, `POST /needs/resolve`) only reopens a cell that is still `pending`/`running`. A human answer that arrives after close lands in a dead engagement.
2. **No pre-launch gate.** The setup wizard's step 3 ("Review") is a passive summary; hitting "Start review" fires `POST /api/sessions` immediately. The base design's `sec_start` approval gate lives in the runner chat pane, which is not visible on the Configure Review page. A user launching a live-testing plan with no scope, no login URL, and no admin credential is not told the review will pause N times to ask.

This part pins:

- A resume contract that reopens a terminal engagement, resets only the affected cells, and re-dispatches through the existing runner loop.
- A **Launch checklist** that replaces the passive Review step with active warnings and an explicit authorization affirmation.
- A schema extension to `SecurityScope` (`login_url`, `signup_url`, `rate_limit_rps`) so the setup page can pre-supply what the live cells will otherwise pause for.

## Vocabulary

**Resumable engagement.** A terminal engagement (`status ∈ {completed, failed}`) that carries at least one open need (`security_needs.status = 'open'`) OR at least one failed cell (`security_cells.status = 'failed'`). Cancelled engagements are NOT resumable; a cancel is a decision the user made.

**Resume affected set.** The set of cells the resume flow resets to `pending`. Default: the union of every cell that surfaced an open need + every cell whose status is `failed`. An admin caller MAY pass an explicit subset.

**Late needs answer.** A `POST /security/needs/resolve` call on an engagement whose current status is `completed | failed`. Triggers an implicit resume of the answering cell before applying the answer.

**Launch checklist.** The third step of the setup wizard. Replaces the passive Review step (`packages/web/src/routes/security.new.tsx::ReviewStep`). Renders a scoped checklist with warnings, credential expectations, and an authorization checkbox.

## Global invariants

**INV-8 (Resume never crosses cells that were `completed`).** Resume MUST NOT touch a cell whose status is `completed`. The resume affected set is a strict subset of `{failed cells} ∪ {cells with open needs on this engagement}`. A cell that ran to completion stays completed; the runner extends findings, it does not rewrite history.

**INV-9 (Resume preserves finding history).** Every `security_findings` row from the original run stays exactly as it was. A resumed cell that emits new findings appends to the row set; it MUST NOT delete or edit prior rows. This is the same finding-count monotonicity rule as Part 07 §7.1 applied to the new "resume mode" dispatch.

**INV-10 (Cancel is terminal).** A `cancelled` engagement is unresumable. The user affirmed a stop; the resume flow refuses with a corrective error naming the cancel.

**INV-11 (Launch is a required affirmation).** The launch step's authorization checkbox is a client-side gate. The server also stamps `security_engagements.authorized_at` on the create so an audit trail exists.

## Resume contract

### Trigger paths

The resume flow enters through one of three surfaces:

1. **Explicit `Resume review` button** on the engagement panel. Available when the engagement is `completed | failed` AND `resumable === true` (see below).
2. **Late needs answer**. `POST /security/needs/resolve` on a terminal engagement runs the resume flow FIRST, then applies the answer, in one server-side transaction. The old flat-needs surface stays wired.
3. **Explicit re-dispatch of a single cell** (advanced). `POST /security/dispatch` with `{cellId, mode: "resume"}` on a `failed` cell of a terminal engagement implies a resume of that cell only; server confirms the engagement flips to `running` before dispatching.

### Server-side steps

`POST /api/sessions/:id/security/resume` accepts:

```ts
{
  cellIds?: string[];        // optional; default = failed ∪ open-need
  reason?: string;           // optional audit note
}
```

Steps (one transaction):

1. Load the engagement. If `status` is `planning | running`, return 409 with `already-in-progress`. If `status` is `cancelled`, return 409 with `cancelled-is-terminal` (INV-10).
2. Compute the resume affected set:
    - When `cellIds` is present, verify every id is a `security_cells` row belonging to this engagement AND its status is `failed` OR its status is `completed | yielded` with an open need. Any id outside this rule triggers a 400 naming it.
    - When `cellIds` is absent, compute `failed ∪ (completed | yielded WHERE any open need)`.
    - Reject with 409 `nothing-to-resume` when the set is empty.
3. Flip every affected cell's status to `pending`. Clear `settled_at`, keep `attempts` (so the counter reflects the total history). Preserve `child_session_id` for the audit trail (a new dispatch will overwrite it).
4. Flip `security_engagements.status` from `completed | failed` to `running`. Stamp `resumed_at` (new column).
5. Emit `security.engagement.resumed` event on the session's wire so the panel refreshes.
6. Return `{status: "running", resetCellIds: [...], nextRunAt: <ms>}` and nudge the runner (`SecurityRunnerDriver` on next tick, or an immediate `submitSessionPrompt` "call sec_status now").

The runner cell then proceeds through its normal loop: `sec_status` finds pending cells, dispatches, waits for settle, closes when settled. `sec_close` fires again once every cell terminates. A subsequent `POST /security/resume` may fire again if further needs surface.

### `security_engagements.resumed_at`

New nullable `BIGINT` column. First resume stamps it. Subsequent resumes overwrite (the last resume time is what surfaces on the panel banner). NULL on engagements that never resumed.

### `security_engagements.authorized_at`

New nullable `BIGINT` column. Stamped by the create route when the client passes `securityConfig.authorizedAt`. Present iff the user checked the affirmation. NULL on engagements created before this spec landed.

## Late needs answer

`POST /api/sessions/:id/security/needs/resolve` behavior extends:

- **Engagement is `planning | running`:** existing behavior. Reset the answering cell(s) to `pending`, re-dispatch, done.
- **Engagement is `completed | failed`:** transactionally:
    1. Invoke `resumeEngagement({cellIds: [<the cell(s) that answered>]})`. Server confirms every answering cell is either `failed` or `completed | yielded` with the answered need open; any other case rejects the whole call with 409.
    2. Apply the answer (write `security_needs.status = 'answered'`, store the resolution).
    3. Return `{engagementStatus: "running", resetCellIds: [...], resumed: true}`.
- **Engagement is `cancelled`:** refuse with 409 `cancelled-is-terminal`.

Idempotence: a second call with the same answer body no-ops (returns the same shape but with `resumed: false` and empty `resetCellIds`) so a double-click does not double-reset.

## Web UX

### Resume banner on the engagement panel

`EngagementPanel` (`packages/web/src/components/security/engagement-panel.tsx`) shows a banner above `ReviewSummary` when the engagement is terminal AND `resumable === true`. Copy shape:

```
This review closed with N unresolved need(s) and/or M failed cell(s).
Resume to re-run those cells with the input you provide.
[Resume review]
```

- Banner style: `border-warning-500/30 bg-warning-500/10 text-warning-700`.
- The button is admin-gated (`canAdminister`). A non-admin sees the banner but not the button; a note tells them to ask a session admin.
- On click: `POST /security/resume` with no `cellIds` (default set). On success, poll interval speeds up to 2s until `status` flips to `running` (query invalidation).

### Auto-resume on late needs answer

`NeedsSection` today posts to `POST /security/needs/resolve` and shows the resolution. When the engagement is terminal, the panel:
1. Shows a small yellow note under the answer form: "This review has closed. Submitting will reopen it and re-run this cell."
2. On submit, the same resolve route is called. The server transparently resumes; the response's `resumed: true` triggers a manifest refresh + a "Reopened" toast.

### Launch checklist (setup wizard step 3)

`ReviewStep` in `packages/web/src/routes/security.new.tsx` becomes `LaunchStep`. Sections top-to-bottom:

1. **Scope confirmation.** Repository, ref, model, method (preset id + label).
2. **Focus + invariants + categories.** Read-only cards, same as today.
3. **Personas that will run.** Grouped by kind (source / live / coordination / deliverable) with the D chip on deterministic cells. Cell count and triad expansion count noted.
4. **Live testing** (renders only when the plan carries any live persona):
    - Authorized scope hosts. When empty → red block, disables Start.
    - Login URL. Optional but strongly recommended.
    - Signup URL. Optional; only relevant to L4 `create-test-account`.
    - Rate limit. Optional; defaults to a conservative value at runtime.
    - Credential expectations list: "DAST will likely ask you for admin credentials mid-run", "Fuzz will likely ask you for test data (payment card)". Each item shows a green check when a login URL is set OR a stored session already exists, yellow warn otherwise.
5. **Authorization affirmation.** Required checkbox: "I confirm I have authorization to test the hosts above." Applies to source-only reviews too, though the wording relaxes to "I confirm I have authorization to scan this repository."
6. **Start review** button. Disabled unless:
    - `planError === null`.
    - `scopeError === null` (Part 08's rule: any live persona requires ≥ 1 host).
    - `authorizationConfirmed === true`.

The step indicator label changes from "Review" to "Launch". `StepIndicator` picks up the new label.

### Wire additions

- `CreateSessionRequest.securityConfig.scope` extends to `{hosts, cidrs?, loginUrl?, signupUrl?, rateLimitRps?}`. `hosts` stays the only required subfield when the object is present.
- `CreateSessionRequest.securityConfig.authorizedAt: number` ;  client-supplied UTC ms when the affirmation was checked. Server MAY reject a value more than 24h old.
- `SecurityEngagementWire.authorizedScope` extends to include the new subfields.
- `SecurityEngagementWire.resumable: boolean` ;  server-computed from `status` and the open-needs / failed-cells set. Cached on the row for fast reads.
- `SecurityEngagementWire.resumedAt: number | null`.
- `SecurityEngagementWire.authorizedAt: number | null`.

### API route additions

- `POST /api/sessions/:id/security/resume`. Admin-gated (`resolveToolSession` "mutate" ladder). Request/response shape §Resume contract §Server-side steps.
- `POST /api/sessions/:id/security/needs/resolve` (existing) grows the late-answer branch.

## Config schema extensions

`SecurityScope` (in `packages/plugin-security/src/lib/config.ts`):

```ts
export interface SecurityScope {
  hosts: string[];                 // required, non-empty when scope present
  cidrs?: string[];                // optional; feeds scope-auto-include (Part 05 §5.5)
  login_url?: string;              // optional; feeds pivot-coordinator resolve mode
  signup_url?: string;             // optional; feeds create-test-account (L4)
  rate_limit_rps?: number;         // optional; integer 1..1000
}
```

`parseSecurityConfig` validates every new field. An out-of-range `rate_limit_rps` throws a corrective error naming `.valet/security.yml`. Existing configs (no new fields) parse unchanged.

`normalizeScopeHost` is unchanged; the two URL fields carry a full URL and stay as-is.

### Wire additions for scope

`SecurityScope` on the wire mirrors the plugin type. `POST /security/config` and `PUT /security/plan` remain the routes that mutate scope; both accept the new subfields with the same validation rules.

## Interaction with the pivot round (v1 spec Part 05)

The resume contract in this part addresses the FLAT needs surface (M-P4c), which ships today and is the mechanism the user's two runs got stuck in.

Once the pivot round runtime ships (follow-up PR A, Part 05), the pivot flow *is* a supported form of resume:

- Discover mode surfaces one consolidated ask.
- Resolve mode writes `pivot.yml` and materializes `mode: post-pivot-delta` cells.
- Those delta cells go through the same runner loop and settle.

If the pivot round yields but the human answers after the engagement settled (edge case: the human closed the tab), the resume contract in this part still applies ;  the pivot-coordinator cell is `yielded`, so it enters the resume affected set, and a late answer reopens the engagement. The pivot resolve mode then runs.

## Auto-resume for the runner driver

`SecurityRunnerDriver` today nudges when the runner session is live and no cell is `running`. After a resume:

1. The engagement flips to `running` and one or more cells flip to `pending`. `SecurityRunnerDriver`'s tick sees "no cell is running" (correct) AND "the runner has no unsettled submission" → nudge fires. The runner cell reads `sec_status`, sees the pending cells, dispatches. Same loop, no changes needed.
2. The stall cap is per-engagement in-memory. A resume DOES NOT reset the stall counter; a stuck runner post-resume still pages a human after N no-progress ticks.
3. `security_engagements.resumed_at` provides observability. `valet.security.runner.resumed` metric fires on each resume; monitoring alerts on repeated resumes of the same engagement.

## Test coverage

**Plugin (`packages/plugin-security/src/lib/config.test.ts`):**
- `parseSecurityConfig` accepts `scope.login_url`, `scope.signup_url`, `scope.rate_limit_rps`. Rejects `rate_limit_rps: 0` and `1001`.

**API (`packages/api/src/services/security-engagements.test.ts` and route tests):**
- `resumeEngagement({cellIds: [...]})` on `completed` engagement flips status, resets cells, keeps completed cells untouched.
- Refuses on `cancelled` (INV-10).
- Refuses on `planning | running`.
- `resumeEngagement` with an empty affected set returns 409 `nothing-to-resume`.
- Late needs answer on `completed` engagement transparently resumes and applies.
- Idempotence: repeat call no-ops.

**Web (`packages/web/src/components/security/engagement-panel.test.tsx` and route tests):**
- Resume banner renders iff `resumable === true` AND engagement is terminal.
- Admin gate hides the button for non-admins.
- Launch step:
  - Disables Start review until authorization affirmation is checked.
  - Renders credential expectations for a live-plan.
  - Highlights missing login URL as a warning.
  - Uses "Launch" as the step-indicator label.

## Conformance

**L0:** No changes. The kernel does not touch orchestration.

**L1+:** `POST /security/resume` MUST exist. `security_engagements.resumable` MUST be true iff the engagement is terminal AND (`open_needs_count > 0` OR `failed_cells_count > 0`). The launch checklist MUST require the authorization affirmation before enabling Start review.

**L2+:** Late-needs answer MUST transparently resume when the engagement is terminal.

**L3+:** Resume interacts with `mode: post-pivot-delta` cells the same way it does with `mode: fresh` and `mode: resume`. The affected-set membership rule is unchanged.

**L4:** No additional gate. The three anti-cap checks (Part 07) apply to a `post-pivot-delta` cell regardless of whether the enclosing engagement was resumed.

## Spec deviations recorded

`security_engagements.status` transitions grow one edge: `completed | failed → running` via `resumeEngagement`. This is the ONLY route that reopens a terminal engagement. `sec_close` remains the only route that closes one.

Cancelled is unresumable by design. If the user wants to re-run a cancelled review, they create a new engagement (or re-scan via the existing `Re-scan` flow).

`security_cells.status` grows one edge for the resume flow: `failed → pending` and `completed → pending` (only when the cell has an open need). The runner's dispatch loop does not distinguish ;  a `pending` cell is dispatched, whichever way it got there.
