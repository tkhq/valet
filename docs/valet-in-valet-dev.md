# Valet-in-Valet dev

How a Valet sandbox spawned against this repo turns into a working
Valet dev environment. Read this before you spawn a fresh sandbox to
work on Valet itself.

The prebuild spec is [`.valet/prebuild.yaml`](../.valet/prebuild.yaml).
The reconcile model is
[`docs/specs/2026-08-02-sandbox-reconcile-design.md`](specs/2026-08-02-sandbox-reconcile-design.md).
The Kubernetes runbook it composes with is
[`docs/kubernetes.md`](kubernetes.md).

## What the sandbox has on first attach

The prebuild `setup` steps bake this into the image:

- Node 22, `pnpm` pinned via `corepack prepare pnpm@<pin> --activate`.
  The pin tracks `package.json`'s `packageManager` field.
- A full `pnpm install --frozen-lockfile`. Every workspace's
  `node_modules` is present, so `pnpm --filter @valet/api dev` starts
  without a pre-step.
- `make`, `lsof`, `procps`, `iproute2`, `python3`, `jq`,
  `build-essential`. The Makefile's port sweep (`dev-stop`), the docs
  linter, and the native-module build path all work.
- `helm` and `kubectl`, pinned and checksum-verified.
- `k3d` (v5.7.5), pinned and checksum-verified.
- `/usr/local/bin/valet-cluster-up`. An idempotent script that creates
  the local k3s cluster the `make k8s-*` targets want.
- `/usr/local/bin/valet-fetch-env`. A POSIX sh helper that mints the
  dev-stack `ANTHROPIC_API_KEY` from the Valet API and writes it to a
  tmpfs file the shell sources. See "How the API key reaches the
  sandbox" below.
- `/etc/profile.d/valet-in-valet.sh`. Sources the tmpfs env on every
  interactive shell.
- Docker CLI and rootless daemon. Set by `docker: true` in
  [`.valet/prebuild.yaml`](../.valet/prebuild.yaml). The daemon starts
  at pod boot from `docker/start-docker.sh`.

At first attach the sandbox runs:

- `docker/start-docker.sh` starts the docker daemon.
- The interactive shell sources `/etc/profile.d/valet-in-valet.sh`,
  which calls `valet-fetch-env` and imports the tmpfs env.
- The Makefile's `k8s-*` targets call `valet-cluster-up` themselves
  when they detect a Valet sandbox. You can also run it by hand.

## Which cluster runtime, and why

k3d wraps k3s in Docker containers. The reference dev cluster is
Rancher Desktop, which is k3s under the hood, so the prebuild picks
k3d to match. The alternatives:

- **kind**. Targets kubeadm images. The runtime and the flag surface
  drift further from Rancher Desktop.
- **Rootless k3s on the sandbox host**. The sandbox shell runs as an
  unprivileged user. It cannot bind cgroup v2 or write
  `/var/lib/rancher` without a root escalation seam that does not
  exist inside a live sandbox.
- **k3d**. The smallest step from Rancher Desktop that runs from a
  non-root user against the docker socket.

## The known limit

k3d cannot mount a fresh sysfs inside its k3s container while the
sandbox's docker daemon runs rootless-in-userns. Every `k3d cluster
create` in a Valet sandbox fails today with:

    operation not permitted (mount "sysfs" -> "/sys")

`valet-cluster-up` catches this and prints the corrective action. The
tools land regardless. When the sandbox capability that grants a
proper privileged inner runtime lands (see Follow-up), the same
`valet-cluster-up` starts working without an image rebuild.

The `make k8s-*` targets pin `--context rancher-desktop`. When
`valet-cluster-up` succeeds it renames the k3d context to that name so
every `make` target reaches the local cluster. When it fails the
targets exit with a readable error. **The Makefile never operates on
the ambient current-context**, per the `CLAUDE.md` "Kubernetes context
safety" rule.

## How the API key reaches the sandbox

The rule: no `ANTHROPIC_API_KEY` in the image, no `ANTHROPIC_API_KEY`
in the repo, no `ANTHROPIC_API_KEY` on disk after the sandbox stops.

The path:

1. The Valet API holds the key in its credential store. This is the
   same place `resolveModelSpec`
   (`packages/api/src/services/model-resolution.ts`) reads for live
   model turns. The org's `anthropic` LLM-provider row points at the
   credential. The api's own `process.env.ANTHROPIC_API_KEY` is the
   fallback.
2. `POST /api/sandbox/env` (`packages/api/src/routes/sandbox-env.ts`)
   returns `{ anthropicApiKey }` for the sandbox principal, keyed by
   the `x-valet-sandbox` token the middleware already validates for
   `/api/sandbox/*`. `null` means no key exists anywhere.
3. `/usr/local/bin/valet-fetch-env` calls this route at attach time
   and writes `/dev/shm/valet-env` with `export ANTHROPIC_API_KEY=...`.
   `/dev/shm` is tmpfs, mode `0600`, cleared on sandbox restart.
4. `/etc/profile.d/valet-in-valet.sh` sources this file for every
   interactive shell. The Makefile's `dev-api-node` target also
   sources it before `.env` so `pnpm --filter @valet/api dev` picks
   up the key.

The key never touches durable storage inside the sandbox. Rotating
the org credential rotates the sandbox key on the next
`valet-fetch-env` call. Every interactive shell triggers one.

## What is baked vs. what is not

| Item | When | Why |
|---|---|---|
| Base packages (`make`, `lsof`, `python3`, ...) | Bake time | The dev loop and docs lint need them on every attach. |
| `pnpm install --frozen-lockfile` | Bake time | Cold-start latency drops from minutes to seconds. |
| `helm`, `kubectl`, `k3d` binaries | Bake time | Pinned + checksum-verified once. Every attach reuses. |
| `valet-cluster-up`, `valet-fetch-env`, `/etc/profile.d/valet-in-valet.sh` | Bake time | Deterministic, no secret material. |
| K3d cluster creation | First attach | Requires the docker daemon, which starts at pod boot. |
| `ANTHROPIC_API_KEY` fetch | Every shell | The tmpfs write survives one sandbox lifetime. A rotation reaches the next shell. |
| Sandbox token, API URL, session id | Pod boot | `SandboxCreateOpts.env` sets them once. The reconcile spec never changes them. |

## Follow-up

- **`valet-cluster-up` fails inside a live sandbox**. The sandbox's
  rootless-in-userns docker daemon rejects sysfs mount for the k3s
  container. Fix path: extend the sandbox provider surface with a
  privileged inner-runtime flag (analogous to `docker: true`) so a
  repo prebuild can opt in. Track as a product gap. Do not paper
  over it with a fake `rancher-desktop` context.

## Related

- [`docs/prebuild-yaml.md`](prebuild-yaml.md). The `.valet/prebuild.yaml`
  schema.
- [`docs/kubernetes.md`](kubernetes.md). The Kubernetes deployment map.
- [`deploy/README.md`](../deploy/README.md). The Rancher Desktop
  runbook.
- [`docs/specs/2026-08-02-sandbox-reconcile-design.md`](specs/2026-08-02-sandbox-reconcile-design.md).
  Bake time vs. attach time.
