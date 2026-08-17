# Sandbox Docker Support (rootless DinD) — Design

Date: 2026-08-15
Status: implemented (feat/sandbox-docker)
Superseded in part: image selection. Sandboxes now boot ONE image lineage
(the full image, docker toolchain always present) — see
`2026-08-16-single-image-lineage-design.md`. The capability grants, exec
identity, and start-script behavior below are unchanged.

## Problem

Sandboxes cannot run docker commands. Workloads that need a docker
daemon — testcontainers suites, image builds, docker-compose stacks,
and valet's own docker-gated e2e suites — fail inside a sandbox. This
blocks valet-on-valet development and any user repo whose tests need
docker.

## Decisions

1. **Audience:** any user workload. This is a platform capability, not
   a dev-only escape hatch. The design must hold for untrusted agent
   code.
2. **Isolation floor: rootless, with minimal capability grants.**
   The daemon runs as a non-root user inside the sandbox container.
   No `--privileged`, no host `docker.sock` mount. On both providers
   the opted-in sandbox receives exactly: CAP_SYS_ADMIN and
   CAP_NET_ADMIN, devices `/dev/fuse` and `/dev/net/tun`, seccomp
   unconfined, AppArmor unconfined, and unmasked system paths
   (`--security-opt systempaths=unconfined` on docker;
   `procMount: Unmasked` on kubernetes). These grants are empirically
   required: `newuidmap` must write to `uid_map` (needs SYS_ADMIN
   and unmasked `/proc/self/uid_map`), and rootlesskit must set
   `net.ipv4.ip_forward` in its netns via sysctl (needs NET_ADMIN
   and unmasked `/proc/sys`). All other capabilities remain dropped.
   This extends the rootless-BuildKit posture that the prebuild
   pipeline already uses in production (see
   `2026-08-02-sandbox-reconcile-design.md`, decision 4).
3. **Opt-in, two switches:** a `docker: true` key in
   `.valet/prebuild.yaml`, or a `docker` option at session create.
   Either one enables it. Sandboxes without the flag pay only image
   size — the daemon does not start.
4. **Placement: in-sandbox daemon, not a sidecar.** One container, one
   lifecycle, the same shape on both providers. A rootless
   `docker:dind-rootless` sidecar was rejected: the docker backend has
   no pod concept, so a sidecar forces paired-container lifecycle
   management for no isolation gain. Sysbox was rejected: it needs a
   runtime install on every node and does not work on Docker Desktop.
5. **Acceptance bar:** valet's own docker-gated e2e suites
   (`sandbox-docker`, `store-postgres` real-PG, `prebuilds-docker`)
   pass inside a `docker: true` sandbox. This implies build, run,
   volumes, networks, and port publishing work.

## Opt-in flow

The flag rides the same path as `profile`:

1. `.valet/prebuild.yaml` gains an optional top-level `docker: boolean`
   key. `loadPrebuildOverride` (`packages/api/src/prebuilds/recipe.ts`)
   parses and validates it. The prebuild identity hash does NOT include
   the key, so existing bakes do not churn.
2. The session-create API gains an optional `docker: boolean`. Session
   meta assembly (`packages/api/src/engine/session-meta.ts`) stores it.
   The `task` built-in carries the same optional `docker` (and `profile`)
   parameters, so an orchestrator can spawn a docker-enabled child: the
   spawner threads them into the child build and persists them on the
   child's `agent_sessions` row, which keeps a post-restart rebuild
   (through the generic `sessionFor`) on the same sandbox shape.
3. `EngineHost.provisionSandbox` (`packages/api/src/engine/host.ts`)
   resolves `docker = sessionMeta.docker || repoConfig.docker` and sets
   it on `SandboxCreateOpts`.
4. `SandboxCreateOpts` (`packages/engine/src/types.ts`) gains
   `docker?: boolean`. `SandboxCapabilities` gains
   `dockerSupport: boolean`. Providers that cannot honor the flag
   (sandbox-local, virtual) report `dockerSupport: false` and ignore
   it.
5. Providers that honor the flag set `VALET_SANDBOX_DOCKER=1` in the
   container env. The start scripts key off that env var.

## Sandbox image changes

`docker/Dockerfile.sandbox-k8s` (both profiles) bakes the rootless
toolchain, dormant by default:

- `docker-ce-cli`, `dockerd`, `dockerd-rootless.sh` + `rootlesskit`,
  `fuse-overlayfs`, `slirp4netns`, `iproute2`. All pinned; bump
  deliberately (same policy as `CODE_SERVER_VERSION` / `GH_VERSION`).
- A dedicated `dockerd` user with `/etc/subuid` and `/etc/subgid`
  ranges baked in. Rootless dockerd requires user-namespace remapping;
  the agent process stays container-root and is unaffected.
- `docker/start-docker.sh`: launches `dockerd-rootless.sh` as the
  `dockerd` user. Socket at `/tmp/valet-docker/docker.sock`
  (`XDG_RUNTIME_DIR` must be outside `/run`: rootlesskit's
  `--copy-up=/run` hides bind-mount paths under `/run` across the
  user-namespace boundary). After the socket appears, the script
  symlinks `/var/run/docker.sock` to it, so root-run docker CLIs need
  no `DOCKER_HOST`. Data-root at
  `/home/dockerd/.local/share/docker`. Daemon log at
  `/var/log/valet/dockerd.log`.
- `start-full.sh` starts `start-docker.sh` when
  `VALET_SANDBOX_DOCKER=1`. For the headless profile, whose command is
  `tail -f /dev/null` today, providers substitute a wrapper command
  (`/start-headless.sh`) that starts `start-docker.sh` when the env
  var is set, then execs the tail. If the daemon fails to start, the
  sandbox still comes up; `docker` commands fail with the daemon's log
  available at a fixed path named in the error.

Cost when disabled: image size only (~150–200 MB). Prebuilt bakes
inherit the toolchain via `FROM`.

## Provider wiring

### sandbox-docker

When `opts.docker`, `buildDockerRunArgs`
(`packages/sandbox-docker/src/sandbox.ts`) adds, in this order:

```
--security-opt seccomp=unconfined
--security-opt apparmor=unconfined
--security-opt systempaths=unconfined
--cap-add SYS_ADMIN
--cap-add NET_ADMIN
--device /dev/fuse
--device /dev/net/tun
--env VALET_SANDBOX_DOCKER=1
```

`systempaths=unconfined` unmasks `/proc/sys` so rootlesskit can set
`net.ipv4.ip_forward` in its netns. Never `--privileged`.

### sandbox-kubernetes

`ContainerSecurityContext`
(`packages/sandbox-kubernetes/src/types.ts`) gains
`capabilities?: { add: string[] }` and
`procMount?: "Unmasked" | "Default"`. When `opts.docker`, the
manifest builder (`packages/sandbox-kubernetes/src/manifest.ts`) adds:

- pod annotation
  `container.apparmor.security.beta.kubernetes.io/<container>: unconfined`
- container `securityContext`:
  `{ seccompProfile: { type: "Unconfined" }, capabilities: { add: ["SYS_ADMIN", "NET_ADMIN"] }, procMount: "Unmasked" }`
- `/dev/fuse` hostPath device volume (same mechanism as the rootless
  BuildKit builder in `packages/api/src/prebuilds/k8s-builder.ts`)
- `/dev/net/tun` hostPath device volume (needed by rootlesskit)
- an `emptyDir` volume for docker state
- `VALET_SANDBOX_DOCKER=1` in the container env

Note: `procMount: Unmasked` requires the ProcMountType feature gate.
Where that gate is unavailable, the k8s DinD path does not converge.
This is checked at acceptance.

### Exec identity

Acceptance testing surfaced the root cause of inner-container
failures (`chdir /workspace: permission denied`): the agent's execs
ran as container root, and root-owned files have no mapping inside
the rootless daemon's user namespace. The fix: in a docker-enabled
sandbox, every non-privileged exec runs as the `dockerd` workload
user.

- Contract: `ExecOpts.privileged` (engine). Default false. Prep's
  system steps (the `/usr/local/bin` credential-helper install) pass
  `privileged: true` and keep root. Everything else — the agent's
  commands, git clone and config — runs as `dockerd`.
- sandbox-docker: `buildDockerExecArgs` adds `-u dockerd` and
  `--env HOME=/home/dockerd`. Creds files are written 0644 (dir
  0755) so the credential helper can read them as `dockerd`.
- sandbox-kubernetes: `pods/exec` has no per-call user, so
  `execInPod` wraps the composed command in
  `setpriv --reuid dockerd --regid dockerd --init-groups` with
  HOME/USER/LOGNAME set. The flag reaches the exec layer from
  `SandboxCreateOpts.docker` at create and from the CR's
  `valet.dev/docker` label on restore.
- Workspace ownership: `start-docker.sh` chowns `/workspace` to
  `dockerd` (non-recursive) on the docker provider; the k8s manifest
  sets pod-level `securityContext.fsGroup: 1500` so the PVC mounts
  group-writable.

Sandboxes without `docker: true` are unchanged — `privileged` has no
effect there.

### State lifetime

Docker state (images, containers, volumes created inside the sandbox)
is ephemeral in v1: lost on hibernate, recreate, and reconcile. Images
re-pull on next use. Persisting the data-root on the workspace PVC is
a possible later optimization; it is out of scope here because
fuse-overlayfs state on a shared PVC has unclear crash semantics.

## Security posture

`docker: true` relaxes, per opted-in sandbox only:

- seccomp: unconfined (larger kernel syscall attack surface)
- AppArmor: unconfined
- system paths: unconfined (unmasked `/proc/sys` for sysctl in rootlesskit netns)
- capabilities: adds CAP_SYS_ADMIN and CAP_NET_ADMIN
- devices: adds `/dev/fuse` and `/dev/net/tun`

CAP_SYS_ADMIN on the outer container is the largest single relaxation.
It is confined to opted-in sandboxes and is strictly weaker than
`--privileged` (no raw block devices, all other caps dropped, system
paths selectively unmasked rather than fully exposed).

It does NOT:

- run the sandbox or the daemon as privileged
- mount the host docker socket
- add any capability beyond SYS_ADMIN and NET_ADMIN
- change anything for sandboxes that did not opt in

The daemon and every container it runs live inside the sandbox's user
namespace. A container escape from the inner docker lands in the
rootless daemon's userns, not on the host. The residual risk is kernel
attack surface through unconfined seccomp and SYS_ADMIN — the same
trade already accepted for rootless BuildKit build pods.

`docs/security-model.md` gains a subsection stating the above.

## Testing

1. Unit: `buildDockerRunArgs` and the k8s manifest builder emit the
   exact deltas above when `docker: true`, and emit nothing extra when
   absent. Conformance: `dockerSupport` capability reported correctly
   per provider.
2. E2e (gated `needs: ["docker"]`): create a `docker: true` sandbox,
   then inside it run `docker build` on a small context, `docker run`
   with a bind volume and a published port, and assert output.
3. Acceptance (manual at first): clone valet inside a `docker: true`
   sandbox and run the docker-gated suites
   (`make e2e E2E_ARGS="--only sandbox-docker,store-postgres,prebuilds-docker"`).
   Record results in the PR.

## Kubernetes reality (2026-08-17 addendum)

Live verification on EKS v1.31 (agents-dev) found three failures with a
single dominant root cause. Valet's CR was correct in every case.

1. **The API server drops `procMount: Unmasked`.** The `ProcMountType`
   feature gate is beta and OFF by default until Kubernetes 1.33, and EKS
   does not let operators set control-plane gates. Admission silently
   rewrites the field to `Default` (verified with a server-side dry-run).
   The pod's /proc keeps its masked and read-only paths, which breaks:
   - `dockerd-rootless.sh`: its `--detach-netns` path writes
     `net.ipv4.ip_forward` through the read-only `/proc/sys` → EPERM.
   - runc for EVERY inner container: the kernel refuses a fresh procfs
     mount in a user namespace unless an existing fully-visible procfs is
     present → `mount proc: operation not permitted` on `docker run` and
     `docker build`.
2. **`/dev/fuse` open fails with EPERM.** A hostPath char-device volume
   carries no device-cgroup grant (unlike the docker backend's
   `--device /dev/fuse`), so fuse-overlayfs cannot open the device even
   though the node is mounted.
3. **`overlay2` needs a non-overlay data-root.** The pod rootfs is
   overlay; the emptyDir docker-state volume is not — native rootless
   overlay2 works there (kernel >= 5.11).

Mitigations shipped:

- `start-docker.sh` invokes rootlesskit directly WITHOUT `--detach-netns`
  (empirically starts on masked-proc clusters) and probes storage drivers
  in order overlay2 → fuse-overlayfs → vfs. The daemon now starts
  everywhere; inner containers still need an unmasked /proc.
- The manifest sets `hostUsers: false` on docker pods. Kubernetes >= 1.31
  validation requires it for `procMount: Unmasked` and REJECTS the pod
  without it once the ProcMountType gate is on (default from 1.33). On
  clusters with `UserNamespacesSupport` off the field is dropped at
  admission — inert today, load-bearing after the upgrade.
- The image's `dockerd` sub-id range moved to `2000:63536` so it fits
  inside the 65536-id pod user namespace that `hostUsers: false` creates.

Cluster requirement for FULL DinD on kubernetes: **Kubernetes >= 1.33**
(ProcMountType + UserNamespacesSupport on by default) with a node runtime
that supports user-namespaced pods. Until the cluster upgrade, DinD on
kubernetes is degraded: the daemon runs, `docker pull`/`system df` work,
`docker run`/`build` fail on the proc mount.

## Out of scope

- Persistent docker data-root across hibernation.
- docker-compose / buildx multi-arch parity guarantees.
- Per-org policy to forbid `docker: true` (add when org policy
  machinery exists).
- The legacy stack (`packages/worker`, Modal) — frozen.
