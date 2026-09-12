# First-class nested Kubernetes v1

Date: 2026-09-12. Status: **Proposed and unimplemented**. Target: Valet v2.

## Acceptance scenario

A conforming deployment MUST pass A1 through A12 in one run on a fresh ARM64 Kubernetes sandbox. [K01]

| Step | Action | Expected observation |
|---|---|---|
| A1 | Set `kubernetes: true` in `.valet/prebuild.yaml`. Create a session. | Valet selects a capability-labeled bake and a supporting provider. |
| A2 | Inspect the pod before readiness. | It matches the security profile in K08 through K12. |
| A3 | Run `valet-kubernetes start`. | It exits 0 and emits the `ready` JSON from K25. |
| A4 | Read `$KUBECONFIG`. | It names the fixed file in K15 and context `valet-kubernetes`. |
| A5 | Create a pod with DNS, ClusterIP, `emptyDir`, CPU, memory, and UID 65535. | The pod becomes Ready. DNS and service traffic work. Limits stay below outer limits. |
| A6 | Run the sandbox Docker daemon and an unrelated long exec. | Both remain in `/init/services` and continue during cluster use. |
| A7 | Import two caller-selected OCI archives. Import the first again. | All imports succeed. The repeated import has the same image records. |
| A8 | Run `valet-kubernetes start` twice and three stop/start cycles. | Starts are idempotent. Cgroup depth and owned paths do not grow. |
| A9 | Send SIGTERM to the server leader. Run `status`. | Status is `error`; `start` removes owned residue and returns `ready`. |
| A10 | Run `valet-kubernetes stop` twice. | Both calls exit 0. State and `/init/valet-kubernetes` are absent. |
| A11 | Repeat A1 through A10 on AMD64. | Results match, except artifact checksums and process identifiers. |
| A12 | Request the capability on each unsupported provider and an unready Kubernetes node. | Session creation fails before readiness and gives the corrective action. |

Pass requires all steps, Mono PR [#8098](https://github.com/tkhq/mono/pull/8098) application e2e, and no outer isolation regression.
The oracle revision is `9ae8720066b8af545eec68ad64789dd75b014687`.

## 00. Preliminaries

This document uses MUST, MUST NOT, SHOULD, and MAY as defined by RFC 2119.
Text without these words is informative. Each keyword sentence ends with a requirement ID.
The vector validator rejects an ID that has no vector or acceptance step.

**Capability**: the one `kubernetes: true` sandbox request.
**Helper**: the image-baked `/usr/local/bin/valet-kubernetes` program.
**Cluster**: one rootless, single-node k3s instance in one sandbox.
**Manager**: the delegated cgroup `/init`.
**Services**: the persistent `/init/services` cgroup.
**Scope**: the helper-owned `/init/valet-kubernetes` cgroup.

| Level | Name | Required parts |
|---|---|---|
| L0 | Decision kernels | Capability, interval-map, and lifecycle vectors |
| L1 | Image | L0 plus artifact lock, helper, paths, and command contract |
| L2 | Provider | L1 plus Kubernetes admission and startup checks |
| L3 | Runtime | L2 plus lifecycle, import, and status behavior |
| L4 | Deployed | L3 plus A1 through A12 and the Mono e2e adapter |

**INV-1, outward authority**: The helper MUST control only its sandbox process tree and Scope. [K02]
**INV-2, inward control**: Valet MUST own capability resolution, helper artifacts, state, readiness, and generic tests. [K03]
**INV-3, fail closed**: A missing prerequisite MUST stop readiness without an unsafe fallback. [K04]
**INV-4, deterministic decisions**: The L0 kernels MUST use only their stated inputs. [K05]
**INV-5, bounded identity**: Inner UID and GID maps MUST cover every integer from 0 through 65535. [K06]
**INV-6, one cluster**: One sandbox MUST have at most one managed Cluster. [K07]

## 01. Capability and support

*Depends on: Part 00. Conformance: L0 to L2.*

`.valet/prebuild.yaml` gains the optional Boolean key `kubernetes`; omission means `false`.
The recipe loader MUST reject non-Boolean values with the exact field name and `use kubernetes: true or false`. [K30]
A successful repository read MUST persist the resolved value in `agent_sessions.kubernetes`, default `false`. [K31]
A failed read MUST preserve a stored `true`; it MUST NOT silently remove authority required by a running Cluster. [K32]
REST and child creation MUST use the same repository resolution and persistence path. [K33]

Propagation is `PrebuildOverride.kubernetes` to `RepoPrebuildFlags.kubernetes` to `SessionMeta.kubernetes` to `SandboxCreateOpts.kubernetes`.
`SandboxCapabilities.nestedKubernetes` MUST report `v1` or `false`. [K34]
The repository bake identity MUST include `nested-kubernetes:v1:<lock digest>` when the value is true. [K35]
The bake MUST carry OCI label `dev.valet.capability.nested-kubernetes` with that same value. [K36]
The provider identity MUST include the value in the CR annotation and immutable pod environment fingerprint. [K37]
Reconcile MUST replace compute when this identity changes and preserve `/workspace`. [K38]

| Provider | L2 support | Reason |
|---|---:|---|
| Kubernetes | Required | It can prove user namespaces, OCI devices, RuntimeClass, maps, and cgroup delegation. |
| Docker | Unsupported | It cannot prove the Kubernetes pod and node invariants. |
| Local and virtual | Unsupported | They have no isolated provider boundary. |

The capability decision kernel is `(requested, providerReport) -> allow | ignore | reject`.
It MUST return `ignore` when requested is false, `allow` only for `v1`, and `reject:unsupported_provider` otherwise. [K39]
The API MUST apply this kernel before it creates or restores a sandbox. [K40]
A reject MUST say `Nested Kubernetes requires the Kubernetes sandbox provider. Change the provider or remove kubernetes: true.` [K41]
The provider MUST finish all K08 through K12 checks before it reports the sandbox Ready. [K42]

## 02. Provider and image contract

*Depends on: Parts 00 and 01. Conformance: L1 to L2.*

The Kubernetes manifest MUST set `hostUsers: false`, `privileged: false`, and add no workload capability. [K08]
It MUST NOT add a hostPath, host socket, host PID, host IPC, host network, or host namespace mount. [K09]
The RuntimeClass MUST expose TUN character `10:200` with `rw` and mode `0666`. [K10]
It MUST bind host `/dev/null` character `1:3` to `/dev/kmsg` and MUST NOT expose kmsg `1:11`. [K11]
It MUST keep the inherited broad `/sys` mount read-only and grant no wildcard device rule. [K12]
Kubernetes 1.35 nodes MUST set `userNamespaces.idsPerPod: 131072`. [K43]
The image MUST declare UID and GID subordinate ranges `65536:65535` for UID 1500. [K44]

Image startup MUST create Services, move the PID 1 chain there, empty Manager, and enable `cpu cpuset memory pids`. [K45]
It MUST delegate Manager ownership and required control files to UID 1500 without changing outer limits. [K46]
It MUST set `VALET_SANDBOX_KUBERNETES=1` and `KUBECONFIG` to the path in K15. [K47]
It MUST verify the Helper, lock digest label, `k3s`, `kubectl`, RootlessKit, `slirp4netns`, `newuidmap`, and `newgidmap`. [K48]

The provider enforces K08 through K12, RuntimeClass selection, and the immutable capability fingerprint.
Image startup enforces K43 through K48 before the provider readiness probe succeeds.
The Helper rechecks maps, devices, cgroups, commands, file ownership, and versions before each cold start.

The normative lock is in `nested-kubernetes-v1-vectors.json` under `artifacts`.
Artifacts MUST come from the listed upstream HTTPS release URL and match SHA-256 before installation. [K49]
The initial pins MUST be k3s `v1.31.5+k3s1`, kubectl `v1.31.5`, and RootlessKit `v3.0.2`. [K50]
Callers MUST NOT select a version. [K51]
A pin change MUST update both architectures, the lock digest, bake identity, vectors, and acceptance evidence. [K52]

## 03. Helper interface and state

*Depends on: Parts 00 through 02. Conformance: L1 to L3.*

The grammar is `valet-kubernetes {start|status|stop|diagnose}` and `valet-kubernetes import ARCHIVE...`.
The Helper MUST reject options, missing archives, relative archives, and unknown commands with exit 2 and usage on stderr. [K13]
It MUST run as UID 1500 and MUST refuse UID 0. [K14]
The fixed root is `/home/dockerd/.local/state/valet/kubernetes`; kubeconfig is `<root>/kubeconfig.yaml`. [K15]
The root contains `data/`, `run/`, `config/`, `server.log`, `server.pid.json`, and `state.json`; its adjacent lock is `<root>.lock`. [K16]
Files MUST be UID 1500, non-symlinked, and mode 0700 for directories or 0600 for files. [K17]
Each mutating command MUST hold one exclusive `flock` from validation through its final atomic state write. [K18]
Lock wait MUST stop after 30 seconds with exit 24 and a retry action. [K19]
`status` and `diagnose` MUST take a shared lock and MUST have no side effect. [K20]

Exit 0 means success; 2 means usage; 3 means stopped status; 4 means non-ready status.
Exit 20 means failed prerequisite; 21 means foreign state; 22 means startup or readiness failure; 23 means import failure; 24 means timeout.
A failure MUST emit one corrective error on stderr and MUST emit no success JSON. [K21]
`diagnose` MUST emit deterministic JSON checks and exit 0 only when all prerequisites pass. [K22]
Logs MAY contain timestamps; status JSON and vector comparisons MUST NOT contain timestamps or durations. [K23]

The lifecycle states are `stopped`, `starting`, `ready`, `stopping`, and `error`.
Missing `state.json` means `stopped`; every other invalid state means `error:invalid_state`.
The lifecycle kernel is `(state, operation, identity) -> next, action, exit` and MUST match every lifecycle vector. [K24]
The vectors cover every valid operation class and take precedence over prose examples.
Successful `start`, `stop`, `import`, and `status` MUST emit one compact JSON line with sorted keys. [K25]
The stable status fields MUST be `error`, `kubeconfig`, `schema`, and `state`, with schema value 1. [K26]
Ready means the leader identity is valid, the API answers, all nodes are Ready, and CoreDNS rollout is complete. [K27]
Startup MUST stop after 10 minutes, roll back its owned process tree and Scope, retain logs, write `error`, and exit 22. [K28]
A repeated ready `start` MUST recheck K27 and return success without replacing the Cluster. [K29]

`server.pid.json` records PID, `/proc/<pid>/stat` start time, boot ID, UID, cgroup, and argv digest.
A live identity MUST match all fields, UID 1500, Scope, and the pinned k3s server argv. [K53]
A live mismatch MUST exit 21 without signaling the process or deleting state. [K54]
A dead or reboot-stale identity MUST permit cleanup only inside the fixed root and Scope. [K55]

`stop` MUST send SIGTERM to the saved process group, wait 10 seconds, then send SIGKILL and wait 2 seconds. [K56]
It MUST use the validated Scope `cgroup.kill` for survivors and wait 10 seconds for `populated 0`. [K57]
It MUST remove owned descendants bottom-up and MUST leave state on unsafe, foreign, or populated paths. [K58]
A successful stop MUST remove the fixed root and Scope; a stopped stop MUST succeed. [K59]
The Helper MUST create only Scope as a Manager sibling and move only its detached launcher into Scope before `exec`. [K60]

## 04. Map and import kernels

*Depends on: Parts 00 through 03. Conformance: L0 and L3.*

The map kernel accepts ordered triples `(inner, outer, count)` for UID and GID.
It MUST reject malformed, zero, overflowing, overlapping, or gapped coverage of inner interval `[0,65535]`. [K61]
It MUST accept split, unordered input when the union covers that exact interval. [K62]
Subordinate files MUST give UID 1500 a total usable range of at least 65535 at outer start 65536. [K63]

`import` accepts one or more absolute regular files in OCI or Docker `docker save` tar format.
It MUST pass each archive unchanged to pinned `k3s ctr --address <root>/data/agent/containerd/containerd.sock --namespace k8s.io images import --digests`. [K64]
It MUST hold the lifecycle lock, require `ready`, preserve argument order, and never discover or infer images. [K65]
A duplicate import MUST succeed with containerd's content-addressed result. [K66]
Imports have no multi-archive transaction; a failure MUST stop later imports and retain completed earlier imports. [K67]
A failed archive MAY leave content-addressed blobs or image records; retrying the same archive MUST be safe. [K66]
The Helper MUST reject links, devices, directories, changing inode or size, and archives over available state storage. [K68]
It MUST copy each validated archive to a 0600 temporary file in the fixed root, import it, then remove it. [K69]

## 05. Threats and checks

*Depends on: Parts 00 through 04. Conformance: L2 to L4.*

| Threat | Invariant | Mechanical check |
|---|---|---|
| Host escape through pod grants | INV-1 | Manifest golden for K08 through K12; live A2 |
| Short or gapped user map | INV-3, INV-5 | Map vectors; startup preflight; A5 |
| PID reuse or forged pidfile | INV-1 | Full identity vector; foreign live process test |
| Cgroup escape or service kill | INV-1 | Fake cgroup ownership tests; A6, A8, A10 |
| Concurrent lifecycle corruption | INV-6 | Lock race vector and concurrent command test |
| Supply-chain substitution | INV-3 | SHA-256 lock validator and image-label probe |
| Ambient image import | INV-2 | Import argv test and syscall fixture |
| False readiness | INV-3 | absent node, unready node, and absent CoreDNS tests |

## 06. Migration, rollout, and rollback

*Depends on: Parts 00 through 05. Conformance: L4.*

Mono PR #8098 MUST remain unchanged as the oracle until L4 passes in a deployed Valet environment. [K70]
Implementation order MUST be lock artifacts, image startup, provider manifest, schema propagation, Helper, generic tests, then Mono adapter. [K71]
PR #659 supplies Tini PID 1 and PR #661 supplies the full subordinate ranges; implementation MUST preserve both. [K72]

Infra PR [test-agents-infra#11](https://github.com/tkhq/test-agents-infra/pull/11) is stage 1.
Stage 1 MUST remain Kubernetes 1.34 and MUST NOT enable `idsPerPod`; it cannot pass K43. [K73]
Stage 2 MUST upgrade control plane, then `platform`, `default`, and `large` node groups to 1.35 with health gates. [K74]
Stage 2 MUST set `idsPerPod: 131072`, preserve the TUN and null-kmsg OCI rules, and complete A2 before image rollout. [K75]
Stage 3 MUST deploy the capability-disabled Valet image and run non-capability regression tests. [K76]
Stage 4 MUST enable one canary repository, complete A1 through A12, then widen access. [K77]

Rollback MUST first disable capability admission while existing Clusters remain stoppable. [K78]
An image rollback MUST retain the Helper until all managed Clusters stop. [K79]
Node rollback MUST use replacement capacity because EKS control planes and managed node groups do not downgrade in place. [K80]

After L4, Mono MUST replace `rootless-k3s.sh` with calls to `valet-kubernetes start`, `import "$archive"...`, and `stop`. [K81]
The adapter MUST keep `VALET_SANDBOX_DOCKER=1`, `TK_ENV`, Make targets, `KUBECONFIG`, and context `k3d-tkhq` compatibility. [K82]
The adapter MUST copy only the canonical kubeconfig to its existing `K3S_STATE_DIR`, then rename that copy's context to `k3d-tkhq`. [K83]
It MUST NOT read or modify an ambient kubeconfig or the canonical kubeconfig. [K83]
Mono MUST retain archive selection, builds, Kustomize, application readiness, SOPS, e2e, and k3d outside Valet. [K84]

## 07. Non-goals and re-entry seams

*Depends on: Parts 00 through 06. Conformance: all levels.*

A v1 implementation MUST NOT ship an excluded item under the v1 capability label. [K85]

| Excluded item | Reason | Re-entry seam |
|---|---|---|
| Remote CLI tree, plugin, or action | Consumers use the in-sandbox binary and kubeconfig. | New API version and authorization review |
| Arbitrary distro or version | One lock bounds supply chain and behavior. | New capability version and artifact matrix |
| Multiple clusters, nodes, or host management | They exceed sandbox authority. | New topology spec and provider contract |
| Privileged workloads | They break the outer security invariant. | Separate security model and admission class |
| Automatic image discovery | The caller owns intent. | New explicit archive-selection API |
| Manifests and application readiness | Mono owns application behavior. | Repository adapter interface |
| Secrets | Existing Valet secret paths own credentials. | Secret-broker integration with redaction tests |

## Normative artifacts

`docs/specs/nested-kubernetes-v1-vectors.json` is normative.
`scripts/docs/validate_nested_kubernetes_spec.mjs` validates requirement coverage, artifact pins, and L0 kernels.
Implementation tests MUST consume the same vectors instead of copying their values. [K86]
