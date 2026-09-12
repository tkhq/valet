# First-class nested Kubernetes v1

Date: 2026-09-12. Status: **Proposed and unimplemented**. Target: Valet v2.

## Acceptance scenario

A conforming deployment MUST pass A1 through A13 in one run on each supported architecture. [K01]

| Step | Action | Required observation |
|---|---|---|
| A1 | Set `kubernetes: true` in `.valet/prebuild.yaml`. Create a session. | Valet selects a capability-labeled bake and the Kubernetes provider. |
| A2 | Inspect the admitted pod before readiness. | The pod matches K23 through K32 exactly. |
| A3 | Run `valet-kubernetes start` twice. | Both calls exit 0 with the ready status vector. |
| A4 | Inspect the process and kubeconfig. | Environment, argv, paths, mode, and context match K39 through K48 and K131 through K132. |
| A5 | Create a limited multi-UID pod with DNS, ClusterIP, and `emptyDir`. | UID 65535, DNS, service traffic, and outer resource containment work. |
| A6 | Run Docker and an unrelated long exec during cluster use. | Both stay in `/init/services` and continue. Scope is its sibling. |
| A7 | Import two selected archives, then import the first again. | Tracing proves the K64 socket and argv. Image records stay stable. |
| A8 | Run concurrent start, import, status, and stop race fixtures. | Results match the lifecycle and status vectors. No command hangs. |
| A9 | Send SIGTERM to the server leader. Run `status`. | It reports `error:identity_invalid`, exits 4, and does not edit state. |
| A10 | Run three stop and start cycles, then stop twice. | No cgroup depth grows. Both stops exit 0. Owned state is absent. |
| A11 | Request it on Docker, local, virtual, unknown, and an unready Kubernetes node. | Each fails before readiness with a corrective error. |
| A12 | Kill the helper at each crash point in K56. | The next start or stop follows the matching recovery vector. |
| A13 | Replace the sandbox pod while the Cluster is ready. | Valet wipes old Cluster state, keeps other PVC data, then creates a new Cluster. |

The L4 gate also runs Mono PR [#8098](https://github.com/tkhq/mono/pull/8098) at `9ae8720066b8af545eec68ad64789dd75b014687`.
That oracle has the wrong containerd socket. Mono must correct it before parity can pass.

## 00. Preliminaries

This document uses RFC 2119 requirement words. Informative text has no requirement word.
Each normative sentence has one unique requirement tag. The validator enforces this rule.

**Capability**: the one `kubernetes: true` sandbox request.
**Helper**: `/usr/local/bin/valet-kubernetes` in the sandbox image.
**Cluster**: one rootless, single-node k3s instance in one sandbox.
**Root**: `/home/dockerd/.local/state/valet/kubernetes` on the workspace PVC.
**Manager**: the delegated cgroup `/init`.
**Services**: the persistent child cgroup `/init/services`.
**Scope**: the Helper-owned child cgroup `/init/valet-kubernetes`, which is a sibling of Services.
**Operation**: one persisted start, stop, or import claim with an immutable random ID.

| Level | Name | Required proof |
|---|---|---|
| L0 | Kernels | Capability, map, lifecycle, and status vectors |
| L1 | Image | L0, artifact lock, Helper contract, and image goldens |
| L2 | Provider | L1, schema propagation, admission goldens, and provider failure tests |
| L3 | Runtime | L2, generic lifecycle, crash, import, and persistence tests |
| L4 | Deployed | L3, A1 through A13, and corrected Mono acceptance |

**INV-1, bounded authority**: The Helper MUST control only Root, its process tree, and Scope. [K02]
**INV-2, Valet ownership**: Valet MUST own capability resolution, artifacts, lifecycle, readiness, and generic tests. [K03]
**INV-3, fail closed**: A failed prerequisite MUST stop readiness without an unsafe fallback. [K04]
**INV-4, pure decisions**: Each L0 kernel MUST use only its stated input. [K05]
**INV-5, complete maps**: UID and GID maps MUST cover every inner ID from 0 through 65535. [K06]
**INV-6, one cluster**: One sandbox MUST have at most one Operation and one managed Cluster. [K07]

## 01. Capability and identity

*Depends on: Part 00. Conformance: L0 to L2.*

`.valet/prebuild.yaml` uses optional Boolean `kubernetes`; omission means `false`.
The loader MUST reject other types with `use kubernetes: true or false`. [K08]
A successful repository read MUST persist the value in `agent_sessions.kubernetes`, whose default is false. [K09]
A failed read MUST preserve a stored true value. [K10]
REST and child creation MUST use the same resolution and persistence path. [K11]
Propagation MUST follow `PrebuildOverride` to `RepoPrebuildFlags` to `SessionMeta` to `SandboxCreateOpts`. [K12]
`SandboxCapabilities.nestedKubernetes` MUST be the Boolean false or the string `v1`. [K13]
A true repository bake identity MUST include `nested-kubernetes:v1:<lockDigest>`. [K14]
That bake MUST carry OCI label `dev.valet.capability.nested-kubernetes` with the same value. [K15]
The CR annotation and immutable pod environment fingerprint MUST include that value. [K16]
Reconcile MUST replace compute on identity change and preserve the working directory PVC. [K17]

The capability kernel is `(requestedBoolean, providerReport) -> decision`.
It MUST return `ignore` for false, `allow` for true plus `v1`, and `reject:unsupported_provider` otherwise. [K18]
A rejection MUST say `Nested Kubernetes requires the Kubernetes sandbox provider. Change the provider or remove kubernetes: true.` [K19]
The API MUST reject Docker, local, and virtual providers before sandbox create or restore. [K20]
The Kubernetes provider MUST finish admission and startup checks before it reports Ready. [K21]
A false request MUST leave bake identity, manifest, environment, startup, and kubeconfig unchanged. [K22]

## 02. Bounded provider profile

*Depends on: Parts 00 and 01. Conformance: L1 to L2.*

A true request uses the existing Kubernetes `docker:true` profile.
The manifest MUST set `hostUsers:false` and `privileged:false`. [K23]
Its maximum added capabilities MUST be exactly `SYS_ADMIN` and `NET_ADMIN`. [K24]
Its seccomp profile MUST be `Unconfined`, and its AppArmor profile MUST be `unconfined`. [K25]
Its `procMount` MUST be `Unmasked`. [K26]
Nested Kubernetes MUST add no grant beyond K24 through K26. [K27]
The manifest MUST add no hostPath, host socket, host namespace, host PID, host IPC, or host network. [K28]
The inherited broad `/sys` mount MUST remain read-only. [K29]

The existing profile uses `SYS_ADMIN` for user-namespace mounts and delegated cgroups.
It uses `NET_ADMIN` for nested Docker bridge, veth, and iptables work.
Unmasked proc and unconfined seccomp permit the existing nested proc mount and namespace sysctl operations.

The RuntimeClass MUST expose TUN character `10:200` with `rw` and mode `0666`. [K30]
It MUST bind host `/dev/null` character `1:3` to `/dev/kmsg`. [K31]
It MUST exclude kmsg `1:11`, wildcard device rules, and cgroup device permission `m`. [K32]
Kubernetes 1.35 sandbox nodes MUST set `userNamespaces.idsPerPod:131072`. [K33]
The image MUST declare UID and GID subordinate ranges `65536:65535` for UID 1500. [K34]

Only capability-enabled image startup MUST perform K35 through K37. [K35]
Enabled startup MUST create Services, empty Manager, and enable `cpu cpuset memory pids`. [K36]
Enabled startup MUST delegate Manager control files to UID 1500 without changing outer limits. [K37]
Ordinary sandbox startup MUST NOT install, validate, export, or modify nested Kubernetes state. [K38]

## 03. Artifact and process contract

*Depends on: Parts 00 through 02. Conformance: L1 to L3.*

The normative artifact lock is the `artifacts` array in the vector file.
Installation MUST use each listed HTTPS URL and verify its SHA-256. [K39]
Initial versions MUST be k3s `v1.31.5+k3s1` and kubectl `v1.31.5`. [K40]
Callers MUST NOT select versions. [K41]
A pin change MUST update both architectures, lockDigest, identities, vectors, and acceptance evidence. [K42]

k3s rootless mode uses its embedded RootlessKit Go library.
The k3s pin MUST also pin that source dependency at RootlessKit `v1.0.1`. [K43]
The image MUST NOT install a standalone RootlessKit binary. [K44]

`XDG_RUNTIME_DIR` MUST equal `<Root>/run`, and `XDG_CONFIG_HOME` MUST equal `<Root>/config`. [K45]
`K3S_DATA_DIR` MUST equal `<Root>/data`, and `KUBECONFIG` MUST equal `<Root>/kubeconfig.yaml`. [K46]
The exact argv MUST match the `k3sArgv` vector. [K47]
The Helper MUST rename kubeconfig context `default` to `valet-kubernetes` once and reject any other initial context. [K48]

## 04. Files, persistence, and process identity

*Depends on: Parts 00 through 03. Conformance: L1 to L3.*

Root contains `data`, `run`, `config`, `server.log`, `server.pid.json`, `operation.json`, and `state.json`.
Root directories MUST use mode 0700, and Root files MUST use mode 0600 with UID 1500. [K49]
The adjacent `<Root>.lock` MUST be a non-symlinked UID 1500 file with mode 0600. [K50]
All state replacement MUST use write, fsync, rename, and parent-directory fsync. [K51]

The provider injects immutable `VALET_SANDBOX_EPOCH` for each fresh compute instance.
Each state file MUST record the current epoch. [K52]
A matching epoch start MAY reuse valid k3s data after an owned process failure. [K53]
An epoch mismatch MUST remove all Root contents before any launch. [K54]
Epoch cleanup MUST preserve `<Root>.lock` and every PVC path outside Root. [K55]
Tests MUST cover crashes before launch, after launch, after readiness, during stop, and during each archive import. [K56]
A13 MUST prove that pod replacement removes old Cluster data and keeps unrelated PVC data. [K57]
A successful stop MUST remove Root contents, Root, and Scope after it closes the lock. [K58]

`server.pid.json` records PID, proc start time, boot ID, UID, cgroup, argv digest, epoch, and Operation ID.
A valid identity MUST match every field, UID 1500, the current epoch, Scope, and K47. [K59]
A live mismatch MUST never receive a signal or authorize state deletion. [K60]
A dead or reboot-stale identity MUST authorize cleanup only inside Root and Scope. [K61]
The Helper MUST create Scope as a Manager child and Services sibling. [K62]
It MUST move only its detached launcher into Scope before exec. [K63]

## 05. Import and readiness

*Depends on: Parts 00 through 04. Conformance: L3.*

Pinned source maps `/run/k3s/containerd` to `$XDG_RUNTIME_DIR/k3s/containerd` in rootless mode.
Import MUST call `k3s ctr --address <Root>/run/k3s/containerd/containerd.sock --namespace k8s.io images import --digests ARCHIVE`. [K64]
A7 MUST trace this exact address and prove the socket accepts an import. [K65]
The Helper MUST accept absolute regular OCI-layout or Docker-save tar archives only. [K66]
It MUST preserve argument order and MUST NOT discover images. [K67]
A duplicate import MUST succeed with the same content-addressed image records. [K68]
A failed archive MAY leave blobs or records; retrying it MUST be safe. [K69]
Failure MUST stop later archives while retaining earlier completed imports. [K70]
The Helper MUST reject links, devices, directories, changing files, and files larger than free Root storage. [K71]
It MUST stage each archive as a 0600 Root temporary file and remove that file after the attempt. [K72]

Ready requires valid identity, a responding API, all nodes Ready, and completed CoreDNS rollout.
Start readiness MUST use one Operation deadline of 10 minutes. [K73]
A readiness timeout MUST retain logs, clean owned processes and Scope, persist error, and exit 22. [K74]
A repeated ready start MUST recheck readiness without replacing the Cluster. [K75]

## 06. Commands, locks, and state kernels

*Depends on: Parts 00 through 05. Conformance: L0 and L3.*

Grammar is `valet-kubernetes {start|status|stop|diagnose}` or `valet-kubernetes import ARCHIVE...`.
Invalid grammar MUST print usage on stderr, emit no JSON, and exit 2. [K76]
The Helper MUST run as UID 1500 and refuse UID 0 with exit 20. [K77]

A mutating command MUST hold the exclusive lock only while it validates, claims, or commits an Operation. [K78]
It MUST release the lock during launch, readiness polling, signaling waits, archive copying, and import. [K79]
Lock acquisition MUST time out after 30 seconds with exit 24 and a retry action. [K80]
Status MUST take a shared lock for one state snapshot, then release it before probes. [K81]
Diagnose MUST use the same read-only pattern. [K82]

A concurrent start MUST join the current start Operation and share its deadline. [K83]
Import during start or stop MUST report non-ready and exit 4. [K84]
Stop during start MUST set `cancelRequested`, persist `stopping`, and perform bounded owned cleanup. [K85]
Start during stop MUST report stopping and exit 4. [K86]
Stop during import MUST request cancellation, wait for the current archive process, then clean the Cluster. [K87]
A recovering command MUST adopt only an Operation whose epoch and process identity match. [K88]

The lifecycle kernel is `(persistedState, operation, identity, activeOperation) -> decision`.
It MUST match every lifecycle vector. [K89]
The status kernel is `(persistedState, identity, readiness) -> derivedReport`.
It MUST match every status vector without changing persisted state. [K90]
A persisted ready state with dead, missing, or mismatched identity MUST report `error:identity_invalid` and exit 4. [K91]

Successful mutating commands MUST emit the derived compact status JSON and exit 0. [K92]
Status MUST always emit compact JSON, including error reports. [K93]
Status exits MUST be 0 for ready, 3 for stopped, and 4 for every other report. [K94]
Mutating command failure MUST emit one corrective stderr error and no success JSON. [K95]
Diagnose MUST emit deterministic check JSON and exit 20 when any prerequisite fails. [K96]
Import from a non-ready state MUST emit one corrective stderr error, no JSON, and exit 4. [K97]
Logs MAY contain time data; vector-compared JSON MUST NOT contain time data. [K98]

Stop MUST send SIGTERM to the owned group, wait 10 seconds, then send SIGKILL and wait 2 seconds. [K99]
It MUST use validated Scope `cgroup.kill` for survivors and wait 10 seconds for `populated 0`. [K100]
It MUST remove owned descendants bottom-up and retain state for unsafe, foreign, or populated paths. [K101]
A stopped stop MUST succeed without side effects. [K102]

## 07. Map kernel and threats

*Depends on: Parts 00 through 06. Conformance: L0 to L4.*

The map kernel input is a list of integer `(inner, outer, count)` triples.
It MUST reject malformed rows, zero counts, arithmetic overflow, and any interval containing ID 4294967295. [K103]
It MUST reject overlapping outer intervals because `newuidmap` and `newgidmap` reject them. [K104]
It MUST ignore valid inner intervals wholly above 65535 when it computes target coverage. [K105]
It MUST reject overlap or a gap within inner target interval 0 through 65535. [K106]
It MUST accept coverage that starts at 0 and extends beyond 65535. [K107]
It MUST accept unordered split coverage when its clipped union covers 0 through 65535. [K108]
Subordinate files MUST grant UID 1500 outer interval `65536:65535` for both UID and GID. [K109]

| Threat | Bound invariant | Mechanical proof |
|---|---|---|
| Provider grant expansion | INV-1, INV-3 | Manifest golden for K23 to K32 plus live A2 |
| Map truncation or alias | INV-3, INV-5 | Executed K103 to K109 vectors plus A5 |
| PID reuse | INV-1 | K59 to K61 identity vectors plus A9 |
| Cgroup service damage | INV-1 | K62, K63, K99 to K101 tests plus A6 and A10 |
| Lifecycle race | INV-3, INV-6 | K78 to K90 race vectors plus A8 and A12 |
| Supply substitution | INV-2, INV-3 | K39 to K44 digest and image tests |
| Ambient import | INV-2 | K64 to K72 argv vector plus A7 tracing |
| False readiness | INV-3 | K73 to K75 and K90 to K91 failure fixtures |
| Persistent stale cluster | INV-3, INV-6 | K52 to K58 epoch vectors plus A13 |

## 08. Migration and rollout

*Depends on: Parts 00 through 07. Conformance: L4.*

Mono PR #8098 MUST remain the behavioral oracle until corrected Mono and Valet pass L4. [K110]
Mono MUST correct its `<root>/data/agent/containerd/containerd.sock` address to K64 before parity. [K111]
Implementation order MUST be artifacts, image startup, provider, schema, Helper, generic tests, then Mono adapter. [K112]
Implementation MUST preserve PR #659 Tini behavior and PR #661 subordinate ranges. [K113]

Infra PR [test-agents-infra#11](https://github.com/tkhq/test-agents-infra/pull/11) is stage 1.
Stage 1 MUST remain Kubernetes 1.34 without `idsPerPod`. [K114]
Stage 2 MUST upgrade control plane and all node groups to 1.35 with health gates. [K115]
Stage 2 MUST set `idsPerPod:131072`, preserve OCI device rules, and pass A2 before image rollout. [K116]
Stage 3 MUST deploy the capability-disabled image and run ordinary sandbox regressions. [K117]
Stage 4 MUST enable one canary repository, pass A1 through A13, then widen access. [K118]

Rollback MUST disable new capability admission while existing Clusters remain stoppable. [K119]
An image rollback MUST retain the Helper until all managed Clusters stop. [K120]
Node rollback MUST use replacement capacity because EKS components do not downgrade in place. [K121]

After L4, Mono MUST replace its lifecycle script with Helper start, import, and stop calls. [K122]
The adapter MUST keep `VALET_SANDBOX_DOCKER=1`, `TK_ENV`, Make targets, and `K3S_STATE_DIR` compatibility. [K123]
It MUST copy only the canonical kubeconfig, then rename that copy's context to `k3d-tkhq`. [K124]
It MUST NOT read or modify an ambient or canonical kubeconfig. [K125]
Mono MUST retain archive selection, builds, Kustomize, application readiness, SOPS, e2e, and external k3d. [K126]

## 09. Non-goals and normative artifacts

*Depends on: Parts 00 through 08. Conformance: all levels.*

A v1 implementation MUST NOT ship an excluded item under the v1 label. [K127]

| Excluded item | Reason | Re-entry seam |
|---|---|---|
| Remote CLI, plugin, or action | Consumers have the Helper and kubeconfig. | New API and authorization review |
| Arbitrary distro or version | One lock bounds behavior. | New capability version |
| Multiple clusters, nodes, or host management | They exceed sandbox authority. | New topology contract |
| Privileged workloads | They break the provider bound. | Separate admission class |
| Automatic image discovery | The caller owns import intent. | Explicit selection API |
| Manifests, application readiness, or secrets | Mono and existing brokers own them. | Adapter or broker contract |

The JSON vectors are normative.
Implementation tests MUST consume these vectors without copied values. [K128]
The validator MUST execute kernels and reject duplicate, missing, unknown, or vacuous vector coverage. [K129]
Acceptance-only vectors MUST name an A-step and a concrete falsifying check. [K130]
The managed environment MUST match `k3sEnv` and set `VALET_SANDBOX_KUBERNETES=1`. [K131]
The Helper MUST clear every unlisted `K3S_*`, `CONTAINERD_*`, and `ROOTLESSKIT_*` variable before launch. [K132]
Stop MUST terminate a canceled archive process with the K99 bounded TERM and KILL sequence. [K133]
A cold start MUST require the `minimumFreeBytes` vector within the existing PVC quota. [K134]
