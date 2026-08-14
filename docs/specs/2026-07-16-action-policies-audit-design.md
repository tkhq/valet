# Action Policies + Audit Log Design — the v2 policy engine

**Date:** 2026-07-16
**Status:** Implemented (branch `feat/action-policies`, pending final whole-arc review + PR)
**Scope:** Full-parity port of the legacy policy engine onto v2's seams: durable org `action_policies`, ephemeral `runtime_grants`, per-user `action_policy_overrides`, param matchers, and the `action_invocations` audit trail with policy provenance — enforced at the engine's plugin-catalog approval seam and the workflow action invoker, surfaced in org-admin settings (Policies + Action Log) and per-user settings (my overrides, my grants).

## Context

v2 already has the enforcement floor; it lacks the policy layer above it:

- Every `PluginAction` **must** declare `riskLevel` (`packages/engine/src/plugin-catalog.ts:44`; `RiskLevel = low|medium|high|critical`). `approvalModeFor` (`plugin-catalog.ts:464`) derives `allow|require_approval|deny` from `ActionPlugin.defaultApprovalMode` or risk level (low/medium→allow, high/critical→require_approval).
- `call_tool` (`plugin-catalog.ts:402-422`) already enforces: `deny` → refusal, `require_approval` → opens a real decision gate via `ctx.requestDecision` and blocks on resolution. Gates are restart-safe (deterministic ids, short-circuit replay) and already fan out to every gate consumer (web today; Telegram inline buttons and the CLI per their specs).
- The workflow path (`packages/api/src/plugins/action-invoker.ts`) has a durable `action_invocations` dedup table and explicitly rejects `requestDecision` (approval nodes are the workflow answer).
- `ToolDef.requiresApproval` exists but is consumed nowhere — dormant.
- There is **no** policy table, no grants, no overrides, no admin UI, and the live-turn path records no invocations.

Legacy reference: `packages/worker/src/routes/action-policies.ts`, `runtime-grants.ts`, `schema/actions.ts` on `main`.

## Decisions (locked)

1. **The engine gains a `PolicyResolver` port (host-provided, like stores) — the ONLY engine change besides audit emission.** `resolve(input): Promise<PolicyDecision>` with `input = { service, actionId, riskLevel, params, userId, orgId, sessionId, threadId, appliesIn: "session" | "workflow" }` and `PolicyDecision = { mode: ApprovalMode, provenance: { baseMode, matchedPolicyId?, matchedGrantId?, matchedOverrideId?, source } }`. `call_tool` calls the resolver where `approvalModeFor` runs today; **no resolver configured → byte-identical current behavior** (`approvalModeFor` becomes the resolver's final fallback rung, and is what the engine uses standalone). Engine contract change → adversarial review, per house rule.

2. **Resolution order (first match wins, most specific to least):**
   1. live `runtime_grant` for this session/workflow-run + policyKey
   2. per-user `action_policy_override`
   3. org `action_policies` at **action** scope → **service** scope → **riskLevel** scope (param matchers filter applicability at each rung; `appliesIn` must match)
   4. plugin `defaultApprovalMode`
   5. risk-level default (low/medium→allow, high/critical→require_approval; undeclared risk is impossible — the field is required)
   A **kill switch is a deny policy at service scope** — no separate `disabled_actions` table (legacy's table folds in). The legacy invariant is kept: a policy row targets exactly one of action / service / riskLevel.

3. **Tables (api-side, into the `0000` app migration, Drizzle schemas in `packages/api/src/schema/`):**
   - `action_policies`: org, scope target (one-of enforced by check constraint), `mode`, `principalType` (`org|user`) + `principalId`, `paramMatchers` (JSON: field-path → equals/prefix/contains matcher, legacy shape), `appliesIn` (`any|workflow|session`), `origin` (`settings|approval_prompt|workflow_editor|admin`), `managedBy`, `expiresAt`/`revokedAt`, timestamps.
   - `runtime_grants`: `sessionId` or `workflowExecutionId` (one-of), deterministic `policyKey` (service+action+param-hash), granted by, expires with parent (revoked when the session stops / run settles — hooked where sandbox tokens are revoked today).
   - `action_policy_overrides`: user, scope target, mode — a user can tighten or (within org policy: only where org mode is `allow`/unset) loosen for their own sessions; org `deny` is never overridable.

   In a **multiplayer session**, resolution folds in the session OWNER's overrides regardless of which participant issued the prompt — the owner's per-user policy governs the whole session, consistent with the session credential model (a session runs under its owner's credentials, not the prompting participant's).

4. **Approval gates grow grant-writing resolutions.** The gate opened on `require_approval` gains actions beyond approve/deny: **"approve for this session"** (writes a `runtime_grant` on resolution, then approves) and — admin-only — **"always allow"** (writes an org `action_policies` row with `origin: "approval_prompt"`). The gate's engine-side `context` carries the policy provenance so a surface *can* render *why* it gated — though today only the after-the-fact Action Log (`GET /api/org/action-log`) actually does; the live wire/web gate surface drops `context` and shows no provenance (see Deviations #5). This is pure gate-action metadata + resolution handling in the host; the gate mechanism itself is untouched, and Telegram/CLI/web inherit the new actions for free.

5. **Workflow path enforcement.** `buildActionInvoker` consults the same resolver before invoking: `deny` → node fails with the policy reason; `require_approval` → node fails with "requires an approval node or a runtime grant" **unless** a grant covers it (grants scoped to the workflowExecutionId — written by an upstream approval node, which gains a "grant the rest of this run" option). The `requestDecision` rejection stub stays.

6. **Audit: `action_invocations` becomes the unified trail for BOTH paths.** The existing table (workflow dedup) gains provenance + live-turn rows: `service`, `actionId`, `riskLevel`, `resolvedMode`, `baseMode`, `matchedPolicyId/GrantId/OverrideId`, `status` (`allowed|denied|approved|rejected|error|completed`), `sessionId`/`workflowExecutionId`, `userId`, params and result **size-capped** (8KB each, truncation-flagged), timings, error. Live-turn rows are written by the host (the api wires an audit emitter into the resolver's decision + `call_tool`'s completion via the plugin-catalog's existing execute wrapper — the engine emits, the host persists; engine-standalone use without a host audit sink logs nothing, preserving engine portability). Dedup semantics of the workflow path are unchanged. **Binding rule (owed from T1, recorded at T6):** `resolvedMode` is the policy DECISION for an invocation; `status` is its execution OUTCOME. The two are independent axes — a `require_approval` decision can land `status: "rejected"` (user denied) or `status: "completed"` (user approved, action ran), and a workflow-path `require_approval`-with-no-grant denial is recorded as `status: "denied"` even though `resolvedMode` is `"require_approval"`, not `"deny"`. Every audit consumer (the Action Log route/UI, this spec's exit-criteria e2e) MUST key filtering/grouping logic on `resolvedMode`, never on `status` alone, to answer "what did the policy decide" — `status` only answers "what happened to the call." (`wire/types.ts`'s `ActionLogEntryWire.resolvedMode` already carries this as an inline doc comment.)

7. **UI.**
   - **Org admin, settings → Organization → Policies:** catalog-aware editor — browse services/actions (from `/api/plugins`), see effective mode per action with provenance, create/edit/revoke policies at any scope, param-matcher editor (key/matcher rows), kill-switch toggle per service (sugar over service-deny).
   - **Org admin, settings → Organization → Action Log:** cursor-paginated feed of `action_invocations`, filters: service, user, resolvedMode, status, time window; row expands to params/result (truncated), provenance links to the matching policy.
   - **Per-user settings:** My overrides (CRUD within decision 3's bounds) and My active grants (list + revoke).
   - Routes: `GET/PUT/DELETE /api/org/policies[...]` (admin), `GET /api/org/action-log` (admin), `GET/PUT/DELETE /api/me/policy-overrides`, `GET/DELETE /api/me/grants`.

8. **What this spec does NOT wire: builtin tools.** `ToolDef.requiresApproval` stays dormant — bash/file tools inside the sandbox are not plugin actions and are out of scope (sandbox isolation is their control). Revisit if/when a builtin-tool policy need is real; the resolver input shape already fits.

## Exit criteria (the dogfood)

On dev: with zero configuration, a high-risk action gates and a low-risk one doesn't (defaults intact). Admin sets `github` service to deny → agent's `call_tool` returns the policy refusal and the Action Log shows the denied row with provenance. Admin sets a specific action to require_approval with a param matcher → matching params gate, non-matching don't. Approving with "approve for this session" → the same action runs grant-clean for the rest of the session and the grant appears (and is revocable) in My grants; session stop kills it. A user override tightens an allow→require_approval for themselves only. A workflow tool node hitting require_approval without a grant fails with the instructive error; adding an upstream approval node with "grant the rest of this run" lets it pass. Every one of these appears in the Action Log with correct provenance.

## Testing

- **Resolver unit (pure):** full precedence matrix (grant > override > action > service > risk > plugin default > risk default), param-matcher semantics, appliesIn filtering, expiry/revocation, org-deny-not-overridable.
- **Engine:** `call_tool` with a fake resolver — deny refusal text, gate opened on require_approval with provenance in context, grant-writing resolution round-trip, **no-resolver path pinned byte-identical to today** (the regression test that protects standalone engine use).
- **Invoker:** workflow deny/require_approval/grant-covered matrix; dedup unchanged.
- **Audit:** both paths write rows; caps + truncation flags; log pagination/filters.
- **API/UI integration:** policy CRUD validation (exactly-one-scope), admin gating, override bounds.

## Non-goals

- Builtin (non-plugin) tool gating via `ToolDef.requiresApproval` (decision 8).
- Policy simulation/dry-run tooling ("what would this do") — later nicety.
- Team-principal policies (org + user only, matching the invoker's owner support today).
- Rate limits / quotas (different mechanism; usage spec territory if ever).
- Retro-porting legacy D1 policy rows (pre-1.0, no data migration).

## Deviations

Recorded across the implementation plan's six tasks (`docs/plans/2026-07-17-action-policies-audit.md`); this section is the single place they're consolidated for the arc's final review.

### Coordinator adjudications (binding, pre-existing — see the plan's header)

- **Deny dominates grants** (decision 2 vs decision 3 conflict): resolution order is (0) org/user-principal `deny` at the most-specific matching scope → absolute short-circuit; (1) live runtime grant; (2) per-user override; (3) org policy allow/require_approval; (4) plugin default; (5) risk default. Legacy's `userGrantBehavior: "blocked"` knob was not ported (YAGNI — the spec's text never asked for it).
- **Grants are exact-scope only** (this sessionId / this workflowExecutionId) — legacy's parent-lineage walk was not ported; child sessions re-gate. Conservative default, revisit on demand.
- **Param matchers ported verbatim from legacy** (11-op typed matcher: `eq/neq/regex/in/not_in/gt/gte/lt/lte/exists/not_exists`, dot+bracket paths, AND semantics, fail-closed stored-JSON parsing) — not the spec text's narrower equals/prefix/contains sketch. Porting the proven engine was strictly better than re-deriving a smaller one.
- **`policyKey` is the legacy composed string shape** (`{service}.{actionId}` via `grantPolicyKey`, T2/T3's adjudication that this is equivalent to the legacy's fuller composed key for this schema's purposes), not a hash.

### T2 — schema + matcher port + precedence core

- Deny-domination is scoped to the winning specificity TIER: a more-specific org `allow` beats a less-specific org `deny` (e.g. an action-scope allow overrides a service-scope deny for that one action) — deliberate, tested, not a loophole.
- An override's own `deny` (rung 2) is beatable by a live grant (rung 1); an org `deny` (rung 0) is not. This is intentional: a user's standing self-deny is a personal preference, not a security boundary.
- Disclosed-inert at T2, both later exercised/kept inert on purpose: `principalType: "user"` policy rows are reserved (never written this arc — every org-authored policy row is `principalType: "org"`); runtime grants have no param-hash fingerprint (a grant quiets the exact `(service, actionId)` pair regardless of the params that triggered it — see the T6 gap below for a related, more serious consequence of this).

### T3 — host wiring

1. **`always_allow` admin enforcement is deliberately double-checked**: the resolve route 403s a non-admin up front (T4, clean UX — the button shouldn't even "work" only to fail late), and `onResolution` independently verifies admin-ness and throws `AlwaysAllowNotAdminError` if not (defense in depth — fails the approval closed even if the route check is ever bypassed or stale).
2. **`policyKey = {service}.{actionId}` plus separate `sessionId`/`workflowExecutionId` scope columns is equivalent to the legacy composed key** for every purpose this schema needs (exact-match lookup, partial-unique-index dedup) — no information the legacy key encoded is lost.
3. **The `always_allow` deterministic-PK upsert firing twice (e.g. two gates racing) is benign and idempotent** — `onConflictDoUpdate` sets the same target values either time.
4. **Replay-after-revoke grant resurrection is intended and pinned** (`service.test.ts`): a workflow-execution or session-run's crash-restart replay of an already-resolved "approve for session/run" resolution re-inserts a live grant even if an admin revoked the original in between — the replay is re-asserting the SAME human decision that was already made, not a new one, so resurrection is the correct direction (revoking a specific grant is a targeted action; it doesn't retroactively invalidate the approval event that created it).
5. **Run-scoped grants land exec-scoped** via `providers/node.ts`'s `onApprovalGrant` (mirrored by `_setup.ts`'s test-harness twin, added at T6 — see below).

### T4 — routes (two fix rounds, both closed)

- **Critical (round 1, fixed):** an `actionId`-scope `allow` override could bypass an org policy that only gated at `service` or `riskLevel` scope, because the write-time bounds check only compared same-dimension rows. Fixed with a full-resolution bounds check (resolves the override's actual effective mode via the real precedence core, using a catalog lookup) plus a conservative disjointness rule for cross-dimension service/riskLevel overrides (the only provable-safe disjointness is "different service" for an actionId-scope policy). Unknown or dynamically-resolved-only actions fail CLOSED (the override write is rejected) rather than being allowed through on a catalog miss.
- **Important (round 2, fixed):** the bounds check above resolved `appliesIn: "session"` only, so a workflow-only org `require_approval` policy was bypassable via a session-scope-looking `actionId` allow override. Fixed to resolve both `appliesIn` contexts before accepting the write.
- **Disclosed, accepted (not a defect):** the bounds check has a TOCTOU window — an org policy edited between an override's write-time bounds check and its later use at resolution time isn't re-validated. The accepted direction is safe: resolution order puts org policy above overrides at every non-grant rung, so a newly-tightened org policy still wins at read time regardless of what an override's bounds check saw at write time.

### T5 — web UI (one fix round, closed)

- **Critical (fixed):** the param-matcher editor's op-aware value handling was wrong at ship — `gt/gte/lt/lte` sent raw strings (the engine's matcher needs a number, so these silently never matched) and `in/not_in` needed an array (raw string 400'd at create). Fixed with op-aware value coercion in the editor, with contract-verified pins.
- **Disclosed, accepted:** the matcher editor is create-only (no edit-in-place flow — delete and recreate instead); no `userId`/`from`/`to` Action Log filter controls in the UI (the routes support them; only the UI controls are deferred); no delete-confirmation dialogs (every delete in this arc is a soft-revoke, recreatable, so the safety cost of a missing confirm is low). All three are UI-polish backlog items, not correctness gaps.

### T6 — e2e + docs (this task): new findings

Four things surfaced while writing the exit-criteria e2e (`packages/api/src/integration/policies.e2e.test.ts`) that no earlier task's test suite exercised. Two were fixed in the same commit as the e2e (they were blocking the test from ever passing and are pure plumbing, not policy-engine logic); two are disclosed, not fixed, and are owed follow-ups.

**Fixed:**

1. **`ResolveWorkflowApprovalRequest` never carried `grantActions` to the wire.** Decision 4 and decision 5's "grant the rest of this run" only worked if a caller invoked `buildActionInvoker`/the approval node executor directly (as T3's unit tests do) — the actual HTTP route, `POST /api/workflows/runs/:runId/approvals/:nodeId`, dropped the field on the floor before it ever reached `workflowStore.insertSignal`, so no real (browser or API) caller could ever grant a run this way. Fixed: `wire/types.ts`'s `ResolveWorkflowApprovalRequest` gained an optional `grantActions` field, and `routes/workflows.ts` now validates and threads it into the signal payload.
2. **The integration test harness never wired `onApprovalGrant`.** `packages/api/src/integration/_setup.ts`'s `bootTestApi` hand-assembles its own `LocalRunHost` rather than reusing `providers/node.ts`'s real-boot wiring, and it had no `onApprovalGrant` callback at all — so no integration test could exercise a workflow approval grant end to end even after fix (1) above, and this drift-by-omission had gone unnoticed because no earlier task's tests opened an approval node with `grantActions`. Fixed: `_setup.ts` now wires an `onApprovalGrant` matching `providers/node.ts`'s (org lookup via the run's workflow definition, `writeExecutionGrant` per grant).

**Disclosed at T6, since FIXED (2026-08-14 follow-up commit — see "Owed follow-ups closed" below):**

3. **Session-path and workflow-path action-id matching use different conventions for "the same" logical action.** `plugin-catalog.ts`'s `call_tool` (session path) matches org policies/overrides/grants against the fully-qualified `PluginAction.id` (e.g. `"github.create_issue"`). `plugins/action-invoker.ts`'s `enforceWorkflowPolicy` (workflow path) matches against the BARE `ToolNode.action` field (e.g. `"create_issue"`, no service prefix) — confirmed by reading `action-invoker.ts`'s `computeResult`, which passes `req.action` straight into `resolveActionPolicy`'s `actionId`, never the resolved `PluginAction.id`. Consequently `grantPolicyKey(service, actionId)` also differs across paths for the same action (`"github.github.create_issue"` on the session path vs `"github.create_issue"` on the workflow path) — internally consistent within each path, but there is no single `actionId` value an admin can put in an action-scope org policy or a user override that is guaranteed to match BOTH a session call and a workflow call to the same logical action. An admin must currently know which path they're targeting and use the matching convention. Confirmed live by this task's e2e (`policies.e2e.test.ts`'s workflow-enforcement step deliberately uses the bare id to match the workflow path's real behavior — see that file's module doc). Recommended fix direction: change `action-invoker.ts` to resolve the `PluginAction` first (it already does, for `action.riskLevel`/`action.parameters`) and use `action.id` (qualified) as the policy/grant `actionId`, matching the session path — this is a policy-engine behavior change, so it should go through the same review rigor as T2/T3, not be folded into a future unrelated task silently.
4. **`gatedAuditId`'s dedup key can collide across separate turns for the same session.** `gatedAuditId(sessionId, resumeKey, gateOrdinal)` (T3, `policies/service.ts`) is the `action_invocations` PK for any invocation that opened a gate. `gateOrdinal` is scoped to `(queueItemId, resumeKey)` (engine `thread.ts`'s `getLatestGateForResume`), resetting to 0 for every NEW queue item/turn — it is NOT scoped to `queueItemId` itself, and `queueItemId` is not part of `gatedAuditId`'s key. Result: two DIFFERENT turns in the same session that gate on the exact same `(tool_id, params)` pair (a very ordinary flow — e.g. a user denies a critical action once, then approves the identical call later) mint the IDENTICAL audit-row PK, and the second write silently no-ops via `onConflictDoNothing` — the second gate's audit row is never recorded. T3's ledger flagged a narrower, "collision theoretical only" concern about the delimiter format of this same id; this is a distinct, concretely-reproducible collision (reproduced while writing this task's e2e, which now sidesteps it by varying a fixture action's params per gated call — see that file's `nukeParams` doc comment). Fixing this correctly needs `queueItemId` added to the engine's `PolicyInvocationRecord` (`packages/engine/src/types.ts`), which is a `[ADVERSARIAL REVIEW REQUIRED]` engine-contract touchpoint per this plan's Global Constraints — out of scope for this task, flagged for a fast-follow.
5. **Decision 4's "the gate's context carries the policy provenance so every surface can render why it gated" is not actually true for the wire/web surface.** `packages/api/src/engine/bridge.ts`'s `engineGateToWire` explicitly drops the engine `DecisionGate`'s `context` field (a pre-existing comment there, predating this arc, says surfacing it "would commit us to a contract before we know what we want"). The engine-side `context` DOES carry `provenance` (plugin-catalog.ts wires `context: { ..., provenance: decision.provenance }` when a gate opens) — it just never reaches `GET /api/sessions/:id/decisions` or the web gate UI. Today the ONLY surface that shows provenance is the Action Log (`GET /api/org/action-log`, populated after the fact via `onInvocation`), not the live gate itself. This is a real, live gap against decision 4's stated goal, not fixed here (extending the wire `DecisionGate` type + `engineGateToWire` + the web gate-rendering component is real feature surface work, not e2e/docs work) — flagged for the UI-polish backlog alongside T5's disclosed items.
6. **Session-path audit rows persist neither `params` nor `result`.** The `action_invocations` schema has both columns (with 8KB caps + truncation flags, decision 6), but the session path never fills them: the engine's `PolicyInvocationRecord` (`packages/engine/src/types.ts`) carries no `params`/`result`, so `buildPolicyResolver`'s `onInvocation` has nothing to write there. Workflow-path rows fare only slightly better — `action-invoker.ts` records `params` but not `result`. So the Action Log's row-expand-to-params/result affordance (decision 7) is effectively empty for live-turn rows today. Threading `params`/`result` through onto `PolicyInvocationRecord` is a `[ADVERSARIAL REVIEW REQUIRED]` engine-contract change, so it rides the same planned engine-contract fast-follow bundle as the `queueItemId` audit-key fix (#4) rather than being folded in here.

### Owed follow-ups closed (2026-08-14)

All four disclosed T6 items are fixed in the follow-up commit on this branch:

3. **Action-id conventions unified on the fqid.** The policy-facing `actionId` on BOTH paths is now the fully-qualified `service.action` fqid (the plugin-catalog/list_tools convention): the session path passes `qualifiedId(entry)` (not raw `PluginAction.id`, which may be bare), and the workflow path resolves the `PluginAction` and qualifies its id (`action-invoker.ts`'s `qualifiedActionId`). Supporting changes: `grantPolicyKey` collapses an already-qualified id (no more `github.github.create_issue` keys), `/api/plugins` action summaries report the fqid so the Policies UI creates rows that match, and `admin.ts`'s `findCatalogAction` (override bounds check) matches bare ids by their fqid. One admin-entered id now targets both paths. Pinned by the engine seam test (bare-id → fqid), the invoker tests, and the e2e (workflow grant uses the qualified id).
4. **`gatedAuditId` includes `queueItemId`.** `ToolContext` and `PolicyInvocationRecord` gained `queueItemId` (the running turn's queue item; a restart replay mirrors the original, so replay dedup still no-ops). The audit PK is now `(sessionId, queueItemId, resumeKey, gateOrdinal)` — two turns gating on the identical (tool, params) pair get distinct rows. The e2e removed its params-varying workaround and now pins three gated `widgets.nuke` turns with identical `{}` params; `service.test.ts` pins the cross-turn non-collision directly.
5. **Live gates carry provenance.** `engineGateToWire` extracts the ONE typed field from the engine gate's context — `provenance` — as the wire's new `DecisionGateProvenance` (fail-soft narrowing; the raw context bag stays engine-only). The web gate card renders a "why gated" line per source rung. Pinned by the e2e (risk_default and org_policy gates) and a card test.
6. **Audit rows persist params + result.** `PolicyInvocationRecord` gained `params`/`result` (engine emits verbatim; the host sink caps at 8KB with truncation flags, unchanged). The workflow path stamps the execution outcome (`status` completed/error, full `PluginActionResult`, `error`, `durationMs`) onto its decision row post-execution via `updateInvocationOutcome`. The Action Log's expand-to-params/result affordance now has real data on both paths. Note the workflow-path `status` axis change: a grant-covered executed node now lands `status: "completed"` (decision `resolvedMode: "allow"` unchanged); rows for denied/require-approval nodes keep `status: "denied"`.

### Re-port onto dev-v2 (2026-08-14)

The original branch stalled while dev-v2 moved ~230 commits (slash commands, events, sources/bakes, computed diffs). The revival merged the branch onto dev-v2 and re-integrated the engine seam by hand. Behavior deltas from the re-integration:

1. **The policy decision phase now lives in `invokeAction`, not `call_tool`'s body.** dev-v2 extracted `call_tool`'s core into `invokeAction` and reuses it for action-backed slash commands (slash-commands arc). The resolver path rode along, so a plugin action invoked via a slash command now gets the SAME policy resolution, gating, and audit as a `call_tool` invocation (`appliesIn: "session"` for both). This widens enforcement — intentional: a slash command is just another session-path entry to the same action.
2. **Pending gates return before any policy side effects.** The command path can leave a gate undecided (`resolution.actionId === "pending"`). The resolver path returns `pending-approval` at that point — `onResolution` does not run and no audit record is emitted; the re-driven invocation after the gate resolves emits the terminal record. The LLM tool path never sees `pending` (its `requestDecision` blocks), so `call_tool` semantics are unchanged.
3. **`InvokeActionResult.denied-approval` gained `reason?: "approval-processing-failed"`** so an `onResolution` throw renders its distinct fail-closed message through the shared outcome union instead of a bespoke `ToolResult`.
4. **`grantActions` threads through `resolveWorkflowApproval`** (`workflows/service.ts`) rather than the route building the signal inline — dev-v2 moved signal construction into the service; the field rides the service input into the same payload position.
5. **`PluginServiceSummary` keeps dev-v2's `connect`/`toolCount` fields beside the new `actions` list**; test fixtures were updated to carry all three.

### Adversarial mergeability review (2026-08-14)

Three independent adversarial reviewers (engine contract, policy security, integration/UI) attacked the full diff. Findings and dispositions:

**Fixed in the review-fix commit:**

1. **The slash-command path never received the resolver.** `Session.buildCommandToolContext` omitted `policyResolver`, so command-invoked plugin actions bypassed policy and audit entirely — the re-port's "same enforcement" claim was false. Fixed: the command context threads `options.policyResolver`. Commands run outside the queue, so `queueItemId` is absent there; gated command audits key on the empty turn scope, matching their gate-ordinal scoping.
2. **A reserved `extraGateActions` id ("approve"/"deny") threw through `execute()`,** crashing the tool call (and the command path) instead of failing closed. Fixed: it now returns a controlled `{ kind: "error" }` outcome — no gate opens, the action never runs, both paths render the message.
3. **`updateInvocationOutcome` updated by `invocationId` with no org scope.** The id embeds the workflow node id, which the workflow author controls, so a crafted node id could overwrite another org's audit row. Fixed: the UPDATE is org-scoped.
4. **The gate card's provenance switch matched `user_override` (a value the engine never emits — the real value is `override`) and had no `runtime_grant` case.** Fixed, with the wire doc comment corrected to the engine's actual `PolicyProvenanceSource` vocabulary and a card test on the real value.

**Reviewed and accepted (disclosed, not defects):**

5. **Workflow `grantActions` lets the approval-node resolver (any authorized run owner, not only admins) grant `require_approval` actions for the rest of the run.** This parallels the session path's `approve_session` (also non-admin): both are interactive human approvals; org `deny` dominates grants at rung 0 either way, and grants die with the run. Accepted as designed; tightening (admin-only grants, or bounding grants to actions present in the definition) is backlog.
6. **`revokeSessionGrants`/`revokeExecutionGrants` filter on session/run id without an org predicate.** Both ids are server-minted with no attacker-controllable input, and revocation only ever tightens. Accepted.
7. **`findCatalogAction` returns the first plugin matching a duplicate BARE action id**, which can mis-attribute the service in an override bounds-check error message. Invocation-time resolution (rung 0 deny included) is authoritative and unaffected. Accepted as a nit.
8. **`PluginActionContext.actionId` still mirrors raw `PluginAction.id`** (possibly bare) while the policy/audit actionId is the fqid — intentional (the context field is documented as mirroring the plugin's own id); plugins must not treat it as the policy id.
9. **After a restart replay, continuation-phase tool calls run with no `runningItem`,** so their audit rows carry no `queueItemId`. Gate ordinals in that state are scoped to the same empty key and stay monotonic per resumeKey, so audit ids remain unique and replay dedup still holds — the cost is turn attribution on those rows, not correctness.
