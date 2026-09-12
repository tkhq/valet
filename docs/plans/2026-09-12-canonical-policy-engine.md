# Canonical policy engine implementation plan

**Date:** 2026-09-12
**Status:** Proposed
**Design:** [Canonical policy engine design](../specs/2026-09-12-canonical-policy-engine-design.md)

## Delivery rule

Prepare the pull requests as a stack. Merge them in dependency order. Documentation is the first pull request. Preparatory pull requests can add inert contracts, libraries, policy bundles, and adapters. They must not evaluate live requests twice.

The action-policy behavior changes in one final local OPA cutover pull request. That pull request removes the old TypeScript evaluator. No pull request adds shadow mode. No production path falls back to the old evaluator.

## Stack and dependency graph

```text
PR 1  documentation
  |
  v
PR 2  typed contracts and audit identities
  |
  +----------+
  v          v
PR 3  OPA bundle and evaluator library    PR 4  policy data compiler
  |          |
  +----+-----+
       v
PR 5  inert surface adapters
       |
       v
PR 6  atomic local OPA action cutover
       |
       +----------+-----------+------------+
       v          v           v            v
PR 7 built-ins  PR 8 routes  PR 9 delegation  PR 10 entitlements
                 resources    sandbox, creds    and catalog
                              and egress
       \          |           |            /
        +---------+-----------+-----------+
                          |
                          v
                 PR 11 TVC attested evaluator
                          |
                          v
                 PR 12 attested execution and optional TKMS
```

PRs 3 and 4 can be reviewed in parallel after PR 2. PRs 7 through 10 can be prepared in parallel after PR 6, but each must merge only after its dependencies. PR 11 and PR 12 are future work, not part of the immediate Valet replacement.

## Reviewability rules

- Keep each preparatory pull request behavior-neutral in production.
- Put policy semantics in Rego once. Do not duplicate them in test-only TypeScript.
- Use fixture policy rows and static request fixtures before cutover. Do not mirror live traffic.
- Keep generated bundle fixtures small and review their source rows beside the expected Rego or data.
- Route a surface only when its request adapter, decision handling, audit, and failure behavior land together.
- Make PR 6 the only pull request that changes action-policy enforcement.
- Delete obsolete code in PR 6 rather than keeping it behind a flag.

## PR 1: Design and implementation plan

**Scope**

- Add this plan and the canonical policy engine design.
- Record local OPA as the immediate implementation.
- Record TVC attested evaluation and optional TKMS roles as future work.
- Record specificity semantics, no shadow mode, and no legacy fallback.

**Acceptance checks**

- Review both documents against `packages/api/src/policies`, `packages/engine/src/types.ts`, `packages/engine/src/plugin-catalog.ts`, and `packages/api/src/plugins/action-invoker.ts`.
- Confirm the design does not claim implementation.
- Confirm the only new files are documentation.

**Validation**

```bash
git diff --check
make e2e E2E_ARGS="--only docs-lint"
```

The repository docs-lint command checks its curated maintained-doc list. It does not lint files under `docs/specs` or `docs/plans`. Run the STE linter directly against these two files when Python is available.

## PR 2: Typed contracts and durable identities

**Depends on:** PR 1

**Scope**

- Add portable `AuthorizationRequest`, `AuthorizationSubject`, `PolicyDecision`, `PolicyDecisionEnvelope`, obligation, redaction, and evaluator types under `packages/engine/src/authorization/`.
- Add `AuthorizationService` and `AuthorizationEvaluator` interfaces in the API layer.
- Define stable request-subject and idempotency identities for interactive, workflow, route, and resource operations.
- Extend audit storage for policy digest, input digest, subject digest, evaluator identity, obligations, proof metadata, and separate execution attempts.
- Keep existing `PolicyResolver` behavior unchanged.

**Acceptance checks**

- Type tests reject a missing principal, request ID, action ID, or decision effect.
- Digest identity builders produce the same subject for a restart replay.
- A changed action parameter or resource ID changes the subject.
- Decision and execution records cannot be confused by type or schema.

**Validation**

```bash
pnpm --filter @valet/engine test
pnpm --filter @valet/api test authorization
pnpm typecheck
```

## PR 3: Canonical bundle and local OPA evaluator library

**Depends on:** PR 2

**Scope**

- Add deterministic bundle manifests and RFC 8785 input serialization.
- Add SHA-256 policy, input, decision, and subject digest helpers.
- Add bundle validation and the single Rego decision entry point.
- Add `LocalOpaEvaluator` with bounded evaluation and atomic prepared-bundle replacement.
- Add no production wiring.
- Add no decision cache.

**Acceptance checks**

- Reordered JSON keys produce the same digest.
- Changed values produce different digests.
- Archive timestamps do not affect `policyDigest` because the manifest hashes declared files.
- Invalid Rego, unknown files, duplicate paths, and invalid decision output fail closed.
- Evaluator timeout and bundle replacement errors return typed failures, not allow decisions.

**Validation**

```bash
pnpm --filter @valet/api test authorization/bundles authorization/evaluators
pnpm typecheck
```

## PR 4: Current policy data compiler

**Depends on:** PR 2

**Scope**

- Compile `action_policies`, team policies, `action_policy_overrides`, plugin defaults, risk defaults, and the standard new-organization default into Rego and static data.
- Convert `runtime_grants` and approval resolutions into canonical dynamic facts.
- Encode action, service, and risk specificity.
- Encode org deny, team deny, grant, override, strict org/team result, and default authority layers.
- Keep `packages/api/src/policies/resolution.ts` live until PR 6.
- Use offline fixture comparisons only. Do not add runtime dual evaluation.

**Acceptance checks**

- Fixtures cover current RBAC, PBAC, and ABAC inputs.
- A more specific allow beats a broader deny in one authority layer.
- A deny at the winning specificity beats grants and overrides.
- Team execution ignores personal overrides.
- Revoked, expired, cross-session, and cross-workflow grants do not match.
- The compiler output is deterministic for the same sorted source snapshot.

**Validation**

```bash
pnpm --filter @valet/api test authorization/compiler
pnpm --filter @valet/api test policies
pnpm typecheck
```

## PR 5: Inert adapters for current action paths

**Depends on:** PRs 3 and 4

**Scope**

- Add request adapters for interactive plugin actions in `packages/engine/src/plugin-catalog.ts`.
- Add request adapters for workflow actions in `packages/api/src/plugins/action-invoker.ts`.
- Add the compatibility adapter from engine `PolicyResolver` to `AuthorizationService`.
- Add common obligation, approval, and audit helpers.
- Do not wire the adapters into live production enforcement.
- Do not invoke OPA on live requests.

**Acceptance checks**

- Equivalent interactive and workflow fixtures produce the same canonical action, subject fields, and policy facts.
- Fully qualified action IDs use the existing service and action convention.
- Credential secrets never enter the request.
- Adapter failures are typed and map to fail-closed decisions when wiring occurs.

**Validation**

```bash
pnpm --filter @valet/engine test policy-resolver-seam plugin-catalog
pnpm --filter @valet/api test action-invoker authorization
pnpm typecheck
```

## PR 6: Atomic local OPA action cutover

**Depends on:** PR 5

**Scope**

- Build and inject one `AuthorizationService` from `packages/api/src/engine/host.ts`.
- Route interactive plugin actions and workflow tool nodes through local OPA.
- Move workflow analysis and pre-approval in `packages/api/src/workflows/permissions.ts` to `AuthorizationService`.
- Move the `upsertOverride` bounds guard in `packages/api/src/policies/admin.ts` to `AuthorizationService`.
- Move the `/api/org/policies/preview` path in `packages/api/src/routes/policies.ts` to `AuthorizationService`.
- Re-evaluate approved requests with canonical approval facts.
- Persist the decision before the action and persist execution outcome separately.
- Make audit reservation failure block external execution.
- Remove the TypeScript matching and precedence core in `packages/api/src/policies/resolution.ts`.
- Remove direct `resolveActionPolicy` calls from `packages/api/src/plugins/action-invoker.ts`.
- Reduce `packages/api/src/policies/service.ts` to authoring, grant storage, audit compatibility, or delete it where replacements exist.
- Keep `PolicyResolver` only as a thin engine compatibility adapter if needed.
- Remove the TypeScript evaluator from runtime, preview, workflow analysis, and override write guards.
- Remove production risk-default fallback for covered actions.
- Change personal-session resolver and policy-store errors from `require_approval` to deny.
- Compile and activate the standard default bundle in each new-organization transaction before the organization accepts requests.
- Do not include a feature flag, shadow path, dual evaluation, or old-engine fallback.

**Acceptance checks**

- Current action-policy API fixtures compile and drive OPA decisions.
- Interactive and workflow calls return equal decisions when `appliesIn` and all session or workflow-scoped facts are equal.
- Tests permit intentional differences from `appliesIn`, `sessionId`, or `workflowExecutionId` policy and grant scope.
- Existing policy precedence cases pass under OPA.
- Approval replay survives restart and remains bound to one request subject.
- Resolver, bundle, obligation, and audit failures deny without executing.
- Repository search finds no TypeScript evaluator in runtime, `packages/api/src/workflows/permissions.ts`, the `upsertOverride` guard, or policy preview.
- A new organization has an active valid bundle before it accepts an authorization request.
- Review the diff explicitly for `shadow`, `fallback`, and dual evaluator wiring.

**Validation**

```bash
pnpm --filter @valet/engine test
pnpm --filter @valet/workflow test
pnpm --filter @valet/api test policies action-invoker authorization
pnpm typecheck
make e2e
```

## PR 7: Built-in tools

**Depends on:** PR 6

**Scope**

- Route built-ins from `packages/engine/src/builtin-tools/index.ts` and API-built tools through `AuthorizationService`.
- Define action IDs and capability classes for file, process, approval, thread, child, and model-switch tools.
- Update `ToolDef` in `packages/engine/src/types.ts`. Today, `requiresApproval` only prevents concurrent dispatch in `packages/engine/src/tool-bridge.ts`; it does not enforce approval.
- Replace that concurrency-only signal with the canonical decision adapter or a clearly named concurrency field.
- Enforce redaction and obligations before and after tool execution.

**Acceptance checks**

- A denied built-in never calls its implementation.
- An approval decision binds exact arguments and re-evaluates after approval.
- Unknown obligations deny.
- Child tools also satisfy PR 9 policy when that pull request lands.

**Validation**

```bash
pnpm --filter @valet/engine test builtin policy authorization
pnpm typecheck
make e2e E2E_ARGS="--only cli,typecheck"
```

## PR 8: Route and resource authorization

**Depends on:** PR 6. Coordinate with TKAI-53 and TKAI-370.

**Scope**

- Define canonical resource types and actions for sessions, assistants, workflows, artifacts, team resources, and policy administration.
- Convert `packages/api/src/services/session-access.ts` and selected route-specific checks into fact adapters and enforcement calls.
- Keep authentication and tenant-scoped database queries in route and service code.
- Add a small typed query-obligation vocabulary before list routes use it.
- Preserve resource concealment behavior through obligations.

**Acceptance checks**

- User, team, org, and app principals receive the current allowed access matrix.
- Membership removal affects the next decision.
- Cross-org access denies before resource data is returned.
- List queries apply tenant and owner scope in SQL. They do not fetch all rows and filter later.
- Policy or fact load failure denies.

**Validation**

```bash
pnpm --filter @valet/api test session-access artifacts workflows teams authorization
pnpm typecheck
make e2e
```

## PR 9: Delegation, sandbox capabilities, credentials, and egress

**Depends on:** PRs 6 and 7. Coordinate inter-agent work with TKAI-433.

**Scope**

- Authorize child creation, child reads and sends, cross-orchestrator signals, and workflow delegation.
- Derive explicit child authority from the parent request. Do not copy ambient authority.
- Authorize sandbox profile, Docker, resources, mounts, terminal, and provider capabilities before provisioning.
- Authorize credential use and delegation before secret resolution.
- Authorize normalized egress destinations and return typed network obligations.
- Keep sandbox, credential broker, and egress proxy enforcement in their existing boundaries.

**Acceptance checks**

- Cross-org agent edges deny by default.
- Parent-to-child authority can narrow but cannot grow without a new approval or grant.
- Team work never falls back to an actor's personal credential.
- Secret bytes do not appear in policy input, audit, or proof payloads.
- Redirect, DNS rebinding, and IP-range tests remain enforced by the network layer.
- Capability or fact resolution failure prevents sandbox start or external connection.

**Validation**

```bash
pnpm --filter @valet/engine test child authorization sandbox
pnpm --filter @valet/api test delegation credentials sandbox egress authorization
pnpm typecheck
make e2e
```

## PR 10: Entitlements and plugin catalog

**Depends on:** PR 6

**Scope**

- Keep `packages/api/src/services/plugin-entitlements.ts` as storage and a fact adapter.
- Route session creation, session plugin assembly, plugin visibility, and workflow availability through canonical entitlement decisions.
- Use one reason code across API and UI surfaces.
- Do not duplicate entitlement policy in the catalog.

**Acceptance checks**

- Instance-off denies for all org settings.
- Org modes `off`, `all`, and `teams` preserve current behavior.
- Team membership changes affect the next request.
- Hidden UI and server enforcement derive from the same policy decision inputs.

**Validation**

```bash
pnpm --filter @valet/api test plugin-entitlements plugins authorization
pnpm --filter @valet/web test plugins
pnpm typecheck
make e2e
```

## PR 11: Future TVC attested evaluator

**Depends on:** PRs 6 through 10 as needed. This is future work.

**Scope**

- Implement `TvcAttestedEvaluator` behind the existing evaluator contract.
- Use bounded HTTP/1.1 requests and responses with explicit byte limits and timeouts.
- Deploy stateless TVC replicas.
- Define the signed decision App Proof payload.
- Verify App Proof signatures and linked Boot Proofs against pinned deployment, manifest, application, PCR, and account expectations.
- Reject TVC debug-mode deployments, including Boot Proofs with zero PCR values.
- Bind request nonce, subject, input, policy, decision, and obligation digests.
- Keep durable audit, approvals, request reservation, and idempotency in Valet.
- Add signed policy pins and trusted fact issuers where required.
- Replace local OPA deployment selection only after proof and failure-path review. Do not restore the old evaluator.

**Acceptance checks**

- A valid proof for the expected build and digests permits enforcement.
- Any proof, nonce, digest, key, manifest, PCR, freshness, or debug-mode check failure denies.
- Any replica can process a request without local session state.
- A retry with the same request identity returns the same stored Valet decision or a byte-equivalent verified envelope.
- HTTP/2, streaming, and WebSocket behavior are not required.
- TVC outage denies. It does not fall back to local OPA unless a separate approved deployment rollback restores the prior release.

**Validation**

```bash
pnpm --filter @valet/api test tvc-attested authorization
pnpm typecheck
make e2e
```

## PR 12: Future attested execution and optional TKMS roles

**Depends on:** PR 11. This is future work.

**Scope**

- Move selected external actions into a TVC attested executor.
- Bind execution proofs to the authorization decision and exact action input.
- Add optional TKMS key custody, co-signing, or consensus through public Turnkey APIs.
- Do not couple Valet to internal UMP.
- Keep action families that are not migrated on the Valet execution path with explicit audit limits.

**Acceptance checks**

- The execution proof binds the decision digest, action input digest, executor build, and result digest.
- A denied or mismatched decision cannot release the execution key or start the action.
- TKMS unavailability follows the action's fail-closed behavior.
- The evaluator works without TKMS for action families that do not require it.

**Validation**

```bash
pnpm --filter @valet/api test attested-execution turnkey authorization
pnpm typecheck
make e2e
```

## Migration strategy

1. Freeze semantic changes to the old TypeScript evaluator while PRs 2 through 5 are in review.
2. Export representative, redacted policy row snapshots from development data.
3. Compile those snapshots offline with PR 4.
4. Review OPA results for every current precedence case. Fix the compiler or make a documented policy-data correction before cutover.
5. Publish valid bundles for every active organization before PR 6 deploys.
6. Block PR 6 deployment if any organization lacks a valid active bundle.
7. Deploy PR 6 once. Local OPA becomes the only action evaluator at process start.
8. Remove old evaluator metrics, alerts, and code in the same pull request.
9. Route later domains through their own atomic surface pull requests.

Offline comparison is migration validation. It is not shadow mode because it does not evaluate live requests or retain two production decisions.

## Rollback strategy

Rollback uses an application release and policy snapshot pair:

1. Stop or drain action execution before changing application versions.
2. Deploy the previous known-good release artifact.
3. Restore the active bundle pointer to the bundle snapshot paired with that release.
4. Resume traffic after health and bundle checks pass.

For PR 6, the previous release contains the old implementation because it predates cutover. The running new release has no switch to it. Rollback is a deployment event, not a live fallback path.

After later releases no longer have compatible old policy storage, rollback targets the most recent local OPA release, not the removed TypeScript evaluator. Database migrations in this stack must be additive until the rollback window closes. Destructive cleanup waits for a later pull request.

For TVC rollout, rollback deploys the last known-good local OPA release and its bundle snapshot. `TvcAttestedEvaluator` never catches an error and invokes local OPA inside the same process.

## Final stack acceptance

The stack is complete when:

- OPA and Rego are the only policy evaluation format.
- Interactive and workflow actions use one service and equal semantics.
- Built-ins, entitlements, routes, resources, delegation, sandbox capabilities, credentials, and egress use the contract where applicable.
- `PolicyResolver` contains no policy logic.
- The repository contains no live old action evaluator, shadow path, or legacy fallback.
- Decision records and execution outcomes are separate and linked.
- Approval replay is deterministic and subject-bound.
- Local OPA failures deny.
- Future TVC proof failures deny.
- The full repository checks pass for each merge commit.
