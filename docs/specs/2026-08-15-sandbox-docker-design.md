# Sandbox Docker Support (rootless DinD) — Design

Date: 2026-08-15
Status: approved design, not yet implemented

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
2. **Isolation floor: rootless everywhere.** The daemon runs as a
   non-root user inside the unprivileged sandbox container. No
   `--privileged`, no host `docker.sock` mount, no added capabilities,
   on either provider. This extends the rootless-BuildKit posture that
   the prebuild pipeline already uses in production (see
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
  `dockerd` user. Socket at `/run/docker/docker.sock`, permissions open
  to container-root. Data-root on an ephemeral dir. Exports
  `DOCKER_HOST=unix:///run/docker/docker.sock` for the agent via
  profile env.
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
(`packages/sandbox-docker/src/sandbox.ts`) adds:

```
--security-opt seccomp=unconfined
--security-opt apparmor=unconfined
--device /dev/fuse
--env VALET_SANDBOX_DOCKER=1
```

Nothing else changes. Never `--privileged`.

### sandbox-kubernetes

`SandboxContainer` / `SandboxPodSpec`
(`packages/sandbox-kubernetes/src/types.ts`) gain a `securityContext`
field (none exists today). When `opts.docker`, the manifest builder
(`packages/sandbox-kubernetes/src/manifest.ts`) adds:

- pod annotation
  `container.apparmor.security.beta.kubernetes.io/<container>: unconfined`
- container `securityContext.seccompProfile.type: Unconfined`
- `/dev/fuse` access, using the same mechanism the rootless BuildKit
  builder (`packages/api/src/prebuilds/k8s-builder.ts`) uses in this
  cluster
- an `emptyDir` volume for docker state
- `VALET_SANDBOX_DOCKER=1` in the container env

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
- adds `/dev/fuse`

It does NOT:

- run the sandbox or the daemon as privileged
- mount the host docker socket
- add Linux capabilities
- change anything for sandboxes that did not opt in

The daemon and every container it runs live inside the sandbox's user
namespace. A container escape from the inner docker lands in the
rootless daemon's userns, not on the host. The residual risk is kernel
attack surface through unconfined seccomp — the same trade already
accepted for rootless BuildKit build pods.

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

## Out of scope

- Persistent docker data-root across hibernation.
- docker-compose / buildx multi-arch parity guarantees.
- Per-org policy to forbid `docker: true` (add when org policy
  machinery exists).
- The legacy stack (`packages/worker`, Modal) — frozen.
