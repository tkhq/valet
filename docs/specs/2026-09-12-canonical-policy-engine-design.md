# Canonical policy engine design

**Date:** 2026-09-12
**Status:** Proposed design
**Scope:** The end-state authorization architecture for Valet. The first implementation uses local OPA. Later work can move evaluation and execution into Turnkey Verifiable Cloud.

## Summary

Valet will use one canonical policy engine for every authorization decision. Open Policy Agent (OPA) and Rego are the canonical policy format. A typed `AuthorizationService` contract will cover plugin actions, workflow actions, built-in tools, entitlements, routes, resources, delegation, sandbox capabilities, credentials, and egress where those surfaces need policy.

The first implementation is an atomic replacement. One cutover pull request will route interactive and workflow actions through local OPA and remove the old decision engine. It will not run old and new evaluators together. It will not provide a legacy runtime fallback. `PolicyResolver` can adapt the engine during migration, but after cutover it will only call `AuthorizationService`. It will not contain policy logic.

The contract also anticipates a `TvcAttestedEvaluator`. That evaluator will return a signed decision envelope that binds the evaluator build, policy bundle digest, input digest, request subject, and decision. Valet will verify TVC App Proofs and Boot Proofs before enforcement. Valet will retain durable audit and idempotency state.

This document is a design spec. It does not define conformance levels, executable vectors, or an implementation.

## Context

Valet currently has several authorization mechanisms:

- `packages/api/src/policies/resolution.ts` implements action-policy matching and precedence.
- `packages/api/src/policies/service.ts` loads policy rows, writes grants, and builds the engine `PolicyResolver`.
- `packages/engine/src/types.ts` defines `PolicyResolveInput`, `PolicyDecision`, and `PolicyResolver` for interactive plugin actions.
- `packages/api/src/plugins/action-invoker.ts` calls `resolveActionPolicy` directly for workflow actions. It does not use the engine resolver contract.
- `packages/engine/src/plugin-catalog.ts` enforces interactive plugin action decisions.
- `packages/engine/src/builtin-tools/index.ts` defines built-in tools. `packages/engine/src/types.ts` defines `ToolDef.requiresApproval`. Today, `packages/engine/src/tool-bridge.ts` uses that field only to prevent concurrent dispatch. It does not enforce approval.
- `packages/api/src/workflows/permissions.ts` previews workflow policy and writes pre-approval overrides through the TypeScript policy core.
- `packages/api/src/policies/admin.ts` uses the TypeScript core in the `upsertOverride` bounds guard.
- `packages/api/src/routes/policies.ts` uses `resolveActionPolicy` for policy previews.
- `packages/api/src/services/plugin-entitlements.ts` evaluates plugin visibility outside the action policy engine.
- `packages/api/src/services/session-access.ts` and route-specific services enforce resource access with direct checks.
- Credential delegation, child sessions, sandbox settings, and scoped egress each have separate checks.

The current action-policy resolver uses scope specificity. An action rule can override a service rule, and a service rule can override a risk rule. The most restrictive mode breaks ties at one specificity. Org and team denies have special dominance rules. Runtime grants and personal overrides occupy separate precedence rungs. Policy reads are fresh and are not cached.

This separation creates two risks. First, new entry points can omit a check or implement different behavior. Second, future attestation cannot prove a single policy decision if part of that decision remains in host code.

Related work includes:

- [TKAI-53](https://linear.app/turnkey/issue/TKAI-53) for RBAC and policy foundations.
- [TKAI-370](https://linear.app/turnkey/issue/TKAI-370) for resource-level authorization.
- [TKAI-433](https://linear.app/turnkey/issue/TKAI-433) for inter-agent policy.
- [The current action policy design](2026-07-16-action-policies-audit-design.md).
- [The team resource design](2026-07-21-team-resources-design.md).
- [The plugin entitlement design](2026-08-29-plugin-entitlements-design.md).
- [The orchestrator design](2026-07-11-orchestrator-engine-design.md), including child and inter-agent edges.

## Goals

1. Use OPA and Rego as the only policy evaluation format.
2. Put all covered authorization decisions behind one typed service.
3. Give interactive actions and workflow actions the same request and decision semantics.
4. Preserve current product policy behavior during data migration, except where this design makes an explicit precedence choice.
5. Fail closed when policy state, evaluation, proof verification, or obligation handling fails.
6. Bind each decision to one stable request subject and one canonical policy and input digest.
7. Keep approval replay deterministic after process restarts.
8. Separate a policy decision from the later execution outcome in storage and audit.
9. Make local OPA the immediate implementation without blocking a future TVC evaluator.
10. Design the TVC boundary for stateless replicas and durable Valet idempotency.
11. Provide one safe policy builder for every canonical authorization context.

## Non-goals

- This design specifies the policy builder, but it does not implement the builder or its administration experience.
- This design does not define executable conformance artifacts.
- This design does not move all tool execution into TVC in the first implementation.
- This design does not make host identity claims true by attesting evaluation.
- This design does not replace authentication, team membership storage, sandbox isolation, network enforcement, or credential encryption.
- This design does not use internal UMP as a durable Valet integration boundary.
- This design does not require TKMS for local OPA.
- This design does not provide shadow mode, dual evaluation, or a live old-engine fallback.
- This design does not add decision caching in the first implementation.

## Settled decisions

### OPA and Rego are canonical

Every policy source compiles to a complete OPA bundle. The evaluator reads Rego and immutable bundle data. Structured database rows remain useful authoring data, but they do not form a second runtime policy engine.

Valet will use one named package and entry point, such as `data.valet.authz.decision`. The entry point returns a decision object, not a bare Boolean. Bundle validation rejects a missing entry point, invalid output, unsupported schema version, or a policy that cannot produce a closed decision.

### The replacement is atomic

The implementation can be prepared as a stack of pull requests. The final cutover pull request is one atomic behavior change. That pull request will:

- enable local OPA as the only evaluator;
- route both interactive and workflow actions through `AuthorizationService`;
- remove the matching and precedence implementation from `packages/api/src/policies/resolution.ts`;
- remove direct workflow calls to `resolveActionPolicy`;
- move workflow permission preview, override bounds checks, and policy preview to `AuthorizationService`;
- remove all absent-resolver risk defaults from covered production wiring; and
- leave `PolicyResolver` only as a typed adapter if the engine still needs that symbol.

There is no period where production traffic evaluates both engines. A rollback deploys the prior application release and restores the matching policy bundle snapshot. It does not switch a running process to the old evaluator.

### One service covers all policy domains

`AuthorizationService` is the host-facing contract. It evaluates these request kinds where policy applies:

- plugin tool actions from interactive sessions;
- plugin actions from workflow tool nodes;
- built-in tools and API-built `ToolDef` tools;
- plugin entitlements and feature access;
- API route and resource access;
- delegation and inter-agent messaging;
- child-session creation and inherited authority;
- sandbox profiles, Docker, CPU, memory, terminal, and other capabilities;
- credential use, delegation, and owner scope; and
- egress destinations and protocols.

A domain can keep a specialized enforcement mechanism. For example, the sandbox provider enforces a capability and the egress proxy enforces a host allowlist. The policy decision that selects the permitted capability or destination still comes from `AuthorizationService`.

### Specificity wins, with deny dominance inside the winning tier

The canonical evaluator adopts Valet's current specificity model instead of the TVC prototype's global deny dominance.

For each authority layer, matching rules are grouped by target specificity. Resource instance or exact action is most specific. Resource type or service follows. Risk or domain defaults are least specific. The evaluator selects the highest matching specificity. Within that specificity, `deny` wins over `require_approval`, which wins over `allow`.

Authority layers then resolve in this order:

1. An org deny at its winning specificity.
2. A team deny at its winning specificity.
3. A valid dynamic session or workflow grant.
4. A personal override for a personal owner.
5. The strictest non-deny org and team result at their winning specificities.
6. The plugin default as a lowest-specificity action layer.
7. The risk default as the next lowest-specificity action layer.
8. The policy bundle default when the domain has no plugin or risk default.

A more specific allow can override a less specific deny in the same org or team layer. A deny that wins its layer cannot be loosened by a grant or personal override. Team executions do not use personal overrides. Plugin and risk defaults are part of Rego, not host fallback code. The bundle default is `require_approval` for action-like operations and `deny` for access or capability checks that cannot ask a human.

This choice preserves current Valet behavior for rules such as an exact action exception under a service restriction. It differs from the TVC prototype, where any matching deny dominates globally. Migration must compile each current row into a specificity-bearing Rego rule and compare representative production policy snapshots before cutover. The comparison is an offline migration check, not shadow evaluation of live requests.

### Local OPA now, TVC later

The immediate evaluator is an in-process or local sidecar OPA runtime owned by Valet. The production choice must support bounded evaluation, prepared bundles, and deterministic input. It must not call back into Valet during evaluation.

The future evaluator is `TvcAttestedEvaluator`. `AuthorizationService` does not know whether the evaluator is local or remote. The evaluator receives a resolved bundle and a canonical request. It returns a typed decision envelope.

TKMS and TVC have different roles:

- Public TKMS is the system for Turnkey-native activities, consensus, and key custody.
- TVC is the natural substrate for arbitrary Valet policy evaluation and attested execution.
- Internal UMP is not the stable Valet API for this work.
- A future TKMS integration can co-sign a decision, hold a policy-admin key, hold an execution key, or provide consensus approval. The evaluator contract does not depend on UMP or on a TKMS activity shape.

## Architecture

```text
request source
    |
    v
surface adapter
    |
    v
AuthorizationService
    | resolve facts, bundle version, and request subject
    v
AuthorizationEvaluator
    | LocalOpaEvaluator now
    | TvcAttestedEvaluator later
    v
PolicyDecisionEnvelope
    |
    +--> obligation handler
    +--> approval gate when required
    +--> enforcement point
    +--> decision audit
             |
             +--> execution outcome audit after the action settles
```

### Module boundaries

The implementation should use these boundaries. Exact file placement can follow repository package constraints when the implementation starts.

- `packages/engine/src/authorization/types.ts`: portable request, subject, decision, obligation, and adapter types. It must not import Hono or database code.
- `packages/api/src/authorization/service.ts`: `AuthorizationService`, fact resolution, fail-closed error mapping, and durable request handling.
- `packages/api/src/authorization/evaluators/local-opa.ts`: local OPA evaluator.
- `packages/api/src/authorization/evaluators/tvc-attested.ts`: future TVC client and proof verifier.
- `packages/api/src/authorization/bundles/`: compiler, canonical bundle builder, publisher, loader, and active-version store.
- `packages/api/src/authorization/facts/`: adapters for memberships, entitlements, resources, credentials, sessions, workflows, and approvals.
- `packages/api/src/authorization/audit.ts`: decision records, proof material, redaction, and execution outcomes.
- `packages/api/src/policies/`: temporary authoring and compatibility adapters. It must contain no evaluator after cutover.

`packages/engine/src/plugin-catalog.ts`, `packages/api/src/plugins/action-invoker.ts`, built-in tool dispatch, resource services, and route guards are enforcement points. They submit requests and enforce decisions. They do not interpret policy rows.

## Contracts and data shapes

The shapes below are design sketches. They show required information without freezing TypeScript syntax.

```ts
type AuthorizationKind =
  | "tool.action"
  | "workflow.action"
  | "tool.builtin"
  | "plugin.entitlement"
  | "route.access"
  | "resource.access"
  | "delegation.create"
  | "agent.signal"
  | "sandbox.capability"
  | "credential.use"
  | "credential.delegate"
  | "egress.connect";

type AuthorizationRequest = {
  schemaVersion: 1;
  requestId: string;
  idempotencyKey: string;
  kind: AuthorizationKind;
  subject: {
    orgId: string;
    principal: { type: "user" | "team" | "org" | "app"; id: string };
    actorUserId?: string;
    sessionId?: string;
    threadId?: string;
    workflowExecutionId?: string;
    workflowNodeId?: string;
    parentSessionId?: string;
  };
  action: { service?: string; id: string; riskLevel?: string };
  resource?: { type: string; id?: string; ownerType?: string; ownerId?: string };
  context: Record<string, unknown>;
  facts: Record<string, unknown>;
  approval?: ApprovalFact;
};

type PolicyDecision = {
  effect: "allow" | "deny" | "require_approval";
  reasonCode: string;
  matchedRuleIds: string[];
  obligations: Obligation[];
  redactions: RedactionDirective[];
  approvalRequirement?: ApprovalRequirement;
};

type PolicyDecisionEnvelope = {
  schemaVersion: 1;
  requestId: string;
  requestSubjectDigest: string;
  inputDigest: string;
  policyDigest: string;
  evaluator: { kind: "local_opa" | "tvc_attested"; buildDigest: string };
  decision: PolicyDecision;
  evaluatedAtMs: number;
  proof?: TvcDecisionProof;
};
```

The request subject digest covers the stable identity of the attempted operation. It includes the request kind, principal, actor when present, session or workflow scope, canonical action, resource identity, and stable invocation identity. It does not include volatile timestamps.

The `idempotencyKey` is derived from the durable invocation identity. Interactive gated actions use the existing queue item, resume key, and gate ordinal model. Workflow actions use the durable workflow invocation ID. Route and resource operations use a server-minted operation ID that is persisted before an external side effect.

## Canonical input and digest rules

Valet constructs one complete evaluation input. The evaluator must not fetch mutable facts during evaluation.

1. Valet validates the typed request and facts.
2. Valet removes fields excluded by the request schema. Unknown fields fail validation rather than silently changing a digest.
3. Valet serializes policy data and evaluation input with RFC 8785 JSON Canonicalization Scheme.
4. Valet computes SHA-256 over the UTF-8 canonical bytes.
5. `inputDigest` covers the full evaluated input, including approval facts and dynamic grants.
6. `requestSubjectDigest` covers the stable operation binding described above.
7. `policyDigest` covers a deterministic bundle manifest and each file digest. It does not hash a ZIP or tar container whose metadata can vary.

The canonical bundle manifest sorts paths by UTF-8 byte order. Each entry contains path, byte length, media type, and SHA-256 digest. Rego source uses UTF-8 and LF line endings. JSON data uses RFC 8785 bytes. Duplicate paths, path traversal, symlinks, non-UTF-8 Rego, and undeclared files are rejected.

## Policy bundle lifecycle

Each organization has one active logical bundle version. A bundle contains:

- the canonical Rego modules;
- immutable policy data;
- schema and compiler versions;
- source revision metadata;
- dynamic grant and approval facts that apply to the request; and
- the deterministic manifest.

Static policy publication follows `draft`, `validated`, `published`, `active`, and `retired` states. Validation compiles Rego, checks the entry point and output schema, checks referenced data, and computes the canonical digest. A policy authoring write creates or updates and validates a canonical draft. It then publishes and activates that draft in one transaction before it reports success. If activation fails, the write fails and the old active bundle remains. A standalone draft save does not change effective policy.

Organization creation must never leave a gap with no policy. The create transaction compiles and activates the standard default bundle before it makes the organization usable. Organization creation fails if compilation or activation fails. The organization cannot accept requests until that transaction commits.

Dynamic session and workflow grants change too often to republish the static authoring bundle for every approval. Valet supplies them as signed or database-rooted request facts under a fixed Rego data namespace. Their canonical bytes are covered by `inputDigest`. Each fact includes grant ID, scope ID, exact policy key, issuer, creation time, revocation state, and source approval ID. Missing, expired, revoked, cross-scope, or malformed facts do not match.

Approval facts follow the same rule. A fact binds the approval ID, gate ID, request subject digest, original decision digest, approver, verdict, scope, and resolution version. An approval for one subject cannot approve another request.

Local OPA trusts Valet's transactionally loaded facts. A future attested evaluator proves that it evaluated those supplied facts. It does not prove those facts were truthful unless a trusted issuer signed them or the proof verifier can root them elsewhere.

## Policy builder

### Product goals and limits

The policy builder is a safe authoring view over canonical policy data. It is not a second policy language. The builder helps administrators create common rules without writing Rego. Every saved rule compiles through the same bundle compiler that supplies local OPA and the future TVC evaluator.

The builder must cover every `AuthorizationKind` in this design. It must make the selected context, subject, target, conditions, decision, obligations, precedence, and provenance visible. It must use safe defaults and show the effect of a draft before publication.

The builder has these non-goals:

- It does not enforce policy in the browser.
- It does not add UI-only effects, operators, priorities, or fallback semantics.
- It does not hide a canonical rule that the visual editor cannot represent.
- It does not store secrets, credentials, raw tokens, or unredacted sensitive request values.
- It does not let raw Rego bypass typed validation, provenance, review, or publication controls.

An advanced editor can expose raw Rego or structured policy data only if the server validates the same decision contract and provenance map. If lossless validation is not possible, the builder shows the source as read-only and requires an explicit migration or product decision.

### Builder architecture

The builder uses a versioned `PolicyBuilderDocument`. The document is a projection over canonical authoring data and bundle source metadata. The server owns its schema, migration, validation, compilation, and publication.

Proposed module boundaries are:

- `packages/web/src/routes/settings.organization.policies.tsx`: organization policy overview and builder route.
- `packages/web/src/routes/settings.team.tsx`: team-scoped entry to the shared builder.
- `packages/web/src/components/settings/policy-builder/`: context picker, rule editor, condition tree, decision editor, obligations, preview, diff, review, and publish controls.
- `packages/web/src/api/policies.ts`: typed draft, validation, explain, diff, review, publish, and rollback requests.
- `packages/api/src/authorization/builder/types.ts`: builder document, rule, condition, validation, diff, and explain types.
- `packages/api/src/authorization/builder/contexts.ts`: policy context registry and capability descriptors.
- `packages/api/src/authorization/builder/operators.ts`: condition operator registry and type compatibility.
- `packages/api/src/authorization/builder/validation.ts`: structural, semantic, conflict, permission, and sensitive-value checks.
- `packages/api/src/authorization/builder/service.ts`: draft lifecycle, review state, authorization, and audit.
- `packages/api/src/authorization/bundles/compiler.ts`: builder and migrated source compilation into canonical Rego and data.
- `packages/api/src/authorization/bundles/publisher.ts`: content-addressed publication and transactional activation.

The current `packages/web/src/components/settings/policies-section.tsx` can become a compatibility view or compose the new builder primitives. It must not keep a separate matcher model after cutover.

### Context registry and flexibility

A `PolicyContextRegistry` maps each authorization context to a versioned `ContextDescriptor`. The descriptor is data consumed by both API validation and the web form. A new context registers capabilities without creating a new authorization model.

Every descriptor defines:

- context ID, label, description, and schema version;
- allowed subject types and ownership scopes;
- action and resource selectors;
- condition fields, field types, sensitivity, and allowed operators;
- valid decisions and whether human approval is meaningful;
- supported obligations and approval requirements;
- specificity dimensions and explain labels;
- available sample or historical request shapes for preview; and
- migration adapters for older builder documents.

Generic rule fields are rule ID, source scope, subject selector, context ID, target selector, condition tree, decision, obligations, approval requirement, applies-in scope, time bounds, status, and source provenance. Context-specific fields live under typed target and condition payloads declared by the descriptor. The generic editor never guesses their meaning.

The registry covers these contexts:

| Context descriptor | `AuthorizationKind` values | Context-specific capabilities |
|---|---|---|
| Tool and action | `tool.action`, `tool.builtin` | Service, fully qualified action, risk, parameter schema, plugin default, and tool class. The tool class distinguishes built-ins. |
| Workflow | `workflow.action` | Definition, node, `workflowExecutionId`, owner, trigger, `appliesIn`, and workflow grant scope. |
| Route and API | `route.access` | HTTP method, route ID, authenticated principal type, operation, and concealment requirement. |
| Resource | `resource.access` | Resource type, stable ID, owner, tenant, visibility, requested operation, and query obligation. |
| Entitlement | `plugin.entitlement` | Plugin, instance availability, organization mode, team set, and feature operation. |
| Delegation and child session | `delegation.create`, `agent.signal` | Parent, child, edge type, target owner, repository, model tier, hop count, and inherited authority. The edge type distinguishes agent signals. |
| Sandbox capability | `sandbox.capability` | Profile, provider, image, Docker, CPU, memory, mount, terminal, and requested capability. |
| Credential | `credential.use`, `credential.delegate` | Service, credential owner, delegation source, requested use, and session or workflow owner. Secret fields are excluded. |
| Egress | `egress.connect` | Scheme, normalized host, port, protocol, destination class, redirect policy, and declared scope. |

Common editor primitives handle typed equality, set membership, order comparisons, presence, time windows, subject membership, owner relationships, and Boolean groups. Context descriptors can expose only operators valid for a field type. For example, the egress descriptor can expose host suffix matching, while a numeric sandbox field can expose bounded comparisons. Descriptor extensions must map to canonical input fields and registered compiler behavior.

### Authoring model

A rule has one stable ID across drafts and published versions. The ID appears in generated Rego metadata, explain traces, policy diffs, decision audit, and rollback history. Copying a rule creates a new ID.

A rule targets one canonical context and one authority scope. Authority scope is organization or team for standing rules, personal owner for an override, and session or workflow execution for a grant. Subject selectors choose principal type, specific principals, roles, teams, ownership relations, or authenticated workload classes allowed by the context descriptor.

The target selector narrows actions, resources, or capabilities. Conditions constrain typed request and fact fields. `ConditionNode` supports nested `all`, `any`, and `not` groups plus typed comparisons. Empty groups, unknown fields, invalid operator and type pairs, and conditions on secret fields are errors.

The effect is `allow`, `deny`, or `require_approval` where the context permits approval. An approval editor selects assurance, approver subject, scope, expiry, replay rule, and consensus requirement when supported. An obligation editor adds only obligations declared by the context descriptor.

`appliesIn` retains `any`, `session`, and `workflow` for migrated action rules. Contexts that do not use it omit the control. Time bounds are explicit start and expiry values with a displayed time zone. Parameter constraints use the action schema when available and retain the current matcher operators only when their field types permit them.

Specificity is computed from the canonical target, not from visual position. The builder displays the authority layer and computed specificity. A displayed priority is derived from authority layer, specificity, decision restrictiveness, and the canonical tie rule. Authors cannot enter an arbitrary number that bypasses org or team deny semantics.

Dynamic grants and approval facts appear as read-only effective-policy entries with revoke or inspect actions where the caller has authority. They are not edited as standing rules. Plugin defaults and risk defaults appear as inherited, read-only lowest-specificity layers. The bundle default appears after them. Overrides have their own authoring view and cannot loosen a winning organization or team deny.

### Design-level data shapes

These shapes describe the boundary. They do not define an executable specification.

```ts
type PolicyBuilderDocument = {
  schemaVersion: number;
  documentId: string;
  owner: { type: "org" | "team"; id: string };
  baseVersionId: string;
  draftVersion: number;
  status: "draft" | "in_review" | "approved" | "published" | "superseded";
  review?: { reviewId: string; requiredApprovals: number; approvals: ReviewApproval[] };
  rules: RuleDraft[];
  advancedSources: AdvancedPolicySource[];
  createdBy: string;
  updatedAt: number;
};

type ContextDescriptor = {
  id: string;
  kinds: AuthorizationKind[];
  schemaVersion: number;
  subjectTypes: string[];
  targetSchema: FieldDescriptor[];
  conditionFields: FieldDescriptor[];
  decisions: PolicyDecision["effect"][];
  obligations: ObligationDescriptor[];
  specificity: SpecificityDimension[];
};

type RuleDraft = {
  ruleId: string;
  contextId: AuthorizationKind;
  authority: { type: "org" | "team" | "override"; id: string };
  subjects: SubjectSelector[];
  target: Record<string, unknown>;
  conditions: ConditionNode;
  decision: DecisionDraft;
  obligations: ObligationDraft[];
  appliesIn?: "any" | "session" | "workflow";
  validFrom?: number;
  expiresAt?: number;
  source: SourceProvenance;
};

type ConditionNode =
  | { kind: "all" | "any"; children: ConditionNode[] }
  | { kind: "not"; child: ConditionNode }
  | { kind: "compare"; field: string; operator: string; value?: unknown };

type DecisionDraft = {
  effect: "allow" | "deny" | "require_approval";
  approval?: ApprovalRequirement;
};

type ObligationDraft = {
  type: string;
  parameters: Record<string, unknown>;
};

type ValidationIssue = {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
  relatedRuleIds?: string[];
};

type PolicyDiff = {
  basePolicyDigest: string;
  draftPolicyDigest: string;
  ruleChanges: RuleChange[];
  generatedSourceChanges: SourceChange[];
  impactSummary: ImpactSummary;
};

type ExplainTrace = {
  request: RedactedAuthorizationRequest;
  bundleDigest: string;
  decision: PolicyDecision;
  steps: ExplainStep[];
};

type PublishRequest = {
  documentId: string;
  expectedDraftVersion: number;
  expectedBasePolicyDigest: string;
  reviewId?: string;
  activationReason: string;
};
```

Unknown fields follow the document schema rule. A newer schema can preserve an opaque extension only when its namespace, digest behavior, compiler owner, and provenance are registered. Otherwise the server rejects the document. The client must not drop unknown fields during an edit.

### Validation, compilation, and round trip

The browser performs fast schema checks for feedback. The API repeats all structural checks and performs semantic validation. Only the server can compile, review, publish, activate, or roll back a bundle.

Validation checks descriptor versions, selectors, field types, operators, Boolean structure, effects, obligations, time bounds, sensitive values, authority, and publication permission. It also reports exact-target conflicts, same-specificity conflicts, organization and team denies, grants, overrides, plugin and risk defaults, approval obligations, unreachable rules, contradictory conditions, and effects that cross contexts through shared facts.

Preview calls `AuthorizationService` with either the active bundle digest or a server-compiled draft bundle digest. It never uses a browser evaluator or a separate preview resolver. Explain output shows matched and rejected rules, authority layers, computed specificity, conditions, defaults, grants, obligations, and the final reason code.

Compilation produces canonical Rego and data plus a source map from generated statements to document ID, rule ID, field path, author, and source version. Migrated and advanced sources carry the same map. The generated policy diff shows rule changes, data changes, generated Rego changes, digest changes, and sampled impact. The publisher never silently changes a rule to make it valid. It publishes the same content-addressed bundle, and future signed pin, for local OPA or `TvcAttestedEvaluator`.

A visual round trip must preserve semantics and provenance. If a published expression cannot map back to the current builder schema, the builder shows it as an unsupported read-only source. The user must create a migration issue or use an approved advanced path. Saving another rule must preserve the unsupported source byte-for-byte and include it in the policy digest.

Raw Rego is not a bypass. An advanced source must compile in the restricted package, return the typed decision shape, use registered input and data namespaces, declare rule IDs, produce source provenance, pass conflict checks, and reject forbidden built-ins or external access. If the compiler cannot prove these properties, publication fails.

### UX surfaces

The policy overview groups active rules by context and authority. It also shows inherited defaults, current bundle digest, draft state, review status, recent publications, and failures. A context picker starts a rule from a descriptor and states what the context protects.

The rule editor presents scope, subjects, target, decision, conditions, obligations, and time bounds in that order. The condition builder uses nested groups with keyboard-accessible add, remove, move, and grouping controls. Labels, descriptions, errors, and focus order must work with screen readers. Color is not the only signal for allow, approval, deny, conflict, or validation state.

The advanced editor shows structured source or Rego only when the advanced policy gate permits it. It always shows provenance requirements and generated output. The effective-policy view explains the active result for a selected subject and request. Request decision inspection opens the stored `ExplainTrace`, proof status, obligations, approval facts, and separate execution outcome.

Conflict preview identifies rules that overlap at exact targets or specificity tiers. Impact preview evaluates selected redacted samples against the active or draft bundle through `AuthorizationService`. It labels incomplete coverage and never claims that samples prove safety. Cross-context impact lists shared facts or obligations that changed.

Drafts save without activation. Review freezes a draft version and records reviewers, comments, validation results, source diff, and expected base digest. Publish requires a current validation result and any required approval. Activation uses compare-and-swap on the active digest. A stale base, missing review, compiler error, unknown extension, or failed audit write blocks publication.

Rollback creates a new draft from a prior published version and sends it through validation, review, publication, and activation. It does not move the active pointer without a new audit event. Safe defaults select the narrowest subject and target, no secret fields, no unbounded allow, and `require_approval` where the context supports it.

### API and security boundary

The API exposes design-level operations to read context descriptors, create and update drafts, validate, preview, explain, submit review, approve review, publish, list versions, and start rollback. Every mutating operation uses optimistic version checks. Publication also binds the expected active policy digest.

UI input is untrusted. The server authenticates the caller, authorizes the operation through the canonical service, validates tenant and owner scope, and revalidates the complete document. Cookie-authenticated mutations must apply the repository's origin and CSRF controls. API keys must have explicit policy-authoring scope and cannot inherit a browser user's authority.

Organization administrators can edit organization drafts under current policy. Team administration controls team drafts. Publication can require a different permission or reviewer set from editing. The final publish permission is an open design gate, but the server always enforces it. The browser never decides who can activate policy.

Policy documents contain references and typed constraints, not secrets. Sensitive condition values use server-held references or one-way digests where comparison permits them. API responses, validation issues, diffs, explain traces, audit, and telemetry apply registered redaction rules.

Each draft update, review action, publication, activation, rollback, and failed publication writes an audit event. Events identify actor, owner, document and version, source and result digests, review, validation summary, and reason. Published rule provenance then follows decisions into the decision audit.

### Migration of current authoring surfaces

The migration importer maps current sources into builder views:

- `action_policies` become organization or team action rules with target, matcher conditions, `appliesIn`, time bounds, and row ID provenance.
- `action_policy_overrides` become override-layer rules with their current bounds and source owner.
- `runtime_grants` become read-only session or workflow grant facts with approval and revocation provenance.
- plugin entitlements become entitlement-context rules while `packages/api/src/services/plugin-entitlements.ts` remains the initial storage adapter.
- plugin defaults and risk defaults become inherited read-only action layers.
- the standard bundle default becomes the final inherited layer.

The current organization and team forms can read imported builder projections during migration. At final cutover, each web or API policy authoring write must create or update and validate a canonical draft. The same transaction must publish and activate the draft before the write reports success. If activation fails, the write fails and the old active bundle remains. No endpoint can change effective policy without this transaction. Standalone draft saves remain non-enforcing.

The importer preserves original row IDs, source tables, timestamps, authors, matchers, and ownership in provenance. It rejects an expression that has no lossless builder or advanced-source representation. The migration records an explicit issue for that expression and blocks affected bundle activation. It never weakens, drops, or approximates the expression.

### Open policy builder gates

The implementation must resolve these gates before builder publication is enabled:

1. Decide whether the UI permits advanced Rego or only validated structured extensions.
2. Define who can register arbitrary condition schemas and compiler handlers.
3. Decide whether a draft can contain organization and team rules or must have one owner scope.
4. Set limits and indexing for large rule sets, validation, preview samples, and explain traces.
5. Select the default diff view for rule, generated Rego, data, and impact changes.
6. Define separate edit, review, approve, publish, and rollback permissions.

## Trust boundary

Attested execution can prove these claims:

- a measured evaluator build processed the request;
- the evaluator used the policy bytes named by `policyDigest`;
- the evaluator used the input bytes named by `inputDigest`; and
- the signed decision envelope contains the resulting decision.

Attestation does not prove that a host-supplied `userId`, team membership, resource owner, credential scope, approval fact, or policy source is true. A compromised Valet host can supply false facts and obtain a valid proof about those false facts.

Inputs that must survive a hostile host need a trusted issuer. Options include signed identity claims, signed policy pins, signed approval facts, TKMS-backed consensus records, or data fetched and verified inside the attested workload. The decision envelope must identify the issuer and digest for each rooted fact set. Audit and UI text must not describe an attested decision as proof of identity unless the identity inputs have such a root.

The local OPA phase trusts the Valet host for all facts and enforcement. The TVC phase reduces trust in evaluator code and evaluated-byte integrity. A later attested-execution phase can also move selected side effects behind the TVC boundary.

## Approval and replay semantics

A `require_approval` decision creates one durable gate bound to `requestSubjectDigest` and the original decision digest. Resolution is append-only. The first valid terminal resolution wins. Repeated delivery of the same resolution ID returns the stored result. A different terminal resolution for the same version is rejected.

An `approve_once` resolution authorizes one replay of the same request subject. A session or workflow grant creates a separate dynamic fact with its own durable ID and scope. An always-allow action uses the transactional policy authoring write to activate a new bundle. It does not mutate the original decision.

After approval, Valet re-evaluates the request with the approval fact or grant included. It does not execute only because a UI callback said yes. The new decision must bind the same request subject. A changed parameter, resource, actor, or target produces a different subject and requires a new decision.

If a restart occurs after approval but before execution, the same idempotency key returns the stored post-approval decision. Valet executes at most once when the target operation supports idempotency. If the target cannot provide idempotency, the execution record must show an indeterminate outcome rather than silently retrying a side effect.

## Obligations and redaction

A decision can include typed obligations. Initial obligations can require an approval tier, restrict a credential owner, constrain egress hosts, limit sandbox capabilities, require target idempotency, or redact named JSON paths from logs and user-visible explanations.

The enforcement point must understand every obligation before it acts. An unknown, malformed, or unfulfilled obligation changes the effective result to deny. The evaluator does not return executable code as an obligation.

Redaction occurs before persistence and telemetry export. Audit records retain canonical digests even when raw fields are removed. Valet stores raw sensitive inputs only where an existing product requirement needs them and an explicit retention rule permits them. Proof envelopes never include credential secrets or raw tool parameters.

## Audit model

Valet stores decision and execution records separately.

A decision record contains request ID, idempotency key, request subject digest, input digest, policy digest, evaluator identity, effect, reason code, matched rule IDs, obligations, approval requirement, proof material, and verification result. It also records whether identity and policy facts were host-asserted or rooted in a trusted issuer.

An execution record contains decision record ID, attempt ID, start and finish times, outcome, target idempotency key, redacted result or error, and external operation identifiers. `allowed` is not an execution outcome. `completed` is not a policy decision.

Audit writes are durable in Valet for both evaluator types. A TVC replica is stateless. It can return the same signed response for the same request, but Valet owns request reservation, replay detection, approval state, proof retention, execution attempts, and operator-visible audit history.

## TVC attested evaluator

### Deployment model

`TvcAttestedEvaluator` uses a pool of stateless TVC replicas. Any healthy replica can evaluate any request from the same deployment. Replicas hold no durable session, grant, approval, or idempotency state. Valet selects the active static bundle and sends the complete evaluated input.

TVC public ingress currently supports HTTP/1 applications. The client uses HTTP/1.1 request and response semantics. It does not require HTTP/2, WebSockets, server push, or streaming bodies. Requests and responses have explicit byte limits, content type, schema version, and timeout. Retries use the same request ID and idempotency key.

The API boundary is conceptually:

```text
POST /v1/authorize
Content-Type: application/json

{ request, canonicalInput, policyBundle, expectedPolicyDigest }

200
{ signedDecisionEnvelope, appProof, bootProofRef }
```

Production can send a content-addressed bundle reference instead of all bytes after TVC supports a trusted immutable bundle store. The response still binds the exact digest.

### Signed decision envelope

The TVC envelope is signed by the enclave Ephemeral Key. Its App Proof payload includes:

- proof type and schema version;
- deployment and evaluator build digest;
- request ID and request subject digest;
- input and policy digests;
- decision digest and effect;
- obligation digest;
- replica ephemeral public key; and
- a nonce supplied by Valet to prevent response substitution.

Valet verifies the envelope before enforcement. It verifies the App Proof signature, then verifies that the App Proof key equals the `public_key` in a valid Boot Proof. Boot Proof verification checks the AWS attestation chain, expected PCR values, QOS manifest binding, application digest, operator approvals, and expected TVC account or deployment identity. Valet rejects debug-mode deployments, including attestations with zero PCR values. Valet pins acceptable application and manifest identities through release configuration.

A proof verification failure is a deny. A valid proof with a mismatched request ID, nonce, subject digest, input digest, policy digest, decision digest, or expired verifier freshness window is also a deny.

Public references:

- [TVC overview](https://docs.turnkey.com/features/verifiable-cloud/overview)
- [TVC proofs and verification](https://docs.turnkey.com/features/verifiable-cloud/proofs-and-verification)
- [Turnkey Verified](https://docs.turnkey.com/security/turnkey-verified)
- [TVC policy engine prototype](https://github.com/tkhq/test-tvc-policy-engine/tree/spec/policy-engine-prototype)

The prototype is useful input, but this design overrides its shadow rollout, global deny semantics, fallback behavior, and decision-cache suggestions.

### Future attested execution

Policy evaluation alone cannot prove Valet enforced a deny or that an allowed action used the evaluated parameters. The end state can place selected action execution in the same measured TVC application or in a second attested executor. An execution App Proof then binds the authorization decision digest, exact action input digest, credential or key reference, and execution result digest.

A future TKMS role is optional. TKMS can custody an execution key, co-sign the TVC decision or execution record, or enforce consensus before releasing authority. This uses public Turnkey activity and proof interfaces. `TvcAttestedEvaluator` stays independent of internal UMP.

## Surface migration

### RBAC, PBAC, and ABAC

Existing role and membership checks become facts and Rego rules. Permission-based access control supplies named actions. Role-based access control maps organization and team roles to those actions. Attribute-based access control uses resource ownership, session purpose, workflow context, risk, credential scope, and request parameters.

The labels describe authoring inputs, not separate runtime engines. OPA evaluates the combined request once.

### Action policies

`action_policies`, `action_policy_overrides`, and `runtime_grants` remain authoring and fact storage during migration. The compiler maps them into Rego and canonical data. Their current matcher operators, context scope, team behavior, and provenance IDs remain representable.

The final cutover deletes the TypeScript precedence evaluator. Policy CRUD can keep structured rows as canonical authoring data if the UI needs them. Each policy authoring write must validate, publish, and activate its canonical draft in one transaction before it reports success. If activation fails, the write fails and the old active bundle remains.

### Resource access

Checks now spread across services such as `packages/api/src/services/session-access.ts`, artifact services, workflow routes, assistant access, team services, and owner filters. Migration under TKAI-370 will define canonical resource types, actions, ownership facts, and concealment obligations. Route adapters keep authentication and input parsing. They ask `AuthorizationService` before returning or mutating a resource.

A policy decision does not replace query scoping. List queries must still limit candidate rows by tenant and permitted owner scope. The service can return a typed query obligation for supported list operations. It must not authorize an unbounded read followed by application filtering.

### Entitlements

`packages/api/src/services/plugin-entitlements.ts` remains the storage and fact adapter. Rego decides effective entitlement from instance availability, organization mode, team membership, and caller. Session assembly, create routes, and navigation visibility use one decision reason.

### Delegation and inter-agent policy

TKAI-433 work maps allowed parent, child, orchestrator, workflow, and signal edges into `agent.signal`, `delegation.create`, and `tool.builtin` requests. A child receives an explicit authority set derived from the parent request. It does not inherit ambient authority by copying host context.

The `task`, `child_read`, `child_send`, and cross-orchestrator signal paths each submit a request. The request binds parent, child, actor, owner, org, target session, requested model tier, sandbox profile, and repository scope where relevant. Cross-org edges deny by default. Hop limits remain an execution safeguard and also appear as facts.

### Built-ins, sandbox, credentials, and egress

Built-in tools go through the same pre-execution adapter as plugin actions. File and shell tools can use capability decisions rather than action-specific policy. The local sandbox remains the enforcement boundary for filesystem and process access.

Sandbox creation requests authorize profile, Docker, CPU, memory, image, mounts, terminal access, and provider-specific capabilities. Credential decisions bind service, credential owner, delegation source, session or workflow owner, and requested use. Secret material is resolved only after an allow decision and never enters policy input.

Egress decisions bind normalized scheme, host, port, action, session, and declared scope. DNS resolution and network enforcement remain in the egress control. Policy supplies the allowed destination and obligations. Rebinding, redirects, and IP-range checks remain enforcement concerns.

## Failure behavior

The system fails closed for these conditions:

- no active bundle;
- invalid Rego or invalid decision output;
- bundle, input, or subject digest mismatch;
- evaluator timeout, crash, or unavailable local OPA runtime;
- missing required facts;
- stale or conflicting approval resolution;
- unknown obligation;
- TVC network error or malformed response;
- invalid App Proof or Boot Proof;
- no trusted manifest or application digest; and
- audit reservation failure before an external side effect.

For action requests that can ask a human, policy can return `require_approval`. Infrastructure failure does not synthesize approval. It denies with a corrective operator reason. Today, an interactive personal-session resolver or policy-store error becomes `require_approval` with `resolver_error` provenance. The cutover intentionally changes that behavior to deny. This also differs from the prototype's unattested approval fallback.

There is no decision cache initially. Every request evaluates against the active bundle and current fact snapshot. OPA can prepare a bundle in memory, but Valet must atomically replace that prepared instance when the active digest changes. A later cache needs a separate design that covers revocation, dynamic facts, proof replay, and bounded staleness.

Operational metrics include evaluation count and latency by kind and effect, active bundle digest, bundle activation failures, fail-closed reason counts, obligation failures, proof verification failures, approval age, idempotent replays, and decisions without execution outcomes. Metrics use IDs and digests, not raw parameters.

## Threat model

| Threat | Control and remaining limit |
|---|---|
| Prompt injection requests a dangerous action | The model cannot bypass the host enforcement point. A missing enforcement point remains a code defect. |
| Workflow and interactive paths disagree | Both paths use one service. Cross-path tests expect equal decisions only when `appliesIn` and all session or workflow-scoped facts are equal. |
| A broad allow bypasses a narrow deny | Specificity and tie semantics are encoded once in Rego. Migration checks current row snapshots. |
| A grant is replayed in another session or run | Grant facts and approvals bind the stable request subject and scope IDs. |
| Policy bundle is changed or rolled back | Digests, activation history, and future signed pins make changes visible. Local host compromise can still alter local state. |
| Valet host lies about identity or membership | Attestation proves evaluation of the lie, not its truth. Trusted issuers are required for stronger claims. |
| TVC response is forged or substituted | App Proof and Boot Proof verification bind the ephemeral key, build, request nonce, and digests. |
| A valid allow is reused for different parameters | Subject and input digest checks reject the response. No decision cache exists. |
| A decision is allowed but execution differs | Current Valet audit detects only what the host records. Future attested execution binds the decision and action input. |
| Sensitive input leaks through audit or proofs | Redaction runs before persistence. Proofs contain digests, not raw secrets or parameters. |
| Evaluator outage causes fail-open | All evaluator and proof failures deny. No runtime legacy fallback exists. |
| Database operator drops audit rows | Valet monitoring can detect sequence gaps and missing outcomes. Future signed or chained records improve external verification. |

## Immediate Valet implementation

Preparatory pull requests add typed contracts, digest helpers, the bundle compiler, the local OPA library, and inert adapters. They do not change production decisions.

The one replacement pull request then:

- creates the production `AuthorizationService` with local OPA as its only evaluator;
- activates the compiled policy bundles;
- converges interactive and workflow action paths;
- moves `packages/api/src/workflows/permissions.ts`, the `upsertOverride` guard in `packages/api/src/policies/admin.ts`, and the preview in `packages/api/src/routes/policies.ts` to the canonical service;
- requires each web and API policy authoring write to validate, publish, and activate its canonical draft in one transaction before success;
- keeps the old active bundle when that transaction fails;
- removes forms and endpoints that can change effective policy without this transaction;
- activates deterministic approval replay and split decision and execution audits;
- removes the old TypeScript action-policy evaluator from every runtime, preview, and write guard; and
- adds no shadow mode or legacy runtime fallback.

Later pull requests can route built-in tools and adjacent domains through the same service. Those domains keep their current checks until their own atomic cutover. They must not create another policy evaluator. The action-policy engine itself is replaced in one cutover.

## Future TVC and TKMS work

Later pull requests implement:

- `TvcAttestedEvaluator` over HTTP/1.1;
- App Proof and Boot Proof verification;
- signed policy pins and trusted identity or approval facts;
- stateless TVC replica deployment;
- optional encrypted request bodies if ingress confidentiality requires it;
- selected attested action execution; and
- optional TKMS key custody, co-signing, or consensus without UMP coupling.

These changes replace the evaluator behind the contract. They do not revive the old resolver.

## Acceptance scenarios

### Action precedence migration

An org denies a service but allows one exact action. A team requires approval for that same action. A session grant covers the action. The compiler preserves both specificity and authority layers. The exact org allow beats the broader org deny. The team approval requirement remains. The grant then allows the session request. An exact team deny would still block it.

### Cross-path convergence

An interactive `call_tool` request and a workflow tool node use the same service, fully qualified action ID, actor, owner, parameters, and grants. When both requests also use the same `appliesIn` value and the same session or workflow-scoped facts, both receive the same decision, reason, rules, and obligations. A real session request and workflow request can differ when an `appliesIn` rule or a scoped grant intentionally distinguishes them.

### Approval replay

A critical action returns `require_approval`. Valet persists the decision and gate. A user approves once. Valet re-evaluates with a fact bound to the original subject. The process restarts before execution. The repeated request returns the stored post-approval decision. A request with one changed parameter has a different subject and does not reuse the approval.

### Resource and delegation access

A current team member opens a team session and asks a child to act on a team resource. Valet authorizes the route, child creation, credential use, and action through the same service. If membership is removed before the action, the fresh fact snapshot denies access. No personal credential fallback occurs.

### TVC verification

A TVC replica returns an allow decision with a valid App Proof. Valet verifies the linked Boot Proof and all expected digests. It then enforces obligations. If the host changes the resource ID after evaluation, the request subject digest no longer matches and execution is denied.

### Fail-closed operation

The active OPA bundle is invalid or unavailable. Valet records a denied decision with an operator-safe reason. It does not use risk defaults, old TypeScript matching, or human approval as infrastructure fallback.

## Open questions and decision gates

1. **OPA runtime:** Choose WebAssembly, an embedded runtime, or a managed local sidecar. The gate is bounded latency, deterministic bundle replacement, maintained Node support, and no decision-time network lookup.
2. **Bundle publication transaction:** Define the database transaction boundary for authoring rows, bundle versions, the active pointer, and audit. The write cannot report success before activation.
3. **Policy source signatures:** Decide when local policy administration must produce signed pins, before TVC or with TVC.
4. **Identity roots:** Select trusted issuers for user, team, workload, and service identities. Host assertions remain explicit until then.
5. **List authorization:** Define the limited query-obligation vocabulary before route and resource cutover.
6. **Built-in granularity:** Decide which file, process, and child operations need action rules versus capability classes.
7. **TVC confidentiality:** Confirm current ingress and enclave transport. Add application-level encryption if plaintext can cross an operator-visible hop.
8. **Proof retention:** Set retention and external anchoring requirements for Boot Proofs, App Proofs, policy bundles, and audit records.
9. **Attested execution scope:** Select the first action families whose execution must move into TVC.
10. **TKMS role:** Choose among key provider, co-signer, consensus approver, or no dependency for each attested action family.

The login-gated Valet artifact at `https://valet.dev.agents.turnkey.engineering/a/mfhW_E7IpUksh-W0CpMNBw` was inaccessible during research. Treat it as an internal follow-up reference. This design does not claim to incorporate its contents.
