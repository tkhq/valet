# Action Policies + Audit Log Design — the v2 policy engine

**Date:** 2026-07-16
**Status:** Draft
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

4. **Approval gates grow grant-writing resolutions.** The gate opened on `require_approval` gains actions beyond approve/deny: **"approve for this session"** (writes a `runtime_grant` on resolution, then approves) and — admin-only — **"always allow"** (writes an org `action_policies` row with `origin: "approval_prompt"`). The gate's `context` carries the policy provenance so every surface can render *why* it gated. This is pure gate-action metadata + resolution handling in the host; the gate mechanism itself is untouched, and Telegram/CLI/web inherit the new actions for free.

5. **Workflow path enforcement.** `buildActionInvoker` consults the same resolver before invoking: `deny` → node fails with the policy reason; `require_approval` → node fails with "requires an approval node or a runtime grant" **unless** a grant covers it (grants scoped to the workflowExecutionId — written by an upstream approval node, which gains a "grant the rest of this run" option). The `requestDecision` rejection stub stays.

6. **Audit: `action_invocations` becomes the unified trail for BOTH paths.** The existing table (workflow dedup) gains provenance + live-turn rows: `service`, `actionId`, `riskLevel`, `resolvedMode`, `baseMode`, `matchedPolicyId/GrantId/OverrideId`, `status` (`allowed|denied|approved|rejected|error|completed`), `sessionId`/`workflowExecutionId`, `userId`, params and result **size-capped** (8KB each, truncation-flagged), timings, error. Live-turn rows are written by the host (the api wires an audit emitter into the resolver's decision + `call_tool`'s completion via the plugin-catalog's existing execute wrapper — the engine emits, the host persists; engine-standalone use without a host audit sink logs nothing, preserving engine portability). Dedup semantics of the workflow path are unchanged.

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
