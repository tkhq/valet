# Reusable workflow approvals redesign

Status: proposed.
Date: 2026-09-14.
Base: `dev-v2` at `a962f97b1ffe4691367ec2c114a1cc3af01e83c8`.
Replaces: the closed PR #710 and its branch. This design requires a fresh implementation from `dev-v2`.
Related: `2026-08-14-workflow-approval-ux-design.md`, `2026-09-13-workflow-action-required-design.md`, `2026-09-14-slack-workflow-approval-callbacks-design.md`, and `2026-07-16-action-policies-audit-design.md`.

## Purpose

Workflow policy gates currently support approve-once, run grants, and org-wide policy changes. They do not support a narrow approval that survives the current run. This specification adds a 90-day durable approval for one workflow tool node, one exact effective argument set, and one exact authority binding.

Approve-once remains the primary action. Durable approval is secondary, confirmed, and available only on the web. Slack, Telegram, and agent callbacks continue to offer approve-once or deny.

This document is an architecture specification. It defines durable identity, authorization, concurrency, lifecycle, wire, and rollout behavior. It does not define an implementation sequence.

## Requirement language and terms

The words MUST, MUST NOT, SHOULD, and MAY are normative. Other text explains the current system or a decision.

**Approve-once**: the existing approval signal authorizes one parked invocation.

**Durable grant**: an immutable audit row that can authorize later matching invocations for 90 days.

**Variant**: one full fingerprint of principal, workflow, node semantics, effective arguments, decisive policy authority, action contract, and credential binding.

**Live slot**: the one non-revoked, non-superseded grant row permitted for a variant.

**Decisive authority**: the single rule or default that makes the live policy decision `require_approval`.

**Credential incarnation**: one immutable database-minted identity for a credential row's continuous existence.

**Credential version**: a monotonic integer that changes when the credential's semantic authority changes.

**Membership epoch**: one database-minted identity for a continuous team membership.

**Binding snapshot**: non-secret metadata that identifies the authority selected for an invocation.

**Secret snapshot**: the resolved credential material used by one provider invocation.

## Current Valet seams

The design extends these current seams and conventions:

- `packages/workflow/src/nodes/tool.ts` renders tool parameters, parks on `approval:{nodeId}[:{iteration}]`, and uses `approval:{nodeId}[:{iteration}]:resolution` for the deterministic resolution signal.
- The same executor stores gate data in the intent checkpoint and invokes before `consumeSignalAndCheckpoint`. The deterministic invocation ID gives logical retry deduplication.
- `packages/api/src/workflows/service.ts#resolveWorkflowApproval` authorizes a parked gate, inserts a signal, and requests a wake. Its current grant and signal writes are separate.
- `packages/api/src/workflows/pg-store.ts#insertSignal` uses `ON CONFLICT DO NOTHING`. The unique key is `(run_id, signal_id)`.
- `packages/api/src/plugins/action-invoker.ts` resolves a plugin action, enforces policy, validates and applies defaults with `prepareActionArgs`, and invokes the action.
- `packages/api/src/policies/resolution.ts` defines current policy precedence. Org deny and team deny dominate. Runtime grants, overrides, policies, plugin defaults, and risk defaults follow.
- `packages/api/src/schema/index.ts` and `packages/api/migrations/pg/0000_app.sql` define app tables. Valet edits `0000_app.sql` in place before 1.0.
- `packages/api/src/lib/drizzle.ts#SCHEMA_REPAIRS` repairs deployed pre-1.0 databases during startup.
- `packages/api/src/services/teams.ts` owns normal team membership writes. Provisioning, configuration reconciliation, and explicit join eligibility also insert or update `team_members`.
- `packages/api/src/services/teams.ts#canAdministerTeam` admits an off-team org admin. Durable team grant creation requires the narrower `team_members.role = 'admin'` fact.
- `packages/api/src/services/credential-resolution.ts`, `packages/api/src/services/github-tokens.ts`, and `packages/api/src/plugins/action-invoker.ts` implement credential selection and delegated reads.
- `packages/api/src/plugins/oauth-refreshing-credential-store.ts` performs operational OAuth refresh writes. `packages/api/src/services/credential-insert.ts` also writes credentials through direct SQL paths.
- `packages/api/src/lib/secret-crypto.ts` derives the credential encryption key from the deployment passphrase. Durable digest keys use this existing passphrase boundary.
- `GET /api/workflows/runs/:runId` and `GET /api/workflows/action-required` project the same parked gate to two web surfaces.

PR #710 is not an implementation base. A new implementation MAY reuse an authorization or atomic-persistence concept only after checking it against these current seams and this specification.

## Global invariants

**INV-1, live policy first.** Every use MUST resolve live policy before consulting a durable grant. A live deny blocks. A live allow needs no grant. Only `require_approval` can consult a grant.

**INV-2, no secret identity.** A fingerprint MUST NOT include or persist a token, API key, password, ciphertext, decrypted secret, or secret-derived value.

**INV-3, exact authority.** A durable grant MUST bind one node, one exact effective argument set, one decisive policy authority, one action contract, and one credential binding.

**INV-4, continuous authority.** A team grant MUST bind the approver's current admin membership epoch. Leave and rejoin MUST never revive it.

**INV-5, atomic resolution.** Durable grant creation or reuse selection and signal arbitration MUST commit in one database transaction.

**INV-6, immutable audit.** A retained grant row MUST NOT be overwritten. Revocation and supersession facts are write-once.

**INV-7, one live slot.** At most one row can hold the live slot for one full variant fingerprint.

**INV-8, fail closed.** Missing revisions, unknown digest formats, incomplete bindings, stale membership, and failed final revalidation MUST prevent durable reuse.

**INV-9, safe projection.** Public APIs MUST NOT expose internal digests, raw parameters, credential references, or sensitive policy details.

**INV-10, startup readiness.** Startup migration and repair code is the only schema-readiness owner. Requests MUST NOT probe the catalog or synthesize a schema-repair gate state.

## Product behavior

### Approval scopes

The policy gate keeps its existing approve-once behavior as the primary action. The web adds a secondary action named **Approve for this workflow**. That action creates or reuses a durable grant.

The durable action MUST show a confirmation. The confirmation MUST name the principal, workflow, node or safe action label, and fixed expiration date.

Slack, Telegram, and agent approval callbacks MUST reject or omit a durable scope. They continue to submit approve-once or deny only.

A durable grant is node-scoped. It does not cover a whole workflow definition. Several exact argument variants MAY coexist for one node. Creating one variant MUST NOT supersede another variant on the same node.

### Principals

V1 supports user and team principals.

A user-principal durable grant requires the current user to approve their own gate. Reuse requires the same user principal.

A team-principal durable grant requires an actual current `team_members` row with `role = 'admin'`. `canAdministerTeam` is insufficient because it also admits off-team org admins. Reuse requires the recorded approver to remain a current admin in the same membership epoch.

Current team members MAY list team grants. Team members and org admins MAY revoke team grants. Org admins MAY list and revoke grants across their organization. These management rights do not permit an off-team org admin to create a team durable grant.

Org-principal gates remain approve-once in V1. `org_members` has no membership epoch. A future org-principal design requires `org_members.membership_epoch` first.

## Durable identity

### Credential incarnation and version

Each durable Valet credential row MUST have:

- A database-generated immutable `credential_incarnation_id`.
- A database-defaulted monotonic `credential_version`, initially 1.

Deleting and recreating a credential MUST produce a new incarnation ID. A reconnect, manual replacement, account change, scope change, reference change, requested mode authority change, or other authority change MUST increment `credential_version`. If continuity cannot be proven, the writer MUST increment the version.

Routine OAuth access-token refresh, refresh expiry updates, health metadata changes, and GitHub installation-token reminting MUST preserve incarnation and version. These are operational mutations.

All credential SQL writes MUST converge on one API-host mutation owner. Every call MUST declare semantic or operational intent. A standalone `bumpCredentialVersion` helper is insufficient because another path could bypass it.

The mutation owner MUST compare the expected incarnation and version for an operational refresh. It MUST update only the same row and version. A raced reconnect or semantic replacement MUST win, and the stale refresh MUST NOT overwrite it. The refresh caller MUST re-read or return the winning row after a compare failure.

This owner includes current `CredentialStore.save` paths, `replaceCredential`, conditional inserts, team 1Password writes, OAuth refresh health stamps, connect callbacks, GitHub user-token refresh, delegation writes, and configuration reconciliation. Direct tests can seed rows, but production SQL writers MUST use the owner.

### Credential selectors

A credential selector records the requested mode separately from the resolved binding. The value `auto` is a request, not an identity.

A stored Valet credential binding MUST contain its durable row locator, incarnation ID, and credential version. The locator is the persisted `(owner_type, owner_id, service)` tuple. Mutable login, account labels, and display metadata MUST NOT provide authority.

A GitHub App binding MUST contain `org_id`, numeric installation ID, and a monotonic semantic configuration revision. Installation-token reminting does not change this binding. App replacement, installation replacement, authority changes, and selector-precedence changes MUST change the binding revision or resolved binding.

A delegated binding MUST contain:

- The delegation row locator, incarnation ID, and version.
- The effective source row locator, incarnation ID, and version.
- The delegator's team membership epoch.

A separate delegation epoch MUST NOT exist. The delegation row incarnation and version already identify continuous delegation authority.

A selector precedence change that resolves the same `auto` request to a different binding MUST prevent reuse. The requested mode remains stored for explanation and semantic projection.

### Team membership epochs

`team_members.membership_epoch` MUST have a database default that mints a new opaque value on every insert. Existing rows receive one value during startup repair.

Role-only updates MUST preserve `membership_epoch`. Every `ON CONFLICT` role update MUST update only the role and preserve the epoch. A delete followed by any insert MUST mint a new epoch.

This rule applies to all production insert paths, including team creation, `addMember`, explicit join eligibility, auth provisioning, identity-provider sync, and configuration reconciliation.

A demotion from admin to member makes a team grant dormant. Promotion to admin within the same epoch can reactivate it. Leave and rejoin creates a new epoch and can never reactivate the old grant.

### Policy authority revisions

Both `action_policies` and `action_policy_overrides` MUST have a semantic `revision` starting at 1. Each row keeps its immutable row ID.

A revision MUST increment for each decision-relevant mutation. This includes mode, target, matchers, application context, expiry, precedence inputs, revoke, and reinstate. Exact idempotent replay and configuration reconciliation that changes no decision input MUST preserve the revision.

The policy resolver MUST return one discriminated decisive authority for a `require_approval` decision:

- `{ kind: 'policy', rowId, revision, principalType }` for an `action_policies` row.
- `{ kind: 'override', rowId, revision }` for an `action_policy_overrides` row.
- `{ kind: 'plugin_default', pluginId, pluginVersion }` for a plugin default.
- `{ kind: 'risk_default', revision }` for the built-in risk default.

The built-in risk revision is a named semantic constant in source. A semantic change to low, medium, high, or critical defaults MUST change it.

The binding MUST NOT contain an array of every loaded rule. Unrelated policy edits therefore do not invalidate a grant. Revoking and recreating a rule produces a new authority identity. Reinstating a row increments its revision. Neither action revives an old grant.

The resolver MUST make precedence deterministic before it emits the decisive authority. A precedence change that selects another row or default prevents reuse.

### Tool semantic projection

`@valet/workflow` owns a pure versioned semantic projection and canonical JSON function. The API host owns HMAC and key operations.

The V1 projection MUST include these execution-relevant `ToolNode` fields:

- Service and action.
- Parameter template.
- Requested credential mode.
- `onDeny`.
- `approvalTimeout`.
- `onError`.

The projection MUST normalize omitted values to their current execution defaults. This prevents omitted and explicit defaults from producing accidental variants.

The projection MUST exclude summary and UI fields, whole-definition version, graph edges, enclosing `foreach` settings, and iteration. It MUST also exclude retries because `ToolNode` has no retries field.

The projection carries a format version. Canonical JSON MUST sort object keys, preserve array order, reject unsupported values, and produce one UTF-8 representation for equivalent inputs.

An exact semantic edit creates a new variant. Restoring the exact node semantics within the grant lifetime MAY reactivate the old variant. Iteration remains part of the existing one-time signal and invocation identity only.

### Effective arguments and action contracts

For a static action, the host MUST render parameters and load the non-secret static action contract. It MUST validate and apply defaults before policy matching and durable argument digesting. The same validated, default-applied effective arguments SHOULD feed parameter policy matching where applicable.

The action contract binding MUST contain the qualified action ID, plugin ID, plugin version, and a stable semantic revision for the action schema and default behavior. A contract change prevents reuse.

Dynamic or authenticated action discovery is durable-ineligible in V1 unless it provides a stable non-secret contract revision before gate-time secret resolution. Environment credentials and externally mutable 1Password references are also durable-ineligible unless the host can obtain a stable non-secret credential revision without resolving a secret before the gate.

The host MUST NOT fingerprint or persist resolved secret material. Truncated display parameters do not affect eligibility because identity uses effective arguments before display truncation.

### Keyed digests

The API host computes exact argument and full variant digests with a host-keyed HMAC. The key derivation MUST use Valet's existing encryption-passphrase boundary with a distinct reusable-approval domain label. V1 MUST NOT add a key-ring subsystem.

Each digest envelope MUST identify its algorithm and key-format version. HMAC input MUST include the organization ID and a domain label. This provides organization and purpose separation.

A rotation or unrecognized version MUST fail closed. Existing grants then do not match. The service MUST NOT expose internal digests on any public wire.

## Grant record and slot model

The implementation adds one durable grant table. The exact table name is an implementation detail, but its contract is fixed.

Each row MUST preserve these immutable creation and binding facts:

- Grant ID, organization, principal type, and principal ID.
- Workflow ID and node ID.
- Safe service, qualified action, and display labels.
- Projection format and node semantic digest.
- Effective argument digest.
- Requested credential mode and exact resolved credential binding.
- Decisive policy authority.
- Action contract binding.
- Full variant fingerprint and digest format.
- Approver user ID, creation role, and team membership epoch when applicable.
- Source run ID and source signal ID.
- `created_at` and `expires_at`.

Each row MAY later receive these write-once facts:

- `revoked_at` and `revoked_by`.
- `superseded_at` and `superseded_by`.

The table MUST NOT persist an active or inactive enum. It MUST NOT persist a mutable inactive reason. Listing and use derive current status and reason from live facts.

A partial unique index MUST enforce one live slot per full variant fingerprint where `revoked_at IS NULL AND superseded_at IS NULL`. The index predicate MUST NOT contain `now()`.

Revoked rows release their slots. Retained rows are never overwritten. A revoked grant does not return to its slot.

An expired row still owns its live slot until a reapproval supersedes it. Reapproval after expiry MUST write `superseded_at` and `superseded_by` on the expired row, then insert a new row. Both changes occur in the resolution transaction.

An exact retry MUST replay before any slot mutation. A second already-parked gate that matches an existing unexpired live grant MUST select that grant and signal success without extending `expires_at`.

The fixed expiry is `created_at + 90 days`. No caller can choose another duration.

## Atomic approval resolution

### Port boundary

The implementation MUST NOT add `WorkflowStore.withTransaction` or another generic transaction API.

The API defines a narrow local port named `WorkflowApprovalResolutionPort`, or an equally specific name. Its PostgreSQL implementation lives beside or within `PgWorkflowStore`, where one database transaction can reach grants and `workflow_signals`.

A separate API-local in-memory implementation is the reference for a shared conformance suite. The existing core `WorkflowStore` interface and conformance suite remain unchanged.

The resolution port accepts a deterministic signal intent and an optional durable grant intent. It returns exactly one arbitration result:

- `inserted`, with the selected or created grant when present.
- `replay`, with the original stored success.
- `conflict`, with no mutation from the losing intent.

The workflow resolution route MUST use this port. It MUST NOT insert `workflow_signals` directly.

### Retry identity and comparison

The existing deterministic resolution signal ID remains `approval:{nodeId}[:{iteration}]:resolution`. The route relies on the parked server state or an opaque server token. The browser sends no authority claims.

A retry comparison MUST normalize and compare the complete payload:

- Decision.
- Actor.
- Note.
- Channel.
- Scope.
- Selected or reused grant ID.

The port MAY also store internal binding evidence needed to audit the choice. That evidence must match for replay.

The same signal ID and exact normalized payload returns the stored success. The same signal ID with any differing field returns conflict. Omitted optional values and explicit null values use one documented normalization.

The port MUST check exact retry before it revokes, supersedes, inserts, or claims a live slot. An injected failure at any point rolls back both grant and signal facts.

### Wake behavior

The transaction commits before the route requests a wake. The route MUST request a wake only after `inserted` or `replay` succeeds.

Wake is retriable. A wake failure does not roll back a committed approval. A later request, sweep, or retry can request wake again.

## Execution lifecycle

### Initial gate evaluation

A workflow tool invocation uses this order:

1. Render the node parameter template.
2. Load the non-secret static action contract.
3. Validate arguments and apply defaults.
4. Resolve complete live policy with the effective arguments.
5. If policy is deny, block the node.
6. If policy is allow, invoke without a durable grant.
7. If policy is `require_approval`, resolve only credential binding metadata.
8. Look up one exact durable variant.
9. If no valid variant exists, park an approve-once gate with durable eligibility metadata.

Dynamic discovery that needs a credential cannot pass step 2 in V1. The run parks as approve-once with a finite durable-ineligibility reason when policy requires approval.

### Durable approval

At durable approval time, the server MUST re-read and authorize every binding. It checks the parked run and signal, principal, approver role, membership epoch, live policy and decisive authority, node semantics, effective arguments, action contract, and credential binding.

A live deny refuses the resolution and writes neither grant nor signal. A live allow resolves without creating a durable grant because no approval is needed. A `require_approval` decision can create or select the exact grant.

Team creation checks an actual locked `team_members` admin row and captures its epoch. The transaction must prevent concurrent role change or removal from invalidating the authorization before commit.

### Wake and reuse

At wake and at every later reuse, the host MUST perform final fail-closed checks for:

- Complete live policy and the same decisive authority.
- Principal and organization.
- Team approver membership epoch and current admin role.
- Node projection and projection version.
- Effective arguments.
- Action and plugin contract.
- Requested credential mode and exact resolved binding.
- Grant expiry, revocation, and supersession.

A final live deny blocks. A final allow invokes without relying on the grant. A final `require_approval` needs a matching grant.

A dormant result does not mutate the grant. The host parks approve-once and derives a finite non-sensitive reason for the wire.

After authorization, the host resolves one secret snapshot. It compares the snapshot's non-secret binding to the authorized binding. It invokes the provider with that same snapshot.

The host MUST NOT resolve the secret before authorization. It MUST NOT resolve the credential a second time for invocation. These rules prevent a binding check on one credential followed by use of another.

The host MUST NOT hold database locks across plugin discovery, provider calls, or action execution. Database atomicity does not cover an external side effect. The deterministic invocation ID provides logical deduplication only. Plugins and providers still define their external idempotency behavior.

### Derived status

Listing and reuse derive status from current facts. The stable reason vocabulary MUST be finite and non-sensitive. It includes at least:

- `active`.
- `expired`.
- `revoked`.
- `superseded`.
- `approver_not_admin`.
- `membership_changed`.
- `principal_changed`.
- `node_changed`.
- `arguments_changed`.
- `policy_changed`.
- `action_contract_changed`.
- `credential_changed`.
- `unsupported_binding`.
- `digest_version_unknown`.

The public wire MAY combine internal causes into fewer safe reasons. It MUST never include row locators, credential references, digests, raw arguments, or policy matcher values.

Admin to member is dormant while the user is demoted. Promotion in the same membership epoch can reactivate the grant. Leave and rejoin never reactivates it.

Exact node restoration can reactivate a grant. Credential, policy, and delegation bindings never revive because their incarnation or semantic revision is monotonic.

No read path writes an invalidation. No reconciler mutates status.

## Management authorization and privacy

Grant management MUST establish the caller's organization scope before looking up a grant ID. A foreign grant ID and an unknown grant ID return the same response.

Management authorization is independent of workflow-content visibility. An org admin can list and revoke organization grants without access to the workflow body. A current team member can list and revoke team grants under the selected team scope. A user can list and revoke their user-principal grants.

Public list rows contain only safe labels, creator, principal scope, workflow and node labels when safe, timestamps, and derived status or reason. They exclude raw parameters, argument and variant digests, credential references and selectors, membership epoch, and sensitive policy internals.

Revocation is explicit and idempotent. The service sets `revoked_at` and `revoked_by` once. A second authorized revoke returns the current revoked result without changing audit facts.

## Web and channel surfaces

Both the run detail response and global Action Required response MUST derive `reusable` and `reusableReason` through one server helper. The value represents the current parked state. It is advisory until the server repeats all checks at submission.

`reusableReason` is a finite non-sensitive value. Examples include `eligible`, `principal_not_supported`, `team_admin_required`, `dynamic_action`, `environment_credential`, `external_reference_unversioned`, `binding_unavailable`, and `legacy_gate`.

The browser submits only the decision, note, and requested scope. It MUST NOT submit a principal, role, membership epoch, credential selector, policy authority, action contract, node digest, argument digest, or expiration.

The server derives authority from parked state or an opaque server token. The token, if used, identifies server state and does not replace live authorization.

The web confirmation MUST state the principal, node or safe action label, and exact 90-day expiration. Approve-once remains the primary control. Durable approval remains secondary.

Slack, Telegram, and agent surfaces cannot request durable scope. A crafted channel or agent request for durable scope is refused before mutation. The current channel callback existence-hiding rules remain in force.

A gate parked before deployment has no complete binding. It remains approve-once. The wire returns `reusable: false` and `reusableReason: 'legacy_gate'`.

## Schema readiness and retention

Implementation edits `packages/api/migrations/pg/0000_app.sql` in place and adds matching `SCHEMA_REPAIRS` entries in `packages/api/src/lib/drizzle.ts`. This follows Valet's pre-1.0 convention.

Startup migrations and schema repairs are the only readiness owner. If a repair fails, the API remains unready or startup fails. A request MUST NOT query catalogs for feature readiness. The gate state MUST NOT contain `schema repair missing`.

One cleanup owner deletes grant audit rows only after `expires_at + 90 days`. Cleanup uses an injected clock and is idempotent.

The audit window is therefore deterministic: 90 active days followed by 90 days after expiry. A row that becomes dormant or revoked early can remain longer than 90 days because deletion still keys from `expires_at + 90 days`.

Cleanup MUST NOT change status before deletion. It can delete expired rows regardless of dormant, revoked, or superseded state after the retention boundary.

## Rollout and observability

Implementation MAY use reviewable pull requests of about 500 changed lines. Every partial step stays behind an unavailable capability. V1 has no permanent organization or team enablement setting.

All-organization activation occurs only after these controls are deployed together:

- Schema and startup repairs.
- Atomic signal and grant arbitration.
- Policy and credential semantic revisions.
- Membership epochs.
- Credential and action bindings.
- Final authorization and secret-snapshot use.
- Both web surfaces and management routes.
- Channel refusal.
- Retention cleanup.
- Metrics, logs, and alerts.
- Full conformance and adversarial tests.

Activation is a release state, not a durable setting. A rollback leaves grants inert when the older release cannot read them.

Observability MUST count durable offers, creations, exact replays, conflicts, reuses, dormant reasons, final revalidation failures, revocations, supersessions, wake failures, and cleanup deletions. Logs MAY include internal grant IDs and reason codes. Logs MUST NOT include internal digests, credential selectors, raw parameters, or secret material.

## Acceptance scenario

From a clean repaired database, create a team workflow with one static tool node and two exact argument variants. Add a current team admin and a team credential. Configure one decisive `require_approval` policy.

1. The admin durably approves variant A on the web.
2. The grant and signal appear after one committed transaction.
3. An exact request retry returns the stored success.
4. A conflicting retry returns conflict.
5. A later run of variant A reuses the grant after final validation.
6. Variant B parks independently and does not supersede variant A.
7. An OAuth token refresh preserves reuse.
8. A semantic credential replacement blocks reuse.
9. Restoring token text does not revive the old binding.
10. Demoting the approver makes the grant dormant.
11. Promoting the approver in the same epoch reactivates it.
12. Removing and re-adding the approver keeps it dormant.
13. After 90 days, reapproval supersedes the expired row and creates a new row.
14. After another 90 days, cleanup can delete the retained expired audit row.

All steps MUST pass in one run with an injected clock. No response, log, or stored grant identity may contain resolved secret material.

## Adversarial acceptance matrix

Each row is a required test. Store-level concurrency tests use a real PostgreSQL-compatible transaction implementation and the in-memory approval-port reference where applicable.

| ID | Setup or action | Required result |
| --- | --- | --- |
| CRED-1 | OAuth refresh changes token and expiry only | Incarnation and version remain unchanged; grant still matches. |
| CRED-2 | Refresh health metadata changes | Incarnation and version remain unchanged. |
| CRED-3 | Manual replace, reconnect, account, scope, reference, mode, or authority changes | Credential version increments; old grant does not match. |
| CRED-4 | Delete and recreate the same owner and service row | New incarnation; old grant does not match. |
| CRED-5 | Operational refresh races a semantic replacement | Compare-and-preserve refresh cannot overwrite the replacement. |
| CRED-6 | Continuity is unknown | Mutation owner treats the write as semantic and increments version. |
| CRED-7 | GitHub installation token is reminted | App configuration revision stays fixed; grant still matches. |
| CRED-8 | GitHub installation or semantic App configuration changes | Revision or numeric installation binding changes; old grant does not match. |
| CRED-9 | `auto` selector precedence chooses a different source | Requested mode stays `auto`; exact resolved binding changes; reuse fails. |
| DEL-1 | Delegated source credential is replaced | Source version changes; old team grant does not match. |
| DEL-2 | Delegation is revoked and shared again | Delegation incarnation changes; old grant does not match. |
| DEL-3 | Delegator leaves and rejoins | Membership epoch changes; old delegation and grant do not match. |
| MEM-1 | Role update through `setRole` or `addMember` conflict path | Membership epoch is preserved. |
| MEM-2 | Insert through team creation, join eligibility, provisioning, IdP sync, or config reconciliation | Database mints a nonempty membership epoch. |
| MEM-3 | Delete then reinsert through each supported membership path | Database mints a different epoch. |
| MEM-4 | Off-team org admin requests team durable creation | Request is refused with no signal or grant mutation. |
| MEM-5 | Team admin is demoted, promoted in the same epoch, then removed and re-added | Grant is dormant, active, then permanently dormant. |
| PRINC-1 | Org-principal gate requests durable scope | Request is refused; approve-once remains available. |
| POL-1 | Decisive action policy changes mode, matcher, context, target, expiry, revoke, or reinstate | Revision increments; old grant does not match. |
| POL-2 | Exact idempotent policy replay or no-op config reconciliation | Revision stays unchanged. |
| POL-3 | Decisive override changes or is recreated | Revision or row ID changes; old grant does not match. |
| POL-4 | Unrelated policy changes | Decisive authority is unchanged; grant can still match. |
| POL-5 | Precedence changes and another row becomes decisive | Authority changes; reuse fails. |
| POL-6 | Plugin default version changes | Plugin authority changes; reuse fails. |
| POL-7 | Built-in risk semantics constant changes | Risk-default authority changes; reuse fails. |
| POL-8 | Live decision becomes deny or allow | Deny blocks; allow invokes without a grant. |
| ARG-1 | Omitted static defaults and explicit equal defaults | Effective arguments and digest are equal. |
| ARG-2 | Different effective default or validated argument | Different variant; both grants can coexist. |
| ARG-3 | Policy parameter matcher applies | Matcher receives the same effective arguments used by the digest. |
| ARG-4 | Dynamic authenticated discovery has no pre-gate stable revision | `reusable` is false with a safe reason. |
| ARG-5 | Environment credential or mutable 1Password reference lacks a stable revision | `reusable` is false; no secret is resolved for a fingerprint. |
| NODE-1 | Summary, position, edge, enclosing foreach, or definition version changes | Node semantic digest stays unchanged. |
| NODE-2 | Service, action, template, credential request, `onDeny`, `approvalTimeout`, or `onError` changes | Node semantic digest changes. |
| NODE-3 | Exact node semantics are restored within grant life | Grant can reactivate after all live checks pass. |
| NODE-4 | Two foreach iterations render identical effective arguments | They share one durable variant; one-time signal identities remain distinct. |
| NODE-5 | One node renders several exact argument variants | Variants coexist; no node-wide supersession occurs. |
| KEY-1 | HMAC organization, domain, algorithm, or format differs | Digest does not match. |
| KEY-2 | Key rotates or format is unknown | Reuse fails closed; no internal digest is returned. |
| TX-1 | Same signal and exact normalized payload retry | Port returns replay and performs no slot mutation. |
| TX-2 | Same signal with different decision, actor, note, channel, scope, or grant | Port returns conflict and performs no losing mutation. |
| TX-3 | Concurrent approve and deny | Exactly one commits; the other conflicts. |
| TX-4 | Failure is injected after grant selection or insertion and before signal insertion | Transaction rolls back every grant and signal mutation. |
| TX-5 | Failure is injected after signal insertion and before commit | Transaction rolls back every grant and signal mutation. |
| TX-6 | Wake fails after commit | Approval remains committed; a retry can request wake again. |
| TX-7 | Wake observer checks ordering | No wake occurs before commit visibility. |
| FINAL-1 | Policy, role, epoch, node, arguments, action contract, or credential changes before wake | Final validation fails closed and action is not invoked. |
| FINAL-2 | Binding changes during secret resolution | Snapshot comparison fails; action is not invoked. |
| FINAL-3 | Final validation succeeds | The exact compared secret snapshot is passed once to invocation. |
| FINAL-4 | Provider call runs slowly | No database authorization lock remains held during the call. |
| SLOT-1 | Second parked gate finds the same unexpired live grant | It reuses the grant without renewing expiry. |
| SLOT-2 | Grant expires and receives reapproval | Old row is superseded once; new row owns the slot. |
| SLOT-3 | Two reapprovals race after expiry | Partial uniqueness and transaction locking produce one new live row. |
| SLOT-4 | Grant is revoked | Slot releases; retained row remains immutable. |
| LIST-1 | Node changes and is restored | Derived list status changes without a write-on-read mutation. |
| LIST-2 | Admin is demoted, promoted, then rejoins | Derived reasons follow the epoch and role rules. |
| LIST-3 | Credential, policy, or delegation changes and is recreated | Old row never becomes active again. |
| AUTH-1 | Caller submits a foreign-org grant ID | Response is indistinguishable from an unknown ID. |
| AUTH-2 | Org admin lacks workflow-content access | Admin can list and revoke safe grant metadata only. |
| AUTH-3 | Public list and logs are inspected | No raw arguments, internal digest, credential reference, policy matcher, ciphertext, or secret appears. |
| WIRE-1 | Run detail and Action Required show one parked gate | Both return the same server-derived `reusable` and `reusableReason`. |
| WIRE-2 | Browser tampers with principal, expiry, role, selector, or digest fields | Fields are ignored or rejected; server derives authority. |
| WIRE-3 | Web requests durable scope | Confirmation names principal, scope, and fixed expiry before submission. |
| WIRE-4 | Slack, Telegram, or agent requests durable scope | Request is refused before mutation; approve-once and deny remain. |
| BOOT-1 | Existing database lacks each new table, column, or index | Startup repair creates it and becomes ready. |
| BOOT-2 | Startup repair runs again | It is idempotent and performs no request-time probe. |
| BOOT-3 | Startup repair fails | API remains unready or fails startup. |
| BOOT-4 | A pre-deploy parked gate has no complete binding | It remains approve-once with `legacy_gate`; no schema state is written to the gate. |
| RET-1 | Clock reaches one millisecond before `expires_at + 90 days` | Cleanup retains the row. |
| RET-2 | Clock reaches `expires_at + 90 days` | Cleanup may delete the row and repeated cleanup is harmless. |
| RET-3 | Row was revoked or dormant early | Cleanup still keys from fixed expiry, so retention can exceed 90 days. |
| PORT-1 | Existing `WorkflowStore` conformance suite runs unchanged | Every existing implementation still passes. |
| PORT-2 | New approval-port conformance suite runs against PostgreSQL and memory | Insert, replay, conflict, rollback, slot, and normalization behavior agrees. |

## Explicitly out of scope

| Exclusion | V1 rule | Future prerequisite or seam |
| --- | --- | --- |
| Durable approval from channels | Slack, Telegram, and agent callbacks stay approve-once or deny. | A separate channel confirmation and authority design. |
| Approver-selected lifetimes | Every grant lasts exactly 90 days. | A new retention and risk review. |
| Organization or team enablement settings | Activation is all-organization after complete deployment. | A product requirement for staged tenant control. |
| Org-principal durable grants | Org-owned gates stay approve-once. | Add `org_members.membership_epoch` and define continuous org authority. |
| Whole-definition grants | Every grant binds one tool node and one exact variant. | A separate blast-radius design. |
| Generic transaction APIs | `WorkflowStore` receives no `withTransaction`. | Add only if an independent portable engine use case requires it. |
| Unrelated PR #709 races | This design changes only durable workflow approval races. | Track and fix #709 under its own invariant and tests. |

## Conformance bar

The feature conforms only when every invariant, lifecycle rule, and acceptance-matrix row passes. Partial implementations MUST keep durable approval unavailable. Implementation and Linear tracking begin only after this specification is approved.
