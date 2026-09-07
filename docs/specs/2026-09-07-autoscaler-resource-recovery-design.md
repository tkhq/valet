# Autoscaler-Aware Sandbox Resource Recovery

**Status:** Approved

**Scope:** Keep capacity-blocked Kubernetes pods available to the cluster
autoscaler. Give parent agents a controlled way to retry child tasks with lower
CPU or memory requests.

## Problem

The Kubernetes sandbox provider classifies every `PodScheduled=False` condition
with reason `Unschedulable` as a terminal startup failure. `sandboxStatus`
returns `error`, and `waitReady` throws `SandboxStartupError` on its next poll.
For a fresh sandbox, `create()` then deletes the Sandbox custom resource (CR).
The controller deletes the pod with the CR.

This behavior bypasses the provider's pending grace window. The cluster
autoscaler scans for unscheduled pods, but the affected pod can disappear before
the next scan. A resource shortfall is therefore treated as final before the
system that can repair it receives a stable signal.

The existing pending path has the correct ownership model. A readiness timeout
before the grace period throws a retryable error and keeps the CR. A later
provision attempt adopts the same CR. Adoption does not delete or recreate an
unchanged pod, so the pending pod remains continuous across retries.

After the grace period, the parent model needs enough information and control to
choose an application-level recovery. The child cannot edit its repository
because its sandbox never became ready. The parent can start a replacement child
with lower resource requests.

## Goals

1. Keep a capacity-blocked pod pending long enough for cluster autoscaling.
2. Fail structural scheduling errors without waiting for autoscaling.
3. Return the requested resources and a corrective action after the grace ends.
4. Let the parent model override CPU and memory for one child through `task`.
5. Keep a task resource override authoritative for the child's full lifetime.

## Non-goals

- Valet does not reduce resource requests automatically.
- The task tool does not edit `.valet/prebuild.yaml`.
- This change does not tune cluster-autoscaler node limits. That configuration
  is not present in this repository.
- This change does not expose node-local ephemeral storage through `task`.

## Design

### 1. Classify capacity separately from structure

`classifyPodFailure` continues to fail image, crash-loop, and failed-pod states
immediately. For an unscheduled Pending pod, it inspects the scheduler message.

Messages that contain `Insufficient cpu`, `Insufficient memory`, or
`Insufficient ephemeral-storage` are capacity-remediable. The function returns
`null` for these messages. `sandboxStatus` therefore reports `provisioning`, and
`waitReady` reaches the existing pending diagnosis path.

Other unschedulable messages stay terminal. Examples include an untolerated
taint and a node-affinity mismatch. Adding nodes cannot repair these constraints
unless cluster policy also changes.

If one scheduler message contains capacity and structural clauses, capacity wins.
An eligible autoscaled node can satisfy the resource clause even when existing
nodes fail other predicates.

### 2. Use a ten-minute pending grace

`PENDING_TERMINAL_GRACE_MS` increases from five minutes to ten minutes. The
window covers node launch, AL2023 node join, and an image pull on a new node.

The 60-second readiness attempt remains unchanged. Before the CR reaches ten
minutes of age, each timeout is retryable. The engine can call `create()` again,
which adopts the same CR and leaves its pod in place. The grace uses CR age, so a
retry does not restart the window.

After ten minutes, an unscheduled Pending pod becomes a terminal
`SandboxStartupError`. A fresh create can then remove its CR and pending pod. An
adopted CR keeps the existing workspace-survival behavior.

### 3. Return an actionable terminal message

The pending diagnosis reads the live sandbox container's CPU and memory requests.
The terminal error contains:

- the ten-minute wait;
- the scheduler's reason;
- the requested CPU and memory when available;
- an instruction to retry a child with `task.resources`;
- an instruction to reduce `.valet/prebuild.yaml` for a lasting repository
  default; and
- an instruction to check the largest node size when the lower request still
  does not schedule.

For an ephemeral-storage shortfall, the message does not claim that CPU or memory
will repair it. It tells the model to check node capacity and the deployment's
ephemeral-storage request.

### 4. Add per-child task resource overrides

The `task` tool gains this optional parameter:

```json
{
  "resources": {
    "cpu": 2,
    "memory": "4Gi"
  }
}
```

`cpu` is a positive finite number within the existing sandbox CPU limit.
`memory` is a positive Kubernetes quantity. The tool uses the same validation
rules as repository sandbox resources.

Each supplied field overrides the matching repository or deployment value.
Each omitted field keeps its existing value. An empty `resources` object has no
effect. This merge lets the model reduce only the resource named by the scheduler.

The override applies to the new child only. The task tool passes it through
`SpawnChildRequest`, `ChildSpawner`, and `EngineHost.childSessionFor`.
`buildSpecProvider` overlays the same override on every desired resource read.
Repository reconciliation therefore cannot replace the child back to the larger
repository request.

### 5. Persist the child override

`agent_sessions` stores the optional child sandbox resource override as JSON.
The child spawner writes it with the existing profile and Docker shape. Session
rebuild paths read it before they rebuild a child after an API restart or cache
eviction.

The app migration, Drizzle schema, and schema repair list change together under
the repository's pre-1.0 migration policy. Existing rows use `NULL`, which means
no task override.

## Data flow

1. A parent calls `task` with a repository and optional `resources`.
2. The task tool validates and forwards the override to the child spawner.
3. The spawner creates the child with the override and persists it.
4. `EngineHost` overlays the override on repository resources for both initial
   creation and later reconciliation.
5. If the pod lacks capacity, it remains Pending for up to ten minutes.
6. The cluster autoscaler can add a node while the same pod remains visible.
7. If the pod still cannot schedule, the child settles with an actionable error.
8. The parent model can call `task` again with a lower override.

## Error handling

Invalid task resource values fail before the child session, database row, or
workspace is created. The error names the invalid field and gives a valid example.

Transient Kubernetes reads keep the existing retry behavior. Missing resource
details do not suppress the scheduler reason or corrective action.

Structural unschedulability stays a fast failure. Capacity unschedulability
becomes terminal only after the grace period.

## Tests

- Pure lifecycle tests distinguish capacity and structural scheduler messages.
- Provider tests prove a capacity-blocked fresh CR survives readiness timeout.
- Provider tests prove adoption keeps the same pending pod through later retries.
- Provider tests check the ten-minute terminal message and resource details.
- Task-tool tests validate and forward the nested resource object.
- Child-spawner tests prove resource parameters reach child creation and storage.
- Host tests prove per-field precedence over repository resources.
- Host rebuild tests prove persisted overrides survive cache eviction.
- Schema tests cover the new nullable column and schema repair.
- Existing Kubernetes, engine, API, typecheck, and end-to-end suites remain green.

## Operations

This change makes pending capacity visible to the cluster autoscaler. Operators
must still set a global node cap that can accommodate all node-group maxima. That
follow-up belongs in the infrastructure repository.
