# Repository Sandbox Resources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let deployments and repositories set sandbox CPU and memory, and reconcile repository changes without losing the working directory.

**Architecture:** The existing prebuild runtime reader will carry a typed repository resource opinion into initial sandbox create options and the lazy desired sandbox spec. The engine will persist authoritative resource overrides in applied state and use its image-replacement path for resource drift. Kubernetes provider defaults will come from chart-backed environment variables and will merge below repository values per field.

**Tech Stack:** TypeScript, Vitest, YAML, Docker, Kubernetes Sandbox custom resources, Helm, Bash golden tests.

---

## File structure

- `packages/api/src/prebuilds/recipe.ts` parses and validates repository resource values.
- `packages/api/src/bakes/source-service.ts` returns authoritative or failed runtime resource opinions through the existing cache.
- `packages/engine/src/types.ts` defines the shared resource shape for create options and desired specs.
- `packages/engine/src/sandbox/applied-state.ts` persists the resource overrides that the current sandbox used.
- `packages/engine/src/sandbox/attachment.ts` detects resource drift and preserves known resources across transient read failures.
- `packages/api/src/engine/sandbox-spec.ts` includes authoritative resources in the desired-spec hash.
- `packages/api/src/engine/host.ts` wires repository resources into initial and lazy session sandbox state.
- `packages/api/src/providers/sandbox-backend.ts` validates deployment defaults and sends them to the Kubernetes provider.
- `deploy/chart/valet/values.yaml` and `deploy/chart/valet/templates/configmap.yaml` expose the deployment defaults.
- `.valet/prebuild.yaml` opts this repository into four CPUs and 8 GiB of memory.
- `docs/prebuild-yaml.md` and `docs/environment-variables.md` document the user and operator contracts.

### Task 1: Parse repository resource declarations

**Files:**
- Modify: `packages/api/src/prebuilds/recipe.test.ts`
- Modify: `packages/api/src/prebuilds/recipe.ts`

- [ ] **Step 1: Write failing valid-value tests**

Add tests that parse this mapping and partial mappings:

```ts
resources:
  cpu: 4
  memory: 8Gi
```

Assert the result is `{ resources: { cpu: 4, memory: "8Gi" } }`. Also assert
that `cpu: 0.5` is valid and padded memory is trimmed.

- [ ] **Step 2: Run the parser tests and verify RED**

Run: `pnpm --filter @valet/api test src/prebuilds/recipe.test.ts`

Expected: FAIL because `PrebuildOverride` and `loadPrebuildOverride` do not return `resources`.

- [ ] **Step 3: Add failing validation tests**

Cover a non-mapping `resources`, non-number CPU, zero CPU, negative CPU,
non-finite CPU, non-string memory, zero memory, negative memory, and malformed
memory suffix. Assert each error names `.valet/prebuild.yaml`, the field, and a
valid example.

- [ ] **Step 4: Implement the resource parser**

Add this shared shape in `recipe.ts` until Task 2 replaces it with the engine export:

```ts
export interface PrebuildResources {
  cpu?: number;
  memory?: string;
}
```

Add `resources?: PrebuildResources` to `PrebuildOverride`. Validate `cpu` with
the shared `(0, 64]` CPU policy. Validate
`memory` with `parseStorageQuantity`, require a positive result, and store the
trimmed string.

- [ ] **Step 5: Run the parser tests and verify GREEN**

Run: `pnpm --filter @valet/api test src/prebuilds/recipe.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the parser**

```bash
git add packages/api/src/prebuilds/recipe.ts packages/api/src/prebuilds/recipe.test.ts
git commit -m "feat(prebuild): parse sandbox resources"
```

### Task 2: Carry authoritative resources through the repository runtime reader

**Files:**
- Modify: `packages/api/src/bakes/source-service.test.ts`
- Modify: `packages/api/src/bakes/source-service.ts`

- [ ] **Step 1: Write failing runtime-reader tests**

Add tests with a GitHub fixture that prove:

- A declared file returns `{ resources: { cpu: 4, memory: "8Gi" }, outcome: "declared" }`.
- A missing file returns `{ resources: {}, outcome: "absent" }`.
- A malformed file returns `outcome: "error"` without a `resources` property.
- A transient read failure returns `outcome: "error"` and is not cached.

- [ ] **Step 2: Run the runtime-reader tests and verify RED**

Run: `pnpm --filter @valet/api test src/bakes/source-service.test.ts`

Expected: FAIL because `RepoPrebuildFlags` has no resource opinion.

- [ ] **Step 3: Implement outcome-aware resource values**

Add `resources?: PrebuildResources` to `RepoPrebuildFlags`. Set `resources` to
`override?.resources ?? {}` only after a successful file lookup. Keep it absent
from every `error` result. Preserve the existing cache, abort, and auth-key logic.

- [ ] **Step 4: Run the runtime-reader tests and verify GREEN**

Run: `pnpm --filter @valet/api test src/bakes/source-service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the runtime reader**

```bash
git add packages/api/src/bakes/source-service.ts packages/api/src/bakes/source-service.test.ts
git commit -m "feat(api): resolve repository sandbox resources"
```

### Task 3: Persist desired resources in engine applied state

**Files:**
- Modify: `packages/engine/src/types.ts`
- Modify: `packages/engine/src/sandbox/applied-state.ts`
- Modify: `packages/engine/test/applied-state.test.ts`
- Modify: `packages/api/src/prebuilds/recipe.ts`

- [ ] **Step 1: Write failing applied-state tests**

Add tests that prove:

- A file with `{ resources: { cpu: 4, memory: "8Gi" } }` parses.
- An old file without `resources` still parses.
- Invalid resource shapes make the file unreadable.
- `applyPlan` writes authoritative desired resources.
- `applyPlan` preserves prior resources when the desired spec has no opinion.
- An authoritative empty object removes prior repository overrides.

- [ ] **Step 2: Run the applied-state tests and verify RED**

Run: `pnpm --filter @valet/engine test applied-state`

Expected: FAIL because desired and applied specs have no resources.

- [ ] **Step 3: Add the shared engine type**

Extract the existing anonymous create-options shape:

```ts
export interface SandboxResources {
  cpu?: number;
  memory?: string;
  ephemeralStorage?: string;
  ephemeralStorageLimit?: string;
}
```

Use it for `SandboxCreateOpts.resources`. Add
`resources?: Pick<SandboxResources, "cpu" | "memory">` to
`DesiredSandboxSpec`. In `recipe.ts`, use the engine type instead of the
temporary local interface.

- [ ] **Step 4: Implement backward-compatible applied state**

Add optional CPU and memory resources to `AppliedState`. Validate only known
CPU and memory values when the field is present. Keep files without the field
valid. When `desired.resources` is undefined, preserve `applied?.resources`.
When it is `{}`, write `{}` so a later reconcile sees an authoritative removal.

- [ ] **Step 5: Run the applied-state tests and verify GREEN**

Run: `pnpm --filter @valet/engine test applied-state`

Expected: PASS.

- [ ] **Step 6: Run engine type checking**

Run: `pnpm --filter @valet/engine typecheck`

Expected: PASS.

- [ ] **Step 7: Commit applied state**

```bash
git add packages/engine/src/types.ts packages/engine/src/sandbox/applied-state.ts packages/engine/test/applied-state.test.ts packages/api/src/prebuilds/recipe.ts
git commit -m "feat(engine): persist sandbox resources"
```

### Task 4: Reconcile resource changes through sandbox replacement

**Files:**
- Modify: `packages/engine/test/attachment-reconcile.test.ts`
- Modify: `packages/engine/src/sandbox/attachment.ts`
- Modify: `packages/engine/src/types.ts`
- Modify: `packages/sandbox-kubernetes/src/lifecycle.ts`
- Modify: `packages/sandbox-kubernetes/src/provider.ts`
- Modify: `packages/sandbox-kubernetes/test/lifecycle.test.ts`
- Modify: `packages/sandbox-kubernetes/test/provider.test.ts`
- Modify: `docs/specs/2026-08-02-sandbox-reconcile-design.md`
- Modify: `docs/specs/2026-09-04-prebuild-sandbox-resources-design.md`

- [ ] **Step 1: Extend the recording provider test seam**

Record a copy of each `SandboxCreateOpts.resources` value beside each created
image. Do not change production code in this step.

- [ ] **Step 2: Write failing cold-provision and drift tests**

Prove that initial desired resources reach `provider.create`. Then change CPU or
memory and call `reconcile`. Assert a second create call, epoch increment, the
new resources, and a ready attachment.

- [ ] **Step 3: Run the focused tests and verify RED**

Run: `pnpm --filter @valet/engine test attachment-reconcile`

Expected: FAIL because attachment reconciliation only compares images and steps.

- [ ] **Step 4: Write failing authority and wake tests**

Prove these cases:

- Desired `{}` replaces a sandbox that recorded repository resources.
- Desired `undefined` does not replace a sandbox that recorded resources.
- Image drift plus desired `undefined` preserves recorded resources on create.
- Resource drift on a suspended sandbox skips resume and creates the new sandbox.
- A non-isolated provider does not replace on resource drift.
- A failed resource replacement uses the existing spec-hash backoff.
- A new attachment adopts an existing sandbox without erasing its resource record.
- No-opinion adoption preserves exact CR CPU/memory requests and limits, including absence.
- Authoritative adoption rolls compute for CPU/memory changes, including removal, with an unchanged image.
- A retry still rolls a stale pod after the CR update succeeded but pod deletion failed.
- Equivalent quantity formats do not roll, including `0.5`/`500m` and `4Gi`/`4096Mi`.
- A provider-side image rollout preserves applied override metadata despite stale create options.
- Legacy metadata migration stores the override opinion before pod deletion; a crash and provider restart retain it.
- Empty overrides stay distinct from unknown metadata and deployment defaults.
- The policy wrapper forwards provider metadata without provisioning.
- Applied-state read or prep failures retain adopted storage; fresh failed compute is still destroyed.
- A stale CR Ready condition cannot complete creation while the replacement pod is absent or Pending.
- Admission-added resources do not cause repeated rolls; an authoritative desired change still rolls.
- Legacy no-opinion adoption keeps fingerprint absence; authoritative adoption migrates with one rollout.
- Controller-propagated pod annotations cannot hide stale container resources or environment markers.
- Caller environment cannot replace the reserved literal fingerprint or introduce it during legacy no-opinion adoption.

- [ ] **Step 5: Implement canonical comparison and replacement**

Add a helper that compares CPU and memory with missing applied resources treated
as `{}`. Compute resource drift only when `desired.resources !== undefined`.
Replace when an isolated provider has image drift or resource drift. Before
create, set create options from authoritative desired resources. If the desired
spec has no opinion, preserve observed resources during an image replacement.

Apply the same comparison and preservation rules in wake folding and cold
provision. Do not create a second replacement implementation. Extract a small
private helper if image and resource paths would otherwise diverge.

Set the internal `preserveResourcesOnAdopt` create option when a desired spec
exists but has no resource opinion. This marker overrides stale create resources
on adoption. Authoritative desired resources, including `{}`, clear the marker.
Fresh creation still uses create resources and provider defaults.

Pass this intent through `KubernetesSandboxProvider.create` into `applySandbox`.
Use its existing conflict-branch GET to preserve prior CPU/memory in a cloned
incoming template. Keep incoming ephemeral-storage fields. Stamp a canonical
CPU/memory fingerprint in `podTemplate.metadata.annotations` and compare that
fingerprint with the live sandbox container's reserved literal environment value,
`VALET_SANDBOX_RESOURCE_FINGERPRINT`. Ignore live pod annotations: the controller
updates metadata without changing container specs. Remove caller values for the
reserved name before setting the marker. Admission defaults must not cause resource drift.
Compare image and fingerprint in one pod read. Roll a changed pod through the
existing deletion and new-UID wait. Require the live pod's Ready condition,
requested image, and desired fingerprint before creation returns.
This check retries a stale pod after a successful CR update and failed deletion.
No-opinion adoption preserves an existing fingerprint, including legacy absence.
The first authoritative opinion can roll a legacy pod once to stamp it.
Do not pre-read the CR. After create returns, read the sandbox's applied state
before prep. A fresh sandbox runs the full plan; adoption keeps prior successes.
Return `Sandbox.adopted` from provider creation and forward it through the policy
wrapper. Applied-state read and prep failures must retain or non-terminally
release adopted state. Destroy failed fresh compute only, unless the owning
session explicitly requests destruction.

Store repository overrides separately from effective resources in the Kubernetes
`valet.dev/resource-overrides` CR annotation. Preserve it on no-opinion adoption.
For legacy CRs, use the optional `SandboxCreateOpts.readResourceOverrides` callback
to recover the old applied opinion before the CR update or pod deletion. Return
the durable opinion as `Sandbox.resourceOverrides`. An object includes `{}`;
`null` means unknown adopted metadata; `undefined` means unsupported reporting.
The engine uses provider metadata before applied-file or create-option fallbacks.
It must not infer overrides from stale options when adopted metadata is unknown.
Forward this field through `PolicySandbox` and retain its exhaustive member guard.
Compare live quantities with exact decimal arithmetic, including Kubernetes
nano rounding and the BinarySI magnitude cap.

- [ ] **Step 6: Run the focused tests and verify GREEN**

Run: `pnpm --filter @valet/engine test attachment-reconcile`

Run: `pnpm --filter @valet/sandbox-kubernetes test lifecycle.test.ts provider.test.ts`

Expected: PASS.

- [ ] **Step 7: Run the engine package tests**

Run: `pnpm --filter @valet/engine test`

Run: `pnpm --filter @valet/engine typecheck`

Run: `pnpm --filter @valet/sandbox-kubernetes typecheck`

Expected: PASS.

- [ ] **Step 8: Record the reconcile extension**

Add a deviation to the sandbox reconcile spec that resources now join image drift
as a replacement trigger.

- [ ] **Step 9: Commit reconciliation**

```bash
git add packages/engine/src/types.ts packages/engine/src/sandbox/attachment.ts packages/engine/test/attachment-reconcile.test.ts packages/sandbox-kubernetes/src/lifecycle.ts packages/sandbox-kubernetes/src/provider.ts packages/sandbox-kubernetes/test/lifecycle.test.ts packages/sandbox-kubernetes/test/provider.test.ts docs/specs/2026-08-02-sandbox-reconcile-design.md docs/specs/2026-09-04-prebuild-sandbox-resources-design.md
git commit -m "feat(engine): reconcile sandbox resources"
```

### Task 5: Wire resources through API session specs

**Files:**
- Modify: `packages/api/src/engine/sandbox-spec.test.ts`
- Modify: `packages/api/src/engine/sandbox-spec.ts`
- Modify: `packages/api/src/engine/host.prebuild-flags.test.ts`
- Modify: `packages/api/src/engine/host.spec-provider.test.ts`
- Modify: `packages/api/src/engine/host.ts`

- [ ] **Step 1: Write failing spec-hash tests**

Assert identical resources produce identical hashes. Assert CPU, memory, and
authoritative-empty changes each change the hash. Assert an omitted resource
opinion keeps the current no-resource golden hash.

- [ ] **Step 2: Run the spec tests and verify RED**

Run: `pnpm --filter @valet/api test src/engine/sandbox-spec.test.ts`

Expected: FAIL because `specHash` ignores resources.

- [ ] **Step 3: Implement canonical resource hashing**

Change `specHash` to accept an optional CPU and memory resource opinion. Add a
canonical `resources` object only when the opinion is authoritative. Emit keys in
CPU, memory order. Keep all existing no-resource goldens unchanged.

- [ ] **Step 4: Run the spec tests and verify GREEN**

Run: `pnpm --filter @valet/api test src/engine/sandbox-spec.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing host wiring tests**

Extend the REST-created and child-session fixtures so a repository declares four
CPUs and 8 GiB. Assert initial provider create options contain both values. In the
spec-provider test, change the fixture answer and assert the next desired spec
contains the new authoritative values. Return an error and assert the next spec
omits its resource opinion.

- [ ] **Step 6: Run the host tests and verify RED**

Run: `pnpm --filter @valet/api test src/engine/host.prebuild-flags.test.ts src/engine/host.spec-provider.test.ts`

Expected: FAIL because the host does not wire or refresh resources.

- [ ] **Step 7: Implement initial and lazy host wiring**

Copy non-empty initial repository resources into both REST and child
`sandbox` options. In `buildSpecProvider`, call the existing runtime flag
resolver on each invocation. Set `DesiredSandboxSpec.resources` only for
`declared` or `absent` outcomes, and pass that opinion into `specHash`. Keep
`error` outcomes non-authoritative.

Do not log resolved flags on every reconciliation. Read saved settings from the
database each time, and deduplicate warnings when a failed authority read withholds
saved settings from existing compute. Do not add a second repository file read or cache.

- [ ] **Step 8: Run the host tests and verify GREEN**

Run: `pnpm --filter @valet/api test src/engine/host.prebuild-flags.test.ts src/engine/host.spec-provider.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit API wiring**

```bash
git add packages/api/src/engine/sandbox-spec.ts packages/api/src/engine/sandbox-spec.test.ts packages/api/src/engine/host.ts packages/api/src/engine/host.prebuild-flags.test.ts packages/api/src/engine/host.spec-provider.test.ts
git commit -m "feat(api): apply repository sandbox resources"
```

### Task 6: Add Kubernetes deployment defaults

**Files:**
- Modify: `packages/api/src/providers/sandbox-backend.test.ts`
- Modify: `packages/api/src/providers/sandbox-backend.ts`
- Modify: `packages/sandbox-kubernetes/test/manifest.test.ts`
- Modify: `deploy/chart/valet/values.yaml`
- Modify: `deploy/chart/valet/templates/configmap.yaml`
- Modify: `deploy/chart/valet/test/golden.sh`

- [ ] **Step 1: Write failing environment validation tests**

Cover unset, blank, valid fractional CPU, valid memory, zero, negative,
non-finite CPU, malformed memory, and padded memory. Assert invalid boot values
name `VALET_SANDBOX_CPU` or `VALET_SANDBOX_MEMORY` and give a corrective format.

- [ ] **Step 2: Write a failing provider wiring test**

Define an exported pure `resolveSandboxResources(env)` seam. Test that CPU,
memory, and ephemeral-storage values resolve into one default object. Use
`buildSandboxManifest` directly to assert repository CPU overrides only CPU and
keeps the default memory and ephemeral-storage fields.

- [ ] **Step 3: Run the backend and manifest tests and verify RED**

Run: `pnpm --filter @valet/api test src/providers/sandbox-backend.test.ts`

Run: `pnpm --filter @valet/sandbox-kubernetes test manifest`

Expected: FAIL because CPU and memory environment values are not resolved.

- [ ] **Step 4: Implement environment resolution and provider defaults**

Add exported `resolveSandboxCpu`, `resolveSandboxMemory`, and
`resolveSandboxResources` helpers. Empty or unset values return `undefined`. CPU
uses the shared `(0, 64]` CPU policy. Memory uses `parseStorageQuantity` and returns
a trimmed positive quantity. The aggregate helper merges valid values into the
same object as ephemeral storage, and `buildSandboxProvider` passes that object as
`defaultResources`.

- [ ] **Step 5: Run the backend and manifest tests and verify GREEN**

Run the two commands from Step 3.

Expected: PASS.

- [ ] **Step 6: Write failing Helm golden checks**

Add `sandbox.resources.cpu` and `sandbox.resources.memory` fixture values. Assert
the rendered ConfigMap contains `VALET_SANDBOX_CPU` and
`VALET_SANDBOX_MEMORY` with the configured values.

- [ ] **Step 7: Run the Helm golden test and verify RED**

Run: `bash deploy/chart/valet/test/golden.sh`

Expected: FAIL because the chart does not render the new variables.

- [ ] **Step 8: Wire the chart values**

Add disabled-by-default values under `sandbox.resources`. Render each environment
variable only when its value is not empty. Document that repository values
override these defaults per field.

- [ ] **Step 9: Run the Helm golden test and verify GREEN**

Run: `bash deploy/chart/valet/test/golden.sh`

Expected: PASS.

- [ ] **Step 10: Commit deployment defaults**

```bash
git add packages/api/src/providers/sandbox-backend.ts packages/api/src/providers/sandbox-backend.test.ts packages/sandbox-kubernetes/test/manifest.test.ts deploy/chart/valet/values.yaml deploy/chart/valet/templates/configmap.yaml deploy/chart/valet/test/golden.sh
git commit -m "feat(k8s): configure sandbox CPU and memory"
```

### Task 6b: Normalize memory for Docker

The Docker CLI rejects Kubernetes memory suffixes such as `8Gi`. Convert the
provider's memory quantity to bytes before constructing `docker run` arguments.
Keep repository values unchanged in desired specs and applied metadata.

- Move the existing pure quantity parser into `@valet/shared` and retain its
  Kubernetes export for compatibility. Expose it through the engine for providers.
- Test binary, decimal, exponent, and fractional quantities at the Docker boundary.
- Reject invalid quantities with an actionable error before starting Docker.
- Run shared quantity tests, Kubernetes quantity tests, and Docker argument tests.
- Update the resource design and Docker spec in the implementation commit.

### Task 6c: Persist per-repository sandbox settings

- Add optional CPU/memory defaults to repository image sources, the existing
  application migration, its Drizzle schema, and the boot schema repair list.
- Expose saved defaults in the source wire response. Extend the existing
  organization-admin source PATCH route with validation and clear semantics.
- Read saved defaults outside the GitHub cache. Merge YAML over saved defaults
  per field for initial creation and desired specs. On a failed YAML read,
  preserve the existing sandbox's opinion and use saved defaults only as a
  fresh-creation fallback.
- Scope runtime lookup by session organization, host, and repository name.
  Include disabled sources. Distinguish missing rows from database failures;
  failed lookups cannot authoritatively remove existing resources.
- Test scoped authorization, validation, persistence, clearing, precedence,
  cache behavior, read failure, organization isolation, and unchanged bake identity.

### Task 6d: Surface per-repository sandbox settings

- Rename the organization navigation label to Sandbox settings. Retain the
  existing URL for bookmark compatibility.
- Add optional CPU and memory fields plus Save to each repository row. Explain
  YAML precedence and empty-field defaults. Keep existing bake controls.
- Keep resource edits available without an image builder. Use existing query
  hooks and primitives. Sync refreshed values without losing unsaved edits.
- Test save/clear, invalid input, server failure, refreshed values, and builder
  absence. Verify the page in a local browser.

### Task 7: Document and dogfood the resource contract

**Files:**
- Modify: `.valet/prebuild.yaml`
- Modify: `docs/prebuild-yaml.md`
- Modify: `docs/environment-variables.md`
- Modify: `docs/specs/2026-09-04-prebuild-sandbox-resources-design.md`

- [ ] **Step 1: Add the repository dogfood values**

Add:

```yaml
resources:
  cpu: 4
  memory: 8Gi
```

Explain that these values size Valet's own test sandbox.

- [ ] **Step 2: Update public configuration documentation**

Document field types, validation, provider behavior, precedence, replacement,
and failure semantics in `docs/prebuild-yaml.md`. Add both deployment environment
variables to `docs/environment-variables.md`.

- [ ] **Step 3: Mark the resource design as implemented**

Change the resource design status after all code paths are complete.

- [ ] **Step 4: Run documentation and diff checks**

Run: `python3 scripts/docs/docs_lint.py`

Run: `git diff --check`

Expected: both PASS.

- [ ] **Step 5: Commit documentation and dogfood**

```bash
git add .valet/prebuild.yaml docs/prebuild-yaml.md docs/environment-variables.md docs/specs/2026-09-04-prebuild-sandbox-resources-design.md
git commit -m "docs: describe sandbox resource controls"
```

### Task 8: Verify the complete change

**Files:**
- Verify only.

- [ ] **Step 1: Run focused package tests**

Run: `pnpm --filter @valet/engine test`

Run: `pnpm --filter @valet/sandbox-kubernetes test`

Run: `pnpm --filter @valet/sandbox-docker test`

Run: `pnpm --filter @valet/api test src/prebuilds/recipe.test.ts src/bakes/source-service.test.ts src/engine/host.prebuild-flags.test.ts src/engine/host.spec-provider.test.ts src/engine/sandbox-spec.test.ts src/providers/sandbox-backend.test.ts`

Expected: all PASS.

- [ ] **Step 2: Run workspace type checking**

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 3: Run the canonical scorecard**

Run: `make e2e`

Expected: every armed row passes. If an inherited environment row fails, record
its exact reason and re-run the affected row in isolation when applicable.

- [ ] **Step 4: Inspect the final branch**

Run: `git status --short`

Run: `git diff origin/dev-v2...HEAD --check`

Run: `git log --oneline origin/dev-v2..HEAD`

Expected: a clean worktree, no whitespace errors, and discrete commits for the
design, parser, reader, engine state, reconciliation, API wiring, deployment
defaults, and documentation.
