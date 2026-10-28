# Canonical policy engine implementation plan

**Date:** 2026-09-12
**Status:** Proposed
**Design:** [Canonical policy engine design](../specs/2026-09-12-canonical-policy-engine-design.md)

## Delivery rule

Prepare the pull requests as a stack. Merge them in dependency order. Documentation is the first pull request. Preparatory pull requests can add inert contracts, libraries, policy bundles, and adapters. They must not evaluate live requests twice.

The built-in Valet Rust engine is the only supported production evaluator. The action-policy behavior changes in one final cutover pull request. That pull request removes the old TypeScript evaluator. No pull request adds a second evaluator, shadow mode, or runtime fallback.

## Stack and dependency graph

```text
PR 1  documentation
  |
  v
PR 2  typed contracts and audit identities
  |
  v
PR 3  pinned Regorus policy engine foundation
  |
  +----------+
  v          v
PR 4  interpreter hardening and Rego v1 compatibility
  |
  v
PR 5  local adapter and source bundle host     PR 6  policy source builder
  |                                             |
  +----------------------+----------------------+
                         v
PR 7  policy builder and authoring APIs
       |
       v
PR 8  inert surface adapters
       |
       v
PR 9  atomic local Valet engine action cutover
       |
       +----------+-----------+------------+
       v          v           v            v
PR 10 built-ins  PR 11 routes  PR 12 delegation  PR 13 entitlements
                 resources      sandbox, creds      and catalog
                                and egress
       \          |             |              /
        +---------+-------------+-------------+
                            |
                            v
                   PR 14 TVC Rust engine host
                            |
                            v
                   PR 15 attested execution and optional TKMS
```

PR 3 pins the Rust substrate and Valet engine boundary. PR 4 hardens the interpreter before PR 5 integrates a local target. PR 6 can proceed after PR 4. PR 7 builds on PRs 5 and 6. PRs 10 through 13 can be prepared after PR 9. PRs 14 and 15 are future work.

## Reviewability rules

- Keep each preparatory pull request behavior-neutral in production.
- Put policy rules in Rego and evaluator semantics in one Rust engine. Use that implementation locally and in TVC.
- Keep the local engine in-process. Do not add a local network hop or evaluator service.
- Keep the generic evaluator boundary for the built-in engine and future TVC host only.
- Use fixture policy rows and static request fixtures before cutover. Do not mirror live traffic.
- Keep generated bundle fixtures small and review their source rows beside the expected Rego or data.
- Route a surface only when its request adapter, decision handling, audit, and failure behavior land together.
- Make PR 9 the only pull request that changes action-policy enforcement.
- Delete obsolete code in PR 9 rather than keeping it behind a flag.
- Keep builder preview on `AuthorizationService`. Do not add a browser or UI evaluator.

## PR 1: Design and implementation plan

**Scope**

- Add this plan and the canonical policy engine design.
- Record Rego as the canonical authoring language and the Valet Rust engine as the authoritative evaluator.
- Record OPA only as historical and language-reference context. It is not a dependency, migration path, shadow path, fallback, or production evaluator.
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

- Add portable `AuthorizationRequest`, `AuthorizationSubject`, `PolicyDecisionV1`, `PolicyDecisionEnvelope`, obligation, redaction, and evaluator types under `packages/engine/src/authorization/`.
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

## PR 3: Pinned Regorus policy engine foundation

**Depends on:** PR 2

**Scope**

- Add the Rust workspace, pinned toolchain, and a narrowly scoped Valet policy engine crate.
- Pin `https://github.com/tkhq/regorus` at exact commit `aee1a9b12b1ec1e0599a53acd665b31d3bb5ea2e`. Keep its API behind the Valet engine boundary.
- Add versioned engine identity and capability-profile metadata.
- Inventory Regorus built-ins under the Valet capability classifications.
- Add boundary fixtures and compatibility tests that state their current coverage.
- Keep filesystem, network, clock, randomness, process, and arbitrary host callbacks unavailable by default.
- Add no production adapter, bundle host, authorization wiring, policy migration, or enforcement change.
- Add no OPA runtime, compiler, sidecar, command, library, migration, shadow path, fallback, or generated artifact.

**Acceptance checks**

- Cargo and the committed lockfile resolve `tkhq/regorus` commit `aee1a9b12b1ec1e0599a53acd665b31d3bb5ea2e`.
- The public crate API exposes Valet types rather than Regorus types.
- The capability profile classifies each inventoried built-in and rejects ambient authority by default.
- Fixtures prove deterministic evaluation for explicit input and typed output at the Valet boundary. A low deterministic budget rejects `count(numbers.range(0, 10000000))` through that boundary.
- Tests do not claim full Rego v1 compatibility or full pure built-in coverage.
- The crate has no production wiring or host authority.

**Validation**

```bash
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo fmt --all -- --check
```

## PR 4: Interpreter hardening and Rego v1 compatibility

**Depends on:** PR 3

**Scope**

- Harden the deterministic Regorus interpreter path without production wiring.
- Target full Rego v1 syntax, language semantics, and pure built-in coverage.
- Publish a versioned compatibility profile and inventory every remaining gap.
- Make Valet own Rego compatibility, conformance, limits, security review, and engine upgrades.
- Classify capability built-ins as fact-backed, explicitly injected, or rejected.
- Add bounded evaluation over immutable Rego source, canonical data, and explicit input.
- Add source bundle loading, contract validation, explain traces, and provenance maps.
- Add native and Rust-to-WebAssembly targets where toolchain tests permit them.
- Keep the default host capability interface empty. Version and allowlist each injected capability.
- Keep the pinned Regorus fork behind the Valet boundary.
- Defer RVM until it has complete `with`, cache, unwind, format, limit, and corpus parity.
- Add no RVM production path, RVM shadow path, bytecode requirement, OPA artifact, or production wiring.

**Acceptance checks**

- The published corpus measures Rego v1 language coverage and lists each known gap.
- The compatibility profile lists every pure built-in and its implementation status.
- Accepted fixtures return `PolicyDecisionV1` through the interpreter.
- A language gap or rejected capability built-in fails validation before activation.
- Missing, failed, or undeclared capabilities deny without fallback.
- Network, filesystem, wall clock, randomness, process access, and dynamic loading remain unavailable by default.
- Instruction, time, memory, depth, recursion, comprehension, trace, and result limits fail closed.
- Native and WebAssembly targets return equal decisions, errors, and limit behavior before both can ship.
- One release selects one semantic path. It never runs interpreter and RVM paths together or falls back between them.
- The engine crate contains no authentication, proof verification, database, lock, sandbox, network enforcement, or durable audit code.

**Validation**

```bash
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo fmt --all -- --check
```

## PR 5: Local Valet engine adapter and source bundle host

**Depends on:** PR 4

**Scope**

- Add deterministic source bundle manifests and RFC 8785 input serialization.
- Add SHA-256 source bundle, engine, input, decision, and subject digest helpers.
- Add compatibility checks for Rego, capability-profile, interpreter, contract, and engine versions.
- Load Rego v1 source and canonical data without requiring RVM bytecode.
- Add `LocalValetEvaluator` over one validated in-process native or WebAssembly target.
- Add bounded requests, typed failures, and atomic loaded-bundle replacement.
- Add no production wiring and no decision cache.
- Add no OPA host, local evaluator service, network hop, shadow path, or fallback.

**Acceptance checks**

- Reordered JSON keys produce the same digest, and changed values produce different digests.
- Archive timestamps do not affect `policyDigest` because the manifest hashes declared files.
- Invalid source, data, manifests, versions, or decision output fail closed.
- A valid source Rego and data bundle loads without RVM bytecode.
- Evaluator timeout, resource-limit, and bundle replacement errors return typed failures, not allow decisions.
- The language-neutral adapter returns the same `PolicyDecisionV1` as the interpreter corpus.

**Validation**

```bash
pnpm --filter @valet/api test authorization/bundles authorization/evaluators
pnpm typecheck
cargo test --workspace --locked
```

## PR 6: Current policy source builder

**Depends on:** PR 4

**Scope**

- Build canonical Rego and data from `action_policies`, team policies, `action_policy_overrides`, plugin defaults, risk defaults, and the standard new-organization default into Rego and static data.
- Generate Rego v1 source under the published capability profile and validate it with the pinned interpreter.
- Convert `runtime_grants` and approval resolutions into canonical dynamic facts.
- Encode action, service, and risk specificity.
- Encode org deny, team deny, grant, override, strict org/team result, and default authority layers.
- Keep `packages/api/src/policies/resolution.ts` live until PR 9.
- Use offline fixture comparisons only. Do not add runtime dual evaluation.

**Acceptance checks**

- Fixtures cover current RBAC, PBAC, and ABAC inputs.
- A more specific allow beats a broader deny in one authority layer.
- A deny at the winning specificity beats grants and overrides.
- Team execution ignores personal overrides.
- Revoked, expired, cross-session, and cross-workflow grants do not match.
- The source builder output is deterministic for the same sorted source snapshot.
- Generated Rego meets the published compatibility profile and produces `PolicyDecisionV1` through the Rust engine.

**Validation**

```bash
pnpm --filter @valet/api test authorization/source-builder
pnpm --filter @valet/api test policies
pnpm typecheck
```

## PR 7: Policy builder and canonical authoring APIs

**Depends on:** PRs 5 and 6

**Scope**

- Add versioned builder types, context descriptors, condition operators, decisions, obligations, validation issues, diffs, explain traces, and publish requests.
- Add the API context registry, operator registry, validation service, draft and review lifecycle, source-builder integration, provenance maps, and audit events.
- Add organization and team draft APIs with optimistic version checks and separate edit, review, publish, and rollback authorization points.
- Add the policy overview, context picker, rule editor, condition builder, decision and obligation editor, advanced-source view, effective-policy explanation, conflict preview, impact preview, generated diff, review, publish, and rollback surfaces.
- Make the advanced editor show Rego v1 coverage, pure built-ins, capability-builtins, known gaps, and engine compatibility.
- Build the web surface under `packages/web/src/routes/settings.organization.policies.tsx`, `packages/web/src/routes/settings.team.tsx`, and `packages/web/src/components/settings/policy-builder/`.
- Extend `packages/web/src/api/policies.ts` with typed builder requests.
- Map current action policies, team policies, overrides, grants, entitlements, plugin defaults, risk defaults, and the bundle default into provenance-preserving views.
- Emit Rego v1 and data under the same compatibility profile used locally and in future TVC.
- Include Rego, capability-profile, interpreter, contract, engine, source bundle, and provenance versions in builder validation and diffs.
- Keep publication inactive until PR 9 makes each effective-policy write validate, publish, and activate a canonical draft in one transaction.
- Add no client evaluator, UI-only semantics, shadow mode, dual evaluation, or runtime fallback.

**Acceptance checks**

- Each `AuthorizationKind` maps to one descriptor: `tool.action` and `tool.builtin` use Tool and action, with tool class distinguishing built-ins.
- `workflow.action` uses Workflow. `route.access` uses Route and API. `resource.access` uses Resource. `plugin.entitlement` uses Entitlement.
- `delegation.create` and `agent.signal` use Delegation and child session, with edge type distinguishing signals.
- `sandbox.capability` uses Sandbox capability. `credential.use` and `credential.delegate` use Credential. `egress.connect` uses Egress.
- Common fields stay generic while context-specific fields and operators come from capability schemas.
- The server rejects unknown fields, invalid operator and type pairs, unsupported obligations, sensitive values, stale versions, and unauthorized publication.
- Visual edits preserve rule identity, source provenance, and unknown registered extensions.
- Unsupported legacy expressions remain read-only and create explicit migration issues. They are never silently converted.
- Conflict output covers specificity, org and team denies, grants, overrides, defaults, approval obligations, unreachable rules, and contradictory conditions.
- Preview and explain use `AuthorizationService` with an active or server-built draft source bundle.
- Generated diffs show rule, Rego, data, provenance, digest, and sampled impact changes.
- Raw Rego cannot publish unless the interpreter accepts its Rego version, profile, contract, provenance, capabilities, and conflicts.
- Keyboard and screen-reader tests cover context selection, nested conditions, errors, review, and publication controls.
- Draft save has no enforcement effect.

**Validation**

```bash
pnpm --filter @valet/api test authorization/builder policies
pnpm --filter @valet/web test policy-builder policies
pnpm typecheck
```

## PR 8: Inert adapters for current action paths

**Depends on:** PR 7

**Scope**

- Add request adapters for interactive plugin actions in `packages/engine/src/plugin-catalog.ts`.
- Add request adapters for workflow actions in `packages/api/src/plugins/action-invoker.ts`.
- Add the compatibility adapter from engine `PolicyResolver` to `AuthorizationService`.
- Add common obligation, approval, and audit helpers.
- Do not wire the adapters into live production enforcement.
- Do not invoke the old or new evaluator on live requests.

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

## PR 9: Atomic local Valet engine action cutover

**Depends on:** PR 8

**Scope**

- Build and inject one `AuthorizationService` from `packages/api/src/engine/host.ts`.
- Route interactive plugin actions and workflow tool nodes through `LocalValetEvaluator` and the pinned deterministic interpreter.
- Move workflow analysis and pre-approval in `packages/api/src/workflows/permissions.ts` to `AuthorizationService`.
- Move the `upsertOverride` bounds guard in `packages/api/src/policies/admin.ts` to `AuthorizationService`.
- Move the `/api/org/policies/preview` path in `packages/api/src/routes/policies.ts` to `AuthorizationService`.
- Make each organization, team, override, entitlement, or default policy authoring write validate, publish, and activate its canonical draft in one transaction before success.
- If activation fails, fail the authoring write and keep the old active bundle.
- Persist grants and approvals as canonical dynamic facts in their own transactions. They do not republish the static bundle.
- Remove legacy web and API paths that can change effective policy without the authoring transaction.
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
- Build, validate, and activate the standard default source bundle in each new-organization transaction before the organization accepts requests.
- Do not include a feature flag, shadow path, dual evaluation, or old-engine fallback.

**Acceptance checks**

- Current action-policy API fixtures produce source bundles under the published compatibility profile and drive Valet engine decisions.
- Interactive and workflow calls return equal decisions when `appliesIn` and all session or workflow-scoped facts are equal.
- Tests permit intentional differences from `appliesIn`, `sessionId`, or `workflowExecutionId` policy and grant scope.
- Existing policy precedence cases pass under the Valet Rust engine.
- Approval replay survives restart and remains bound to one request subject.
- Resolver, bundle, obligation, and audit failures deny without executing.
- Repository search finds no TypeScript evaluator in runtime, `packages/api/src/workflows/permissions.ts`, the `upsertOverride` guard, or policy preview.
- Every web and API policy authoring write validates, publishes, and activates its canonical draft in one transaction before success.
- A failed activation leaves the old active bundle unchanged. No legacy form can write around this transaction.
- Grant and approval mutations persist canonical dynamic facts atomically and do not republish the static bundle.
- A new organization has an active valid bundle before it accepts an authorization request.
- Review the diff explicitly for `shadow`, `fallback`, and dual evaluator wiring.

**Validation**

```bash
cargo test --workspace --locked
pnpm --filter @valet/engine test
pnpm --filter @valet/workflow test
pnpm --filter @valet/api test policies action-invoker authorization
pnpm typecheck
make e2e
```

## PR 10: Built-in tools

**Depends on:** PR 9

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
- Child tools also satisfy PR 12 policy when that pull request lands.

**Validation**

```bash
pnpm --filter @valet/engine test builtin policy authorization
pnpm typecheck
make e2e E2E_ARGS="--only cli,typecheck"
```

## PR 11: Route and resource authorization

**Depends on:** PR 9. Coordinate with TKAI-53 and TKAI-370.

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

## PR 12: Delegation, sandbox capabilities, credentials, and egress

**Depends on:** PRs 9 and 10. Coordinate inter-agent work with TKAI-433.

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

## PR 13: Entitlements and plugin catalog

**Depends on:** PR 9

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

## PR 14: Future TVC Rust engine host

**Depends on:** PRs 9 through 13 as needed. This is future work.

**Scope**

- Add a native Rust TVC host around the same pinned `valet-policy-engine` crate and bundle contract. Do not implement new policy semantics.
- Implement `TvcAttestedEvaluator` behind the existing language-neutral evaluator contract.
- Use bounded HTTP/1.1 requests and responses with explicit byte limits and timeouts.
- Deploy stateless TVC replicas with no database, lock, approval, or durable idempotency state.
- Define the signed decision App Proof payload.
- Verify App Proof signatures and linked Boot Proofs against pinned deployment, host, engine, bundle, PCR, and account expectations.
- Reject TVC debug-mode deployments, including Boot Proofs with zero PCR values.
- Bind deployment, host, engine, source, source bundle manifest, request ID, subject, input, policy manifest, decision, obligation, ephemeral key, and nonce.
- Keep authentication, proof verification, durable audit, approvals, request reservation, and idempotency in Valet.
- Add signed policy pins and trusted fact issuers where required.
- Replace the local deployment location only after proof and failure-path review. Do not run both locations in production.

**Acceptance checks**

- The native TVC host returns the same `PolicyDecisionV1` as the pinned local engine for the conformance corpus.
- A valid proof binds the expected Rust host, engine build, source bundle, source policy, input, and decision.
- Any proof, nonce, digest, key, manifest, PCR, freshness, or debug-mode check failure denies.
- Any replica can process a request without local session state.
- A retry with the same request identity returns the stored Valet decision or a byte-equivalent verified envelope.
- HTTP/2, streaming, and WebSocket behavior are not required.
- A TVC outage denies. Only a release rollback can restore the prior local Valet engine deployment.

**Validation**

```bash
cargo test --workspace --locked
pnpm --filter @valet/api test tvc-attested authorization
pnpm typecheck
make e2e
```

## PR 15: Future attested execution and optional TKMS roles

**Depends on:** PR 14. This is future work.

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

1. Freeze semantic changes to the old TypeScript evaluator while PRs 2 through 8 are in review.
2. Pin the Rust toolchain, Regorus substrate, Valet engine boundary, and capability profile in PR 3.
3. Freeze the first Rego v1 compatibility profile and Rust engine contract in PR 4.
4. Validate the selected local engine target and bundle host in PR 5.
5. Export representative, redacted policy row snapshots from development data.
6. Build those snapshots as supported Rego and deterministic source bundles with PR 6.
7. Import the snapshots into provenance-preserving builder documents with PR 7.
8. Compare offline Valet engine results for every current precedence case. Fix the source builder or record a migration issue before cutover.
9. Build and validate engine-compatible source bundles for every active organization before PR 9 deploys.
10. Block PR 9 if an organization lacks a valid bundle or has unsupported source.
11. Deploy PR 9 once. The local Valet Rust engine becomes the only action evaluator at process start.
12. Move every effective-policy write to transactional canonical draft validation, publication, and activation.
13. Verify that failed activation rejects the write and keeps the old active bundle.
14. Remove old evaluator metrics, alerts, forms, write routes, and code in the same pull request.
15. Route later domains through their own atomic surface pull requests.

Offline comparison is migration validation. It does not evaluate live requests or retain two production decisions.

## Rollback strategy

Rollback uses an application, engine, and policy bundle release set:

1. Stop or drain action execution before changing application versions.
2. Deploy the previous known-good application and pinned engine artifacts.
3. Restore the active bundle pointers to source bundle snapshots validated for that engine.
4. Resume traffic after health, engine, and bundle compatibility checks pass.

For PR 9, the previous release contains the old implementation because it predates cutover. The new release has no switch to it. Rollback is a deployment event, not a live fallback path.

Later rollback targets the most recent compatible Valet Rust engine release and its bundle set. Database migrations must remain additive until the rollback window closes. Destructive cleanup waits for a later pull request.

For TVC rollout, rollback deploys the last known-good local Valet engine release and matching bundles. `TvcAttestedEvaluator` never catches an error and invokes the local evaluator in the same process.

## Final stack acceptance

The stack is complete when:

- Rego is the canonical authoring language, and the built-in Valet Rust engine is the only supported production evaluator.
- Local and TVC deployments use the same semantic implementation and compatibility profile.
- OPA remains historical and language-reference context only.
- Interactive and workflow actions use one service and equal semantics.
- Built-ins, entitlements, routes, resources, delegation, sandbox capabilities, credentials, and egress use the contract where applicable.
- `PolicyResolver` contains no policy logic.
- The builder covers every registered context without adding another policy language or evaluator.
- Every effective-policy write validates, publishes, and activates its canonical draft in one transaction with source provenance.
- Every grant or approval mutation persists one canonical dynamic fact transactionally with source provenance.
- The repository contains no live old action evaluator, shadow path, or legacy fallback.
- Decision records and execution outcomes are separate and linked.
- Approval replay is deterministic and subject-bound.
- Local Valet engine, bundle compatibility, and resource-limit failures deny.
- Future TVC proof failures deny.
- The full repository checks pass for each merge commit.
