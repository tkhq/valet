# Specification: Pluggable Sandbox Workspace Persistence

Status: implemented (see Deviations). Target: dev-v2. Companion infra: `test-agents-infra`.

## Part 00. Preliminaries (normative)

### 00.1 Purpose

This document specifies how a sandbox workspace becomes durable and node portable through checkpoint and restore against a pluggable store, with an S3 compatible object store as the default backend. Two implementations that follow this document MUST agree on every observable behavior the acceptance scenario and the invariants define: the object key a checkpoint lands at, what a restore places on disk, and the order of lifecycle hooks.

### 00.2 Requirement language

The keywords MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY follow RFC 2119. A sentence with no keyword is informative.

### 00.3 Terminology (one word per concept)

**workspace**: the agent working directory, mounted at `/workspace` in a sandbox pod. It holds a git checkout and files the agent creates.

**workspace id**: the stable string that identifies a workspace across sandbox iterations. It is the value passed to `sandboxCrName(opts.workspace)` today. The same principal reopening the same logical workspace MUST produce the same workspace id.

**backend**: the concrete `WorkspaceStore` implementation selected by config. One of `object-store`, `rwx-volume`, or `none`.

**checkpoint**: a point in time capture of the workspace written to the backend as one committed artifact.

**restore**: the operation that populates an empty `/workspace` from the latest committed checkpoint for a workspace id.

**reap**: terminal destruction of a sandbox by the hibernation reaper or the run reclaimer. Reap removes the pod and node local state.

**DinD state**: the Docker data root at `/home/dockerd/.local/share/docker`. It is a node local `emptyDir` today and stays that way (see Part 06).

Synonyms are defects. Do not write "snapshot" for "checkpoint" or "session dir" for "workspace".

### 00.4 Milestones (cumulative)

Each milestone names the parts it requires. A milestone is shippable on its own.

| Milestone | Requires | Delivers |
|---|---|---|
| M0 | Parts 01, 02, 03 | The `WorkspaceStore` interface, the policy kernel, and the `none` backend. Behavior matches today (ephemeral, no durability). |
| M1 | M0 + Parts 04, 05 | The `object-store` backend and the k8s lifecycle wiring (init container restore, lifecycle checkpoint). Default on. |
| M2 | M1 + Part 07 | Config surface, metrics, periodic checkpoint, and the `rwx-volume` backend for operators who bring their own filesystem. |

### 00.5 Global invariants

Each invariant names the mechanism that enforces it. Review is a fallback and never the mechanism.

**INV-1 (restore only into an empty workspace).** A restore MUST run only when `/workspace` is empty. Mechanism: the restore init container checks that `/workspace` has no entries before it extracts, and exits 0 without action otherwise. Behavioral test: create a sandbox with a pre populated workspace and assert restore is skipped.

**INV-2 (checkpoint atomicity).** A reader MUST never observe a partially written checkpoint as the latest. Mechanism: the backend writes objects under a per checkpoint prefix, then writes a `manifest.json` last as the commit marker; `latest` resolves through a pointer object updated only after `manifest.json` exists. Behavioral test: interrupt an upload before the manifest and assert `restore` still returns the previous committed checkpoint.

**INV-3 (tenant isolation).** A checkpoint for one org MUST NOT be readable or writable through another org's sandbox. Mechanism: the object key derives from the org id and owner id; the credentials a sandbox receives grant access only under its own prefix. Behavioral test: attempt a cross prefix read with a sandbox's credentials and assert denial.

**INV-4 (S3 compatibility).** The `object-store` backend MUST operate against any S3 API compatible endpoint through configurable endpoint, region, bucket, and credentials. Mechanism: the backend uses the S3 SDK with an overridable endpoint; CI runs the backend against MinIO. Behavioral test: the acceptance scenario runs against MinIO.

**INV-5 (fail closed config).** Backend selection MUST default to `object-store` and MUST reject an unknown backend name at boot with an error that names the bad value. Mechanism: the config parser validates against the closed enum during boot, and boot exits non zero on an invalid value, matching `reconcileInstanceConfig`.

**INV-6 (no credential leakage).** Object store credentials MUST NOT appear in logs, in the workspace, or inside a checkpoint. Mechanism: credentials arrive through a mounted secret and an env var read once; the checkpoint tar excludes the credentials mount path; a grep test scans logs and a sample checkpoint.

**INV-7 (durability is best effort by default).** A checkpoint or restore failure MUST NOT block sandbox start or the agent turn under the default policy. Mechanism: the lifecycle wraps checkpoint and restore in a guarded path that logs, emits a metric, and continues; a restore failure falls back to a baked image start. An operator MAY set `onRestoreFailure: block` per Part 07 to override for workspaces that require durability.

## Acceptance scenario (normative appendix, wired as an integration test)

Pass criterion: all steps run in one test, from a clean start, against MinIO, and the final observation holds.

Worked example values, reused by every part:

- org id: `org_39828000-1c89-4735-874e-2150e09dc225`
- owner id: `user_zeke`
- workspace id: `root-valet-assistants-asst-11111111-2222-3333-4444-555555555555`
- bucket: `valet-workspaces-dev`
- endpoint: `http://minio.valet-dev.svc:9000`
- object prefix for this workspace: `org_39828000-1c89-4735-874e-2150e09dc225/user_zeke/root-valet-assistants-asst-11111111-2222-3333-4444-555555555555/`

| Step | Action | Expected observation |
|---|---|---|
| 1 | Open the workspace for the first time. Backend `object-store`. | No committed checkpoint exists. The sandbox starts from the baked image. `/workspace` matches the image baseline. |
| 2 | The agent writes `/workspace/NOTES.md` with body `hello-durable`. | The file exists in the running pod. |
| 3 | Hibernate the sandbox (`suspend`). | A checkpoint commits under the prefix. `manifest.json` lists `NOTES.md`. The `latest` pointer resolves to this checkpoint. |
| 4 | Reap the sandbox. The pod and its `emptyDir` are destroyed. | No node local workspace state remains. |
| 5 | Reopen the same workspace id. The scheduler places the pod on a different node in a different AZ. | The restore init container downloads the latest checkpoint and extracts it into the empty `/workspace`. |
| 6 | Read `/workspace/NOTES.md` in the new pod. | The body equals `hello-durable`. |

The scenario proves node and AZ portability (step 5), durability across reap (steps 3 through 6), and the empty workspace baseline for a first open (step 1).

## Part 01. The WorkspaceStore interface (normative). Depends on: Part 00. Milestone: M0.

Define one interface that every backend implements. Place it in `packages/engine/src/sandbox/` next to the sandbox provider types, so both the kubernetes and docker providers consume it.

```ts
export interface WorkspaceRef {
  orgId: string;
  ownerId: string;
  workspaceId: string; // the sandboxCrName input
}

export interface CheckpointManifest {
  checkpointId: string;   // opaque, backend-assigned, unique per commit
  createdAtMs: number;    // stamped by the caller's clock, informative
  sizeBytes: number;
  entryCount: number;
}

export interface WorkspaceStore {
  /** Resolve the latest committed checkpoint, or null when none exists. */
  latest(ref: WorkspaceRef): Promise<CheckpointManifest | null>;

  /** Stream a workspace tar into the store and commit it. Returns the manifest. */
  checkpoint(ref: WorkspaceRef, tar: NodeJS.ReadableStream, meta: { createdAtMs: number }): Promise<CheckpointManifest>;

  /** Stream the latest committed checkpoint's tar out, or null when none exists. */
  restore(ref: WorkspaceRef): Promise<NodeJS.ReadableStream | null>;

  /** Remove all checkpoints for a workspace. Called on explicit workspace deletion, never on reap by default (Part 07). */
  purge(ref: WorkspaceRef): Promise<void>;
}
```

Rules:

- `checkpoint` MUST commit atomically per INV-2. `checkpoint` MUST return only after the commit marker is durable.
- `restore` MUST resolve the same checkpoint that `latest` reports at the same instant.
- The tar format MUST be POSIX ustar, gzip optional through config. The archive root MUST be the workspace directory contents, so extraction into `/workspace` reproduces the tree.
- The interface MUST NOT expose credentials. Credentials are backend construction inputs.

## Part 02. The checkpoint and restore policy kernel (normative). Depends on: Part 01. Milestone: M0.

Isolate every checkpoint or restore timing decision into one pure function. The kernel performs no I/O and reads no clock. The caller injects the clock value and the store lookup result.

```ts
export type LifecycleEvent =
  | { kind: "create"; workspaceEmpty: boolean }
  | { kind: "suspend" }
  | { kind: "reap" }
  | { kind: "periodic" };

export interface PolicyConfig {
  minCheckpointIntervalMs: number; // rate limit for periodic only
  checkpointOnReap: boolean;
}

export interface PolicyInput {
  event: LifecycleEvent;
  hasCommittedCheckpoint: boolean;
  lastCheckpointAtMs: number | null;
  nowMs: number;
  config: PolicyConfig;
}

export type PolicyDecision =
  | { action: "restore" }
  | { action: "checkpoint" }
  | { action: "skip"; reason: string };

export function decide(input: PolicyInput): PolicyDecision;
```

Decision table (normative). The kernel MUST return exactly these results:

| event | condition | decision |
|---|---|---|
| create | `workspaceEmpty` and `hasCommittedCheckpoint` | restore |
| create | `workspaceEmpty` and not `hasCommittedCheckpoint` | skip ("cold start from image") |
| create | not `workspaceEmpty` | skip ("INV-1 non empty") |
| suspend | always | checkpoint |
| reap | `checkpointOnReap` | checkpoint |
| reap | not `checkpointOnReap` | skip ("reap checkpoint disabled") |
| periodic | `nowMs - lastCheckpointAtMs >= minCheckpointIntervalMs` or `lastCheckpointAtMs` null | checkpoint |
| periodic | otherwise | skip ("rate limited") |

The kernel is deterministic. `nowMs` and `createdAtMs` are the only time inputs, and they are supplied by the caller. Unit tests cover every row with fixed inputs.

## Part 03. The `none` backend (normative). Depends on: Parts 01, 02. Milestone: M0.

`none` implements `WorkspaceStore` as a no op: `latest` returns null, `restore` returns null, `checkpoint` returns a zero size manifest without writing, `purge` returns. With `none` selected, sandbox behavior matches today. The one change is the `/workspace` volume, which becomes a node local `emptyDir` (Part 05). This backend exists for local development and for operators who accept a fully ephemeral workspace.

## Part 04. The `object-store` backend (normative). Depends on: Parts 01, 02. Milestone: M1.

Implement `WorkspaceStore` against the S3 API.

Object layout under the bucket:

```
<prefix>/<workspaceKey>/checkpoints/<checkpointId>/data.tar.gz
<prefix>/<workspaceKey>/checkpoints/<checkpointId>/manifest.json
<prefix>/<workspaceKey>/latest            # body: the committed checkpointId
```

where `<workspaceKey>` is `orgId + "/" + ownerId + "/" + workspaceId`. The prefix and bucket come from config.

Rules:

- `checkpoint` MUST upload `data.tar.gz` first, then `manifest.json`, then overwrite `latest` with the new `checkpointId`. This order enforces INV-2: `latest` names a checkpoint only after its manifest exists.
- `latest` MUST read the `latest` object, then read that checkpoint's `manifest.json`. A missing `latest` object MUST return null.
- `restore` MUST resolve `latest`, then stream `data.tar.gz` for that checkpoint.
- The backend MUST accept a configurable endpoint for S3 compatible stores (INV-4). It MUST default the endpoint to AWS S3 when the operator sets none.
- The backend MUST derive the key from `orgId` and `ownerId` (INV-3). It MUST reject a `WorkspaceRef` with an empty `orgId` or `ownerId`.
- Old checkpoints beyond the newest N (config, default 2) SHOULD be deleted after a successful commit. This bounds storage. A deletion failure MUST NOT fail the checkpoint.

## Part 05. Kubernetes lifecycle wiring (normative). Depends on: Part 04. Milestone: M1.

The workspace volume changes from a PVC to a node local `emptyDir` for the `object-store` and `none` backends. The `rwx-volume` backend (Part 07) keeps a PVC. DinD state stays an `emptyDir` in all cases (Part 06).

Reference file: `packages/sandbox-kubernetes/src/manifest.ts`.

### 05.1 Volume change

- For `object-store` and `none`: the `workspace` volume MUST be an `emptyDir` with `sizeLimit` set from `defaultStorage` (default 2Gi) — the cap the PVC path enforces through its storage request. Remove the `volumeClaimTemplate` for these backends. Keep `WORKSPACE_MOUNT_PATH = /workspace`, `workingDir`, and `fsGroup = 1500` unchanged.
- For `rwx-volume`: keep the PVC, and set its `storageClassName` from config.

### 05.2 Restore (init container)

- Add an init container named `workspace-restore` to the sandbox pod for the `object-store` backend.
- It shares the `workspace` `emptyDir` with the main container.
- It receives the `WorkspaceRef` fields and the object store config as env, and the object store credentials through a mounted secret.
- It MUST implement the create branch of the kernel: if `/workspace` is empty and a committed checkpoint exists, download and extract it; otherwise exit 0 without action (INV-1).
- A restore failure under `onRestoreFailure: fallback` MUST exit 0 and leave `/workspace` empty, so the main container cold starts from the image. Under `onRestoreFailure: block` it MUST exit non zero, and the pod fails to start.
- The script MUST write its outcome (`restored`, `cold-start reason=no-checkpoint`, `cold-start reason=restore-failed`, `failed`) to the container termination message. The provider reads it from `initContainerStatuses` to record restore metrics and to drive the cold-start clobber guard (05.3).
- The restore credential MUST carry `s3:ListBucket` on the bucket in addition to `s3:GetObject`. Without it, S3 answers 403 (not 404) for a GET of the missing `latest` key, and every new workspace reads as a restore failure — under `block` the pod can never start. The script names this corrective action in its 403 error.

### 05.3 Checkpoint (lifecycle triggered)

- The provider MUST checkpoint on `suspend(id)` and on reap, before it removes the pod. Reference methods: `KubernetesSandboxProvider.suspend` and the destroy path invoked by the hibernation reaper. `create()` MUST also flush a checkpoint before it deletes a live pod on image drift — the `suspend` policy event (unconditional; `checkpointOnReap` is a sandbox-death knob and must not disable a keep-alive flush), under a short exec budget so the engine's ready waiters (~60s) do not reject fleet-wide on an image upgrade. A flush that misses the budget fails without committing and the roll proceeds.
- The checkpoint script MUST verify the archive with a full listing pass before it uploads. busybox tar exits 1 for every error (GNU reserves 1 for "file changed"), so the create exit code alone would commit a truncated archive as the new `latest`.
- Every checkpoint attempt MUST settle within an outer deadline even when the exec transport or the object store hangs before per-request timeouts arm — a wedged attempt must not block suspend, destroy, or the sweeps (INV-7). The presigned URL expiry MUST equal the exec deadline: a timed-out exec cannot be killed remotely, and longer-lived URLs would let the orphaned script move `latest` backward after newer commits.
- The checkpoint step runs `tar` over `/workspace` inside the pod and streams the archive to the backend. Use the existing in pod exec path (`exec.ts`) so the data path stays node to object store and never transits the api.
- The provider MUST call the kernel with the matching `LifecycleEvent` and act on the decision. A `skip` decision performs no upload.
- The script MUST skip the upload when nothing under `/workspace` (minus the ignore list) changed since the last commit from the same pod, and report the skip (`checkpoint-unchanged`). The last committed state already covers the workspace, so the skip is safe and avoids re-uploading idle workspaces on every suspend.
- Cold-start clobber guard: when the pod's restore termination message reads `cold-start reason=restore-failed`, the provider MUST refuse the checkpoint (outcome `blocked_cold_start`) and log the corrective action. Committing an emptied workspace would advance `latest` past the last good checkpoint, and retention prune would then delete the good data — a transient store outage would become permanent loss. The guard fails closed: when the outcome cannot be read (a pod-status error), the provider skips the checkpoint rather than risk the clobber. Accepted tradeoff: work done in a cold-started pod is not durable until the pod is recreated and the restore succeeds; the `blocked_cold_start` outcome is the alert signal.
- The provider MUST serialize checkpoint work per sandbox. Suspend, reap, the drift roll, and the periodic sweep fire from independent timers; interleaved commits race the `latest` PUT against prune, and a suspend could scale the pod away under another caller's upload. The serialization is per api process; a multi-replica api is out of scope for v1 (Deviations).
- Known residual: suspend's pre-patch checkpoint widens the idle-sweep's wake-vs-suspend race from milliseconds to the checkpoint duration. The data stays safe (the checkpoint commits before the scale-down, and the wake restores it); the cost is one errored turn and an epoch re-provision when a user wakes a session mid-checkpoint. The unchanged-skip keeps the common idle case near-instant.
- Retention prune MUST protect both the caller's checkpoint id and the checkpoint the live `latest` pointer names at prune time.
- A checkpoint failure MUST log, record a `failed` outcome on `valet.workspace.checkpoints`, and allow the lifecycle to proceed (INV-7).

### 05.4 Capabilities

- `capabilities()` MUST report `persistentWorkspace: true` for `object-store` and `rwx-volume`, and `false` for `none`.
- The `snapshot` capability stays `"none"`. Checkpoint and restore are a workspace store concern and do not use the sandbox snapshot seam.

## Part 06. DinD state (normative). Depends on: Part 05. Milestone: M1.

The DinD data root at `/home/dockerd/.local/share/docker` MUST remain a node local `emptyDir`. Checkpoint MUST NOT include it. Restore MUST NOT populate it. In sandbox Docker layers rebuild from images and carry no durable user state. This keeps checkpoints small and avoids overlay filesystem semantics that an object store cannot represent.

## Part 07. Config, metrics, periodic checkpoint, and the rwx-volume backend (normative). Depends on: Parts 04, 05. Milestone: M2.

### 07.1 Config surface

Add a `workspacePersistence` block to the instance config (`valet.yaml`) and the matching chart values. The chart MUST set the credentials through a secret ref, never inline (matches the ESO pattern).

```yaml
workspacePersistence:
  backend: object-store            # object-store | rwx-volume | none. Default: object-store.
  objectStore:
    bucket: valet-workspaces-dev
    endpoint: ""                   # empty => AWS S3. Set for MinIO/R2/GCS-interop.
    region: us-east-1
    prefix: ""                     # optional extra key prefix
    credentialsSecret: valet-workspace-store   # secret with access key id + secret
    gzip: true
    keepCheckpoints: 2
  rwxVolume:
    storageClassName: efs-sc       # only read when backend == rwx-volume
  policy:
    minCheckpointIntervalMinutes: 5
    checkpointOnReap: true
    periodicCheckpoint: true
    onRestoreFailure: fallback     # fallback | block
```

The config parser MUST validate `backend` against the closed enum and fail boot on an unknown value (INV-5).

### 07.2 Metrics

Emit, labeled by `backend` and `outcome` (no `_total` suffix — the Prometheus OTLP ingestion appends the counter suffix, matching every other engine counter):

- `valet.workspace.checkpoints` (outcome: `committed` | `skipped` | `unchanged` | `blocked_cold_start` | `failed`), `valet.workspace.checkpoint_bytes`
- `valet.workspace.restores` (outcome: `restored` | `cold_start` | `failed`)

The `failed` outcomes are the INV-7 visibility: durability is best effort, so a failure never blocks the lifecycle and the counter is the alert signal.

### 07.3 Periodic checkpoint

When `periodicCheckpoint` is true, one api-side sweep fires the `periodic` event on the kernel every `minCheckpointIntervalMinutes`. This bounds data loss on node death to one interval. The timer MUST use the shared sweep timer helper so it is overlap guarded and unref'd. The pass runs sandboxes through a small worker pool (bounded concurrency), so the pass duration tracks the slowest checkpoint, not the sum. When a pass still exceeds the interval, the sweep MUST log a warning — the overlap guard drops ticks silently, and the stretched bound must be visible (alert, don't auto-repair).

### 07.4 The rwx-volume backend

`rwx-volume` implements durability through a mounted ReadWriteMany filesystem the operator provisions (for example EFS through its CSI StorageClass). With this backend the workspace is a PVC on the RWX class, restore and checkpoint are no ops (the filesystem itself persists and moves), and `latest`/`checkpoint`/`restore` return trivially. This backend exists for operators who prefer a mounted filesystem over object store checkpointing. It carries the AZ and detach tradeoffs of the underlying storage, which the operator accepts.

## Part 08. Non-goals (normative). Depends on: Part 00.

| Excluded | Why | Re-entry seam |
|---|---|---|
| Continuous, synchronous durability (every write persisted) | The object store model is checkpoint based; per write persistence needs a mounted filesystem. | Select the `rwx-volume` backend, or add a future streaming backend behind `WorkspaceStore`. |
| Multi writer workspaces (two pods, one workspace) | Sandboxes are single writer per workspace id today. | A future RWX aware backend and a locking protocol. |
| DinD state durability | Docker layers rebuild from images and hold no user state (Part 06). | None. This exclusion is permanent. |
| Cloud native object clients beyond S3 API (native GCS, native Azure Blob) | S3 compatibility covers AWS, MinIO, R2, and GCS interop, which meets the portability goal. | Add a backend implementing `WorkspaceStore` for the native API. |
| Per workspace size quotas beyond the emptyDir cap | The workspace emptyDir carries a `sizeLimit` (`defaultStorage`, default 2Gi) so a runaway workspace cannot exhaust node ephemeral storage; the object store side stays unquotaed. | A backend enforced byte ceiling on `checkpoint`. |
| Encryption of checkpoints beyond bucket level encryption | Bucket side encryption (SSE) covers the threat model for a single tenant dev deployment. | Client side envelope encryption in the `object-store` backend. |

A v1 implementation MUST NOT ship the excluded items under the v1 label.

## Appendix A. Implementation order (informative)

1. Parts 01 and 02: interface and kernel, with unit tests for every decision-table row.
2. Part 03: `none` backend, plus the manifest.ts emptyDir change behind the backend switch. Ship M0. Behavior matches today.
3. Part 04: `object-store` backend, with a MinIO integration test for INV-2, INV-3, INV-4.
4. Part 05: init container restore and lifecycle checkpoint. Wire the acceptance scenario as an integration test against MinIO. Ship M1 with `object-store` default.
5. Part 07: config, metrics, periodic checkpoint, and `rwx-volume`. Ship M2.

## Appendix B. Infra companion tasks (informative, test-agents-infra)

- Provide an object store for agents-dev: an S3 bucket `valet-workspaces-dev` with SSE, plus an IAM policy scoped to the bucket prefix, delivered to sandboxes through a secret (ESO), matching the existing secret pattern. Required actions: `s3:GetObject` AND `s3:ListBucket` for the restore credential (see 05.2 — without ListBucket a missing key answers 403, not 404); the api-side credential additionally needs `s3:PutObject` (presigning) and `s3:DeleteObject` (retention prune, purge).
- For local development, MinIO in the dev stack gives the same S3 API, so dev and prod share one code path.
- No CSI driver, no StorageClass, and no per AZ mount targets are required for the default `object-store` backend. This is the portability win: an operator supplies one bucket and one credential.

## Appendix C. Grounding notes for the implementer (informative)

- Before this spec the workspace was an EBS PVC (`manifest.ts`, `DEFAULT_STORAGE = "2Gi"`), and the provider advertised `persistentWorkspace: true` because it preserved that PVC across pod recreation under a retained CR. This spec moves durability from the EBS attach model to checkpoint and restore, which removes AZ pinning and the force detach delay on node death.
- DinD already uses an `emptyDir` (`DOCKER_STATE_VOLUME_NAME`), so the object store path never has to represent overlay filesystems.
- The hibernation reaper destroys the pod, the workspace volume, and the creds secret after the retention window. Under this spec the reaper MUST trigger a final checkpoint before it destroys, when `checkpointOnReap` is true, so a returning user finds the prior workspace.
- Keep derived directories (`node_modules`, `.venv`, `.pnpm-store`, `.cache`, `__pycache__`) out of the checkpoint through a default ignore list, so checkpoints stay small and restores stay fast. The excludes are unanchored (they match at every depth — the right call for JS monorepos with nested `node_modules`). Accepted costs: a resumed workspace must reinstall dependencies (`pnpm install`, `pip install`) before builds run, and a repo that vendors a committed `node_modules` loses it from checkpoints. The list is not operator-configurable yet.

## Deviations (implementation, 2026-08-28)

The implementation follows this spec with these recorded deviations. Each names the reason.

1. **Default-on is deferred to a config flip.** An absent `workspacePersistence` block keeps the legacy behavior: a ReadWriteOnce workspace PVC and no checkpoint or restore. INV-5's `object-store` default applies when the block is present. Reason: a hard default would fail boot on every existing deploy before the infra companion (bucket + secret) exists, or silently flip the storage model under running workspaces. The dev-v2 infra PR adds the block and flips the default in one reviewed change.
2. **Checkpoint uploads use presigned PUT URLs, not in-pod credentials.** The api presigns one PUT URL per object (data, manifest, latest) and the in-pod script uploads with `curl`. The sandbox never holds the shared bucket credential, so user code cannot reach another tenant's prefix — stronger than the credential-scoping INV-3 asks the infra layer for. Consequence: one checkpoint object caps at the S3 single-PUT limit (5 GB).
3. **The restore init container runs the sandbox image itself** with `curl --aws-sigv4` (curl >= 7.75) and `tar`. No aws-cli, no extra image pull. The credentials Secret mounts into the init container only, at `/etc/valet/workspace-store` — outside `/workspace`, so a checkpoint cannot capture it and the main container never sees it (INV-6).
4. **Identity mapping.** `ownerId` is the session's `userId` (`SessionData.userId`). The object-key `workspaceId` is the sandbox CR name — the sanitized `sandboxCrName(opts.workspace)` output — because raw workspace strings can contain `/`, which would break prefix containment (one workspace's purge could reach another's objects). The engine stamps `orgId`/`ownerId` on `SandboxCreateOpts`; the provider records them as CR annotations (`valet.dev/org`, `valet.dev/owner`) so suspend/reap-time checkpoints survive an api restart.
5. **`manifest.json` carries `entryCount`, not a file list.** The Part 01 interface has no entries field; the acceptance test asserts `entryCount >= 1` and a byte-exact restore of `NOTES.md` instead of a listed name.
6. **`purge` is implemented but not wired to a deletion path.** Session deletion keeps checkpoints (a recreated session with the same workspace id restores them). Storage stays bounded by `keepCheckpoints` and bucket lifecycle rules. Wiring purge to an explicit workspace-deletion surface is future work.
7. **Restore metrics flow through the termination message.** The init container has no OTel exporter, so it writes its outcome to the container termination message; the provider reads `initContainerStatuses` after `create()`/`resume()` reach Ready and records `valet.workspace.restores` api-side. Pods that never reach the read (a `block`-mode start failure) report through pod status and logs only.
8. **The periodic checkpoint is one api-side sweep**, not a per-sandbox timer: a single `startSweepTimer` pass fires the `periodic` kernel event across `provider.list()` through a bounded worker pool. The kernel's rate limit yields the same per-workspace bound with one timer.
9. **Restore and presign endpoints resolve independently.** The restore init container GETs from `objectStoreBaseUrl` (the configured endpoint, or the hand-built AWS regional endpoint when none is set), while checkpoint PUT URLs come from the AWS SDK presigner's own endpoint resolution. With an explicit `endpoint` configured both agree; in the default-AWS case, FIPS/dualstack env or non-`aws` partitions could make them diverge. Set `objectStore.endpoint` explicitly in such deployments.
