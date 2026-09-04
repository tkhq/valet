# Repository sandbox CPU and memory

Date: 2026-09-04. Status: approved for implementation.

## Problem

Valet repositories can request persistent workspace storage and rootless Docker.
They cannot request CPU or memory for their sandboxes. Large test suites then run
with the deployment's implicit resource policy. This makes the Valet development
loop slow when a sandbox receives too little CPU or memory.

The sandbox providers already accept `SandboxCreateOpts.resources.cpu` and
`SandboxCreateOpts.resources.memory`. The Docker provider maps these values to
`docker run --cpus` and `--memory`. The Kubernetes provider maps each value to an
equal request and limit on the sandbox container. The API does not populate these
fields from repository or deployment configuration.

## Goals

- Let a repository declare sandbox CPU and memory in `.valet/prebuild.yaml`.
- Let a deployment define default sandbox CPU and memory.
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
error. The existing best-effort repository reader then starts the session with
deployment defaults. It does not cache the failed read.

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

1. A repository value wins when it is present.
2. A deployment value applies when the repository omits that field.
3. The provider omits the field when neither source defines it.

Only the primary repository binding supplies runtime values. Child sessions use
the same resolution path as REST-created sessions.

## Provision and reconcile behavior

At session build time, `EngineHost` copies repository CPU and memory into
`SandboxCreateOpts.resources`. The first provider create call therefore receives
the requested resources.

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

Only `declared` and `absent` repository outcomes are authoritative. `declared`
carries the parsed resource object. `absent` carries an empty resource object and
can remove earlier repository overrides. `error` carries no resource opinion. If
an `error` occurs during reconciliation, the attachment keeps its recorded
resource overrides. If an image change still requires replacement during that
error, the attachment copies the recorded overrides into the new create options.
This rule prevents a timeout, rate limit, malformed file, or temporary GitHub
failure from replacing a sandbox with deployment defaults. If the first read for
a new sandbox fails, no recorded overrides exist, so initial provisioning uses
deployment defaults.

Deployment default changes affect new sandboxes. They do not cause resource drift
for existing sandboxes because provider defaults are outside the desired session
spec. An operator can replace an existing sandbox through the existing replace
endpoint when a deployment default changes.

## Failure behavior

A repository read failure uses deployment defaults for a new sandbox and does not
prevent session startup. It does not change resources on an existing sandbox. A
provider failure follows the existing sandbox startup error path. An unschedulable
Kubernetes request therefore fails visibly instead of silently falling back to
smaller resources.

This change does not add application-level resource caps. Cluster `ResourceQuota`
and `LimitRange` objects remain the deployment guardrails. A later change can add
Valet-specific caps if operators need them.

## Documentation and dogfood

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
