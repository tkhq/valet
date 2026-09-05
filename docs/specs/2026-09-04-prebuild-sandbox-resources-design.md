# Repository sandbox CPU and memory

Date: 2026-09-04. Status: approved for implementation.

## Problem

Valet repositories can request persistent workspace storage and rootless Docker.
They cannot request CPU or memory for their sandboxes. Large test suites then run
with the deployment's implicit resource policy. This makes the Valet development
loop slow when a sandbox receives too little CPU or memory.

The sandbox providers already accept `SandboxCreateOpts.resources.cpu` and
`SandboxCreateOpts.resources.memory`. The Docker provider maps CPU to
`docker run --cpus`. It converts memory to bytes for `docker run --memory`.
The Kubernetes provider maps each value to an equal request and limit on the
sandbox container. The API does not populate these fields from repository or
deployment configuration.

## Goals

- Let a repository declare sandbox CPU and memory in `.valet/prebuild.yaml`.
- Let a deployment define default sandbox CPU and memory.
- Let an organization administrator edit per-repository defaults in Sandbox settings.
- Apply repository values on Docker and Kubernetes sandbox backends.
- Apply repository changes at the next safe sandbox reconcile window.
- Preserve the persistent working directory when a resource change replaces a sandbox.
- Keep resource configuration independent from image bake configuration.

## Repository schema

`.valet/prebuild.yaml` gains one optional mapping:

```yaml
resources:
  cpu: 4
  memory: 8Gi
```

Both fields are optional. `cpu` is a positive finite number. It can contain a
fraction, such as `0.5`. `memory` is a positive Kubernetes quantity string, such
as `8Gi` or `500Mi`. The loader trims `memory` before it stores the value.

If `resources` is not a mapping, the loader rejects the file. If a declared value
is invalid, the loader rejects the file and names the corrective format in the
error. A fresh session then uses saved repository defaults before deployment
defaults. The repository reader does not cache the failed read.

The schema has one value for each resource. It does not expose separate requests
and limits. The Kubernetes provider sets the request and limit to the same value.
The Docker provider applies the same value as the container ceiling.

## Deployment defaults

The Helm chart gains these optional values:

```yaml
sandbox:
  resources:
    cpu: ""
    memory: ""
```

Empty values preserve the current behavior and omit CPU or memory defaults. The
chart publishes non-empty values as `VALET_SANDBOX_CPU` and
`VALET_SANDBOX_MEMORY` in the API ConfigMap.

The API validates both environment variables at boot. CPU must be a positive
finite number. Memory must be a positive Kubernetes quantity. Invalid values stop
the API and name the variable and corrective format.

The Kubernetes provider stores valid values in `K8sProviderConfig.defaultResources`.
The manifest builder already merges these defaults with caller values one field at
a time. A repository can therefore override CPU and keep the deployment memory
default, or override memory and keep the deployment CPU default. Existing
ephemeral-storage defaults remain in the same object and survive this merge.

Docker has no chart-driven deployment default because the chart uses the
Kubernetes backend. Repository values still reach the Docker provider in local
and test deployments.

## Resolution and precedence

`PrebuildOverride.resources` carries the parsed repository values.
`RepoPrebuildFlags` carries them with the existing `docker` and
`workspaceStorage` runtime values. The existing repository reader reads all these
values in one GitHub contents request and uses its existing ten-minute cache and
five-second host timeout.

Precedence is per field:

1. A repository YAML value wins when it is present.
2. A saved repository default applies when YAML omits that field.
3. A deployment value applies when both repository sources omit that field.
4. The provider omits the field when no source defines it.

Only the primary repository binding supplies runtime values. Child sessions use
the same resolution path as REST-created sessions.
If token resolution fails, a tokenless missing-file answer remains a read error.
The API removes its resource opinion before initial creation or reconciliation.

## Provision and reconcile behavior

At session build time, `EngineHost` copies repository CPU and memory into
`SandboxCreateOpts.resources`. The first provider create call therefore receives
the requested resources.

`SandboxResources.memory` uses a positive Kubernetes quantity on all providers.
Desired specs and applied metadata keep the exact configured string. At its
runtime boundary, Docker converts the quantity to a decimal byte count. This
conversion supports DecimalSI, BinarySI, and decimal-exponent quantities. It
rounds positive fractional bytes up. Docker rejects an invalid or non-positive
quantity before it starts a container.

`DesiredSandboxSpec` also carries an optional resource opinion. An empty resource
object means the repository authoritatively declares no overrides. A missing
resource opinion means the repository read failed, so the attachment must not use
that result for resource drift. The spec hash includes an authoritative resource
object in a fixed field order. The spec provider reads the runtime repository
values on each invocation. The repository cache bounds this read to at most once
per ten minutes for one repository, ref, and credential.

The applied-state file records the repository CPU and memory overrides used for
the current sandbox. Old applied-state files have no resource field and remain
valid. If authoritative desired resources differ from the recorded resources,
`SandboxAttachment` uses the same replacement path as image drift:

1. The attachment stores the new resource values in its create options.
2. The attachment bumps its epoch and releases the old sandbox.
3. The attachment creates a sandbox with the new resources.
4. The attachment runs the full prep plan and records the new applied state.

The replacement runs only on an isolated provider and only in the existing idle
run-start reconcile window. It uses the existing replacement backoff. Kubernetes
keeps the workspace PVC when it releases the old sandbox. Docker keeps the host
working-directory bind mount. Files outside the persistent working directory do
not survive.

A resource change on a suspended sandbox uses the existing wake-folding path. The
attachment creates the new sandbox directly instead of first waking the stale one.

Only successful YAML and saved-default lookups can produce an authoritative
opinion. `declared` combines saved defaults with parsed YAML overrides. `absent`
uses saved defaults, or `{}` when none exist. It can remove earlier YAML overrides.
`error` carries no resource opinion. If
an `error` occurs during reconciliation, the attachment keeps its recorded
resource overrides. If an image change still requires replacement during that
error, the attachment copies the recorded overrides into the new create options.
This rule prevents a timeout, rate limit, malformed file, or temporary GitHub
failure from replacing a sandbox with deployment defaults. If the first read for
a new sandbox fails, no recorded overrides exist, so initial provisioning uses
available saved repository defaults before deployment defaults.

Provider creation can adopt existing compute after an API restart. The engine
sets the internal `preserveResourcesOnAdopt` option when the desired spec has no
resource opinion. This option takes precedence over stale CPU or memory in
rebuilt create options during adoption. Fresh compute still uses those options
and provider defaults. An authoritative resource object, including `{}`, clears
the preservation option.

Kubernetes preserves the existing CR's exact CPU and memory requests and limits
during no-opinion adoption, including absent fields. It applies incoming
ephemeral-storage fields and does not mutate the caller's manifest. The adoption
path uses its existing read after a create conflict; it does not pre-read the CR.
The provider stores a desired-resource fingerprint in the CR pod template's
`valet.dev/resource-fingerprint` annotation. The sandbox container also receives
the reserved literal environment value `VALET_SANDBOX_RESOURCE_FINGERPRINT`.
The provider removes caller values for this name before it sets the marker.
The fingerprint includes desired CPU and memory requests and limits.
It uses canonical quantity values: `500m` equals `0.5`, and `4096Mi` equals `4Gi`.
Missing fields remain distinct from zero. Admission-added resources, such as
LimitRange defaults, do not change the fingerprint or trigger repeated rolls.

The agent-sandbox controller updates existing pod metadata from the template,
without replacing the pod's container spec. Pod annotations cannot prove applied
resources. The provider reads the live fingerprint only from the reserved literal
environment entry. It rejects `valueFrom` entries and does not use pod metadata.
This immutable pod-spec value records the generation used when the pod was created.

The provider compares the live pod's image and literal fingerprint with the
applied CR in one pod read. A difference deletes the pod even when its image matches.
This comparison retries a stale pod if the CR update succeeded but pod deletion
failed. The shared rollout waits for a new UID and a live pod with `Ready=True`.
That pod must also match the requested image and any desired resource fingerprint.
A stale CR Ready condition cannot complete creation while the pod is absent or
Pending, including after an API restart. The workspace PVC remains. An
authoritative `{}` applies deployment defaults or removes prior overrides.
If the live pod read fails, creation fails without declaring resource convergence.

Legacy CRs can lack a fingerprint. No-opinion adoption preserves marker absence
and does not infer resource drift from the admitted pod. Image drift remains
independent. The first authoritative resource opinion, including `{}`, adds a
fingerprint and can roll the legacy pod once. Later calls compare fingerprints.

After provider creation, the engine reads the returned sandbox's applied state
before prep. An adopted sandbox retains its recorded resources when the desired
spec has no opinion. A fresh sandbox has no applied file and runs the full plan.
The provider reports `Sandbox.adopted=true` when creation adopts existing state
or storage, even if it replaces the live compute. If applied-state reads or prep
fail, the engine retains that adopted state or uses non-terminal release. It
destroys failed fresh compute only. Explicit session deletion can still destroy
adopted state. This rule prevents a transient prep error from deleting a workspace PVC.

Providers can return an internal `Sandbox.resourceOverrides` record. This record
contains repository overrides, not effective resources or deployment defaults.
An object, including `{}`, is known metadata. `null` means adopted compute has
no recoverable record. An omitted field means the provider does not report this
metadata. Known provider metadata takes precedence over the applied file and
rebuilt create options. Unknown adopted metadata must not use stale create options.
The attachment removes rejected CPU and memory from saved create options while
keeping ephemeral storage. Later no-opinion replacements cannot restore those values.
`PolicySandbox` forwards the current record without starting a sandbox.

Kubernetes stores this record in the `valet.dev/resource-overrides` CR annotation.
Authoritative creation and adoption store only caller CPU and memory overrides.
No-opinion adoption preserves the annotation. For a legacy CR without a valid
record, the provider calls the engine's optional `readResourceOverrides` reader
on the old live sandbox. The provider stores a recovered opinion with the pod
template update, before pod deletion. A read failure aborts adoption before either
change. A missing pod or applied resource record stays unknown; the provider
does not infer repository overrides from deployment defaults.

The returned sandbox exposes the durable record after readiness. An image rollout
can remove the old applied file, but it cannot remove the CR annotation. A retry
after a crash uses that annotation without reading the old pod. The engine runs
the full prep plan on the new pod and records the preserved resource opinion.

Deployment defaults are outside the desired session spec. Changing them alone
does not trigger engine reconciliation of a running attachment. The next creation
uses current defaults. Authoritative adoption after API restart or recovery also
uses current defaults and replaces the pod if its effective resources changed.
No-opinion adoption preserves existing CPU and memory. An operator can use the
existing replace endpoint to apply new defaults to a running attachment.

## Failure behavior

A repository read failure uses available saved defaults before deployment defaults
for a new sandbox. It does not prevent startup or change existing resources. A
provider failure follows the existing sandbox startup error path. An unschedulable
Kubernetes request therefore fails visibly instead of silently falling back to
smaller resources.

This change does not add application-level resource caps. Cluster `ResourceQuota`
and `LimitRange` objects remain the deployment guardrails. A later change can add
Valet-specific caps if operators need them.

## Documentation and dogfood

### Repository settings in Valet

The organization settings page is named **Sandbox settings**. It retains base
and external image controls. Each repository row also has optional CPU and memory
defaults, a save action, and the existing bake controls. Empty fields remove the
saved default. Resource controls remain available when image builds are disabled.

The API stores these defaults on the repository image source. Only organization
administrators can change them. Existing source routes retain their URLs and
organization checks. Resource edits do not trigger an image bake.
Runtime lookup uses the session organization, repository host, and full name.
Disabled image sources still supply sandbox defaults. A missing row means no
saved defaults. A failed database read produces no opinion for existing sandboxes.

Precedence is per field: repository YAML, saved repository defaults, deployment
defaults, then provider behavior. The runtime resolver reads saved defaults on
each invocation so a settings edit does not wait for the GitHub cache to expire.
It caches only the GitHub answer. Successful repository reads combine saved
defaults with YAML overrides into the authoritative resource opinion. Applied
metadata records this combined opinion. A failed read has no opinion for an
existing sandbox. A fresh sandbox can use saved defaults as its fallback.

The UI explains this precedence beside the controls. Query invalidation refreshes
saved values after a mutation. Background refresh updates untouched fields and
preserves unsaved user edits. Validation uses the same positive CPU and memory
rules as the YAML configuration. Save failures retain input and show a retry action.

### Public configuration

`docs/prebuild-yaml.md` documents the new mapping and its backend behavior. The
Valet repository sets these values for its own sandbox:

```yaml
resources:
  cpu: 4
  memory: 8Gi
```

This setting gives the unit and end-to-end test suites four CPUs and 8 GiB of
memory when Valet runs them inside its own sandbox.

## Testing

- Recipe tests cover valid, partial, malformed, zero, negative, and non-finite values.
- Repository flag tests cover parsing and caching of CPU and memory.
- Host tests prove REST-created and child sessions pass repository resources to providers.
- Spec tests prove deterministic hashing and resource hash sensitivity.
- Engine tests prove cold provision, run-start replacement, wake folding, old applied-state compatibility, and replacement backoff.
- Kubernetes API wiring tests cover deployment defaults and validation.
- Kubernetes manifest tests prove per-field merge with ephemeral-storage defaults.
- Docker argument tests prove repository CPU and memory reach `docker run`.
- Helm golden tests prove chart values reach the API environment.
- The canonical `make e2e` scorecard validates the full change.

## Out of scope

- Separate CPU or memory requests and limits.
- A session API or web control for resource values.
- Per-organization resource policy or application-level maximum values.
- GPU and other extended Kubernetes resources.
- Automatic replacement after a deployment default changes.
- Changes to test selection or test coverage.
