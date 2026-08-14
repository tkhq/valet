# Action Policies + Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/specs/2026-07-16-action-policies-audit-design.md`: org policies, runtime grants, user overrides, param matchers, gate-grown grant actions, workflow enforcement, the unified `action_invocations` audit trail, and the admin/user UI.

**Architecture:** The engine gains ONE optional seam — `CreateSessionOptions.policyResolver?` (an object port: `resolve(input) → PolicyDecision`, `onResolution?(...)` for host side effects, `onInvocation?(record)` for audit) — threaded to `call_tool` via `ToolContext` (built in `Thread.buildToolContext`; the catalog build site never sees session context). Absent resolver = byte-identical today (`approvalModeFor` stays as the internal fallback). The api implements the resolver over three new tables + the legacy matcher engine (ported verbatim), wires grant expiry into the existing teardown hooks, enforces in the workflow invoker, and ships Policies/Action Log/My-overrides/My-grants surfaces. Branch `feat/action-policies`; the arc ends in a PR against `dev-v2`.

**Tech Stack:** TypeScript strict, Hono 4, Drizzle/Postgres (PGlite dev), vitest, React 19.

**Spec:** `docs/specs/2026-07-16-action-policies-audit-design.md` — Decisions locked; non-goals real (no builtin-tool gating, no simulation, no team principals, no rate limits, no legacy data migration).

## Coordinator adjudications (record in the spec's Deviations at T6)

- **Deny dominates grants.** Spec decision 2's literal order (grant first) would let a session grant quiet an org *deny*, contradicting decision 3's "org deny is never overridable". Resolution order implemented: **(0) org/user-principal `deny` at any scope (most-specific match) → short-circuit deny; (1) live runtime grant; (2) per-user override; (3) org policy allow/require_approval rungs (action → service → riskLevel); (4) plugin defaultApprovalMode; (5) risk default.** Legacy's `userGrantBehavior: "blocked"` knob is NOT ported (spec omits it; YAGNI).
- **Grants are exact-scope only** (this sessionId / this workflowExecutionId). Legacy's parent-lineage walk is not ported — child sessions re-gate (conservative default; revisit on demand).
- **Param matchers ported verbatim from legacy** (`packages/worker/src/lib/action-policy-matchers.ts`): 11-op typed matcher (`eq/neq/regex/in/not_in/gt/gte/lt/lte/exists/not_exists`), dot+bracket paths, AND semantics, fail-closed stored-JSON parsing — NOT the spec text's narrower equals/prefix/contains sketch (porting the proven engine is strictly better).
- **`policyKey` is the legacy composed string** (`session:{sessionId}:{service}.{actionId}:` / `exec:{execId}:{nodeId|*}:{service}.{actionId}:`), not a hash; the trailing reserved slot stays empty this pass.

## Global Constraints

- Node 22 for every command: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null` (Node 20 = spurious `WebSocket is not defined` failures).
- **Engine contract touchpoint (Task 1) REQUIRES adversarial review (opus):** the `policyResolver?` seam + `call_tool` changes. Absent resolver = byte-identical (structural + full-suite pin + explicit test; the `resolveModel?`/`credentialResolver?` precedents at `packages/engine/src/types.ts:1114/1142` are the template). The `resolution.actionId !== "approve"` check (plugin-catalog.ts:~421) becomes an interpretation over host-declared approving actions — the ONE non-additive engine change; everything else is additive.
- Pre-1.0 migrations: `packages/api/migrations/pg/0000_app.sql` in place + Drizzle; `rm -rf ~/.valet/pg` after. Exactly-one-scope enforced by BOTH a CHECK constraint and service-layer validation (tests pin the service-layer 400).
- Audit rows cap params/result at 8KB each with truncation flags; **no secrets** ever in audit rows (params may contain user data — that's expected; credential material must never transit params by construction, pin nothing new).
- Admin gating via the shared `packages/api/src/routes/_org-admin.ts`. "always allow" is enforced admin-only at RESOLUTION time (the resolve route — the gate can't know its future resolver at open time).
- Only the 2 known `messages.abort` failures allowed; PGlite one per process; api vitest unit project scrubs provider env keys; no `any`/`as unknown as`/`@ts-ignore`; no Co-Authored-By; root typecheck excludes packages/web.
- A parallel agent is working in a sibling worktree (single-binary CLI) — docker-gated suites may flake under contention; rerun isolated before believing a failure. This arc should not need docker or the cluster.
- **Workflow ends in a PR against `dev-v2`** — never commit to dev-v2 directly.

---

### Task 1: Engine seam — `policyResolver?` port + `call_tool` enforcement [ADVERSARIAL REVIEW REQUIRED]

**Files:** Modify `packages/engine/src/types.ts` (port types + `CreateSessionOptions.policyResolver?` + `ToolContext.policyResolver?`), `packages/engine/src/thread.ts` (`buildToolContext` threads it), `packages/engine/src/plugin-catalog.ts` (`call_tool`); Test `packages/engine/test/policy-resolver-seam.test.ts`.

**Interfaces (produced; consumed by T3):**
```ts
export interface PolicyResolveInput {
  service: string; actionId: string; riskLevel: RiskLevel;
  params: Record<string, unknown> | undefined;
  userId?: string; orgId?: string; sessionId: string; threadId: string;
  appliesIn: "session" | "workflow";
}
export interface PolicyDecision {
  mode: ApprovalMode;
  provenance: { baseMode: ApprovalMode; matchedPolicyId?: string; matchedGrantId?: string; matchedOverrideId?: string; source: string };
  /** Extra gate actions the host wants offered on a require_approval gate.
   * `approves: true` actions are treated as approval by call_tool after
   * onResolution runs. Stripped to plain DecisionActions before the gate. */
  extraGateActions?: (DecisionAction & { approves: boolean })[];
}
export interface PolicyResolver {
  resolve(input: PolicyResolveInput): Promise<PolicyDecision>;
  /** Host side effects on gate resolution (grant/policy writes). Best-effort;
   * a throw fails the approval closed (treat as deny) — pin this. */
  onResolution?(input: PolicyResolveInput, decision: PolicyDecision, resolution: DecisionResolution): Promise<void>;
  /** Audit emission from call_tool's execute wrapper: called for EVERY
   * plugin-action invocation (allowed/denied/approved/rejected/error/completed)
   * with timings + resolvedMode + provenance. Fire-and-forget (never throws
   * into the tool path — engine .catch()es). */
  onInvocation?(record: PolicyInvocationRecord): Promise<void>;
}
```
- `call_tool` behavior with resolver present: resolve → `deny` → refusal text INCLUDING the provenance source (`denied: {tool_id} is blocked by org policy` — keep the existing prefix for compat, append nothing secret); `require_approval` → gate opened with `context` carrying provenance + the DEFAULT approve/deny actions PLUS stripped extraGateActions; on resolution: `onResolution` awaited (throw → treat as not-approved), approved iff `actionId === "approve"` or a host action with `approves: true`; `allow` → straight through. `onInvocation` called in the execute wrapper (plugin-catalog.ts:~456-465) with status/timing for every path incl. deny/rejection (which never reach execute — emit at the decision site too; ONE record per invocation attempt).
- Absent resolver: `approvalModeFor` path byte-identical (structural — no new statements when undefined; the existing gate default actions unchanged; full engine suite green + explicit pins).

- [ ] Steps: failing tests (absent-resolver pin; deny refusal + provenance in context; extra actions ride the gate stripped of `approves`; approves-action treated as approval AFTER onResolution; onResolution throw → not approved; onInvocation records for allow/deny/approved/rejected/error/completed with timings; resolver receives the exact input shape incl. appliesIn "session") → implement → `pnpm --filter @valet/engine test && pnpm typecheck` → commit `feat(engine): policyResolver seam — resolve, gate actions, audit emission`.

---

### Task 2: Schema + pure policy core (matchers ported, precedence matrix)

**Files:** Modify `packages/api/src/schema/index.ts` + `0000_app.sql` (3 new tables + `action_invocations` extension); Create `packages/api/src/policies/matchers.ts` (verbatim port of `packages/worker/src/lib/action-policy-matchers.ts` — read it on `main` via `git show main:packages/worker/src/lib/action-policy-matchers.ts`), `packages/api/src/policies/resolution.ts` (pure precedence over in-memory row inputs); Tests for both (port legacy matcher tests if they exist; full precedence matrix per the adjudicated order).

**Interfaces (consumed by T3-T5):**
- `action_policies`: `{ id ("apol_"+uuid), orgId, principalType: "org"|"user", principalId, service?, actionId?, riskLevel?, mode, paramMatchers jsonb default [], appliesIn: "any"|"workflow"|"session" default 'any', origin: "settings"|"approval_prompt"|"workflow_editor"|"admin", managedBy?, expiresAt?, revokedAt?, createdAt, updatedAt }` + CHECK exactly-one-of(service/actionId/riskLevel) + index (orgId, revokedAt).
- `runtime_grants`: `{ id ("rg_"+uuid), orgId, sessionId?, workflowExecutionId?, policyKey, mode ("allow"), grantedBy, createdAt, revokedAt? }` + CHECK one-of(sessionId/workflowExecutionId) + unique (orgId, coalesce scope, policyKey) — mirror legacy's per-scope idempotency (select-before-insert in the service layer; partial unique indexes per scope column).
- `action_policy_overrides`: `{ id ("apo_"+uuid), orgId, userId, service?, actionId?, riskLevel?, mode, paramMatchers jsonb default [], createdAt, updatedAt }` + same one-of CHECK.
- `action_invocations` gains: `service, actionId, riskLevel, resolvedMode, baseMode, matchedPolicyId, matchedGrantId, matchedOverrideId, status ("allowed"|"denied"|"approved"|"rejected"|"error"|"completed"), sessionId, workflowExecutionId, userId, orgId, params jsonb (8KB-capped + paramsTruncated bool), result jsonb (8KB-capped + resultTruncated bool), durationMs, error, startedAt` — ALL nullable (existing workflow rows keep working; dedup semantics untouched — pin).
- `resolvePolicyDecision(rows: {policies, grants, overrides}, input): PolicyDecision` — pure, the adjudicated order (deny-dominates → grant → override → org rungs action>service>risk → plugin default [passed in] → risk default), matcher + appliesIn + expiry/revocation filtering at each rung, org-deny-not-overridable pinned.

- [ ] Steps: failing tests (matcher semantics matrix ported; precedence matrix incl. deny-beats-grant, grant-quiets-require, override-cannot-loosen-org-deny, override-can-tighten, appliesIn filtering, expiry/revoked exclusion, specificity action>service>risk) → implement (+ `rm -rf ~/.valet/pg`) → `env -u OPENAI_API_KEY pnpm --filter @valet/api test && pnpm typecheck` → commit `feat(api): policy tables + matcher engine + pure resolution core`.

---

### Task 3: Host wiring — resolver, grant/policy writes, audit sink, expiry hooks, workflow enforcement

**Files:** Create `packages/api/src/policies/service.ts` (row loaders per input, grant upsert w/ policyKey, always-allow policy write, audit persister w/ caps); Modify `packages/api/src/engine/host.ts` (buildPolicyResolver → all four builders, conditional spread), `packages/api/src/engine/session-meta.ts`-adjacent if user context needed, `packages/api/src/routes/sessions.ts`/`host.ts` destroy hook (revoke session grants beside `revokeSandboxTokens`), `packages/api/src/workflows/pg-store.ts` `settleRun` (revoke exec grants), `packages/api/src/plugins/action-invoker.ts` (resolver before execute: deny → node fails w/ policy reason; require_approval → fails "requires an approval node or a runtime grant" UNLESS an exec-scoped grant covers; audit rows for the workflow path too; dedup untouched), the workflow approval executor ("grant the rest of this run" gate action → exec-scoped grant on resolution — find the approval-node executor in packages/workflow / the api's engine-deps and add the extra action the same host-declared way); Tests at each seam.

**Key details:** resolver reads rows fresh per call (no caching — policy changes apply next invocation; pin). `onResolution`: `approve_session` → grant upsert (session scope, policyKey composed string); `always_allow` → org policy row (action scope, origin "approval_prompt") — NO admin check here (route-level, T4) but `onResolution` receives resolution.resolvedBy: verify admin there too (defense in depth — resolvedBy is a userId; isOrgAdmin check; non-admin → throw → approval fails closed with a clear gate-visible error... verify what the user sees; disclose). Audit persister truncates at 8KB per field with flags; write failures logged never thrown (fire-and-forget contract).

- [ ] Steps: failing tests (session path end-to-end with a real session build: policy deny → refusal + audit row; require_approval → gate w/ provenance context + extra actions; approve_session resolution → grant row + subsequent same-action call runs grant-clean + audit shows matchedGrantId; destroy revokes session grants; settleRun revokes exec grants [idempotent]; workflow deny/require/grant-covered matrix + instructive errors; always_allow writes org policy; audit caps + truncation flags; workflow dedup byte-identical pin) → implement → `env -u OPENAI_API_KEY pnpm --filter @valet/api test && pnpm --filter @valet/workflow test && pnpm typecheck` → commit `feat(api): policy resolver wiring — grants, audit, workflow enforcement`.

---

### Task 4: Routes — policies CRUD, action log, overrides, grants, plugins catalog extension

**Files:** Create `packages/api/src/routes/policies.ts` (admin: GET/POST/PATCH/DELETE `/api/org/policies` [+ effective-mode preview endpoint if cheap — judge], GET `/api/org/action-log` keyset-paginated), `packages/api/src/routes/me-policies.ts` (GET/PUT/DELETE `/api/me/policy-overrides`, GET/DELETE `/api/me/grants`); Modify `packages/api/src/routes/plugins.ts` (+`actions: {id, name, riskLevel}[]` per service), `packages/api/src/routes/messages.ts` resolve route (admin-only enforcement for `always_allow` actionId → 403 non-admin), `app.ts` mounts, wire types; Tests per route.

**Key details:** exactly-one-scope 400 (service-layer, matching the CHECK); override bounds enforced at write (cannot set `allow` where an org policy resolves deny/require... per spec decision 3: loosening only where org mode is allow/unset — validate against current org rows, disclose the TOCTOU acceptance); action-log keyset pagination on `(startedAt DESC, invocationId)` with `cursor` = opaque base64 of the pair, filters service/userId/resolvedMode/status/from/to — FIRST cursor-paginated route in the codebase, design it clean (limit ≤100 default 50, `nextCursor` null at end); grants DELETE = revokedAt stamp (not row delete).

- [ ] Steps: failing tests (CRUD validation matrix, admin gating via shared helper, cross-org 404, action-log pagination [3 pages, stable ordering, filters], override bounds, grant revoke, plugins actions exposure, always_allow 403 non-admin at resolve) → implement → gate → commit `feat(api): policy routes — CRUD, action log, overrides, grants`.

---

### Task 5: Web — Policies page, Action Log, My overrides/grants

**Files:** Create `packages/web/src/routes/settings.organization.policies.tsx`, `settings.organization.action-log.tsx` + components (`policies-section.tsx` w/ catalog browser + effective-mode display + matcher editor rows + kill-switch toggle [sugar over service-deny], `action-log-section.tsx` w/ cursor pagination + expandable rows + provenance links); Modify per-user settings (My overrides + My active grants — new `settings.policies.tsx` under YOU_ITEMS or extend an existing page; judge + disclose), `settings-rail.tsx` (+2 org entries, +1 you entry), api hooks; verify `decision-gate-card.tsx` renders the new actions acceptably (generic already — add a `style` mapping only if the default secondary looks wrong; screenshot-level judgment deferred to dogfood); Tests per component.

- [ ] Steps: failing tests (policy create w/ scope one-of UI enforcement; matcher rows; kill-switch writes service-deny; action log renders rows + paginates + filters; overrides CRUD within bounds; grants list + revoke; gate card shows 4 actions) → implement → `cd packages/web && pnpm test && pnpm typecheck` → commit `feat(web): policies, action log, overrides + grants surfaces`.

---

### Task 6: E2E + docs + PR

**Files:** e2e (`packages/api/src/integration/policies.e2e.test.ts` — the spec's exit-criteria loop fixture-first: defaults intact → service deny → param-matcher gate → approve-for-session grant lifecycle incl. revoke-on-destroy → user override tighten → workflow require+grant flow → every step's audit row provenance-checked); docs (spec Status → Implemented + Deviations incl. the four coordinator adjudications + anything that emerged; handoff row #6); full battery; then: push `feat/action-policies`, `gh pr create --base dev-v2` with a thorough body (test evidence, deviations, owed items). Do NOT merge.

- [ ] Steps: e2e → battery (`pnpm typecheck && pnpm --filter @valet/engine test && pnpm --filter @valet/workflow test && env -u OPENAI_API_KEY pnpm --filter @valet/api test && cd packages/web && pnpm typecheck && pnpm test`; only the 2 known failures) → docs → commit `docs(specs): action policies + audit implemented` → push + PR.

---

## Self-review notes (already applied)

- **Spec coverage:** decision 1 → T1 (port shape extended with onResolution/onInvocation — the spec's "engine emits, host persists" audit sentence and decision 4's "resolution handling in the host" both need a host callback surface; a bare resolve() cannot deliver them); 2 → T2 (adjudicated order); 3 → T2/T3; 4 → T1 (extra actions) + T3 (writes) + T4 (admin enforcement at resolve); 5 → T3; 6 → T2 (columns) + T1/T3 (emission/persistence); 7 → T4/T5; 8 → honored (nothing touches builtin tools). Exit criteria → T6.
- **Gate surfaces verified generic** (web/telegram/resolve route impose zero action-id whitelisting) — decision 4's "inherit for free" claim is real; only cosmetic emoji/style fallbacks.
- **Type consistency:** `PolicyDecision.extraGateActions[].approves` (T1) consumed by call_tool only; `PolicyResolveInput.appliesIn` "session" from call_tool, "workflow" from the invoker (T3); policyKey format identical in T3's session and workflow writers.
- **Known softness (flagged):** the always_allow admin check exists at BOTH the resolve route (403, clean UX) and onResolution (defense-in-depth, fails the approval closed) — the double check is deliberate; effective-mode preview endpoint is optional (judge in T4); override-bounds validation accepts a TOCTOU window (org policy changed after override written — resolution order makes the org row win anyway, which is the safe direction).
