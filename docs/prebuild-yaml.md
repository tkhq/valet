# `.valet/prebuild.yaml` schema

Place this file at the root of your repository to configure sandbox resources and image prebuilds. All fields are optional. Without this file, image builds use auto-detection and sandboxes use saved defaults.

## Test the recipe locally

Recipes run inside the platform's image bake, but you can validate and run one from a checkout with the `valet` CLI — no running Valet instance needed:

```
valet prebuild plan            # resolved steps + docker/workspaceStorage knobs
valet prebuild plan --dockerfile
valet prebuild build --base <sandbox image>   # real docker build, streamed
```

`plan` catches schema errors and shows what lockfile detection found (including steps a `skipDetect: true` suppresses). `build` runs the same recipe/setup commands the platform bake runs, against a local clone of your COMMITTED tree — `.git` included, matching the platform's clone, so setup commands that run git (Makefiles using `git rev-parse`, version stamping) behave identically. One exception: the recipe file itself is read from the working tree, so you can iterate without committing each attempt. BuildKit layer caching makes re-runs after editing one step cheap. Pass `--base` when the stock base ref is not pullable from your machine.

Two layer-size rules worth knowing when writing `setup` commands:

1. Run `chmod`/`chown -R` in the SAME command that created the files. A recursive metadata change in a later step copies every touched file into that step's layer (overlayfs copy-up), silently doubling caches in the image.
2. Scope a recursive `chmod` to what the step created, not a whole shared prefix, for the same reason.

## Fields

### `setup`

Type: `string[]`

Extra shell commands to run after the auto-detected install steps. Each command becomes one `RUN` instruction in the baked image.

Use `setup` to bake in tools that your scripts or tests expect to find. The auto-detected install still runs first unless you set `skipDetect: true`.

### `image`

Type: `string`

Override the base image reference. The value replaces the org-configured base for this repo's bake only.

Use `image` when your repo needs a base that differs from the org-wide default (for example, a GPU image or a distro-specific variant).

### `skipDetect`

Type: `boolean` (default `false`)

Set `true` to suppress lockfile auto-detection. No install step runs unless your `setup` commands perform one.

Use `skipDetect` when your repo brings its own toolchain that the base image does not provide and that auto-detection cannot handle. You must supply the full install sequence in `setup`.

### `docker`

Type: `boolean` (default `false`)

Set `true` to give this repo's sessions a rootless docker daemon inside the sandbox. The daemon runs as a non-root user; the sandbox is never privileged. Docker state is ephemeral — images pull again after the sandbox restarts. See `docs/specs/2026-08-15-sandbox-docker-design.md`.

### `resources`

Type: an object with optional `cpu` and `memory` fields.

```yaml
resources:
  cpu: 4
  memory: 8Gi
```

`cpu` is a positive finite number of CPU cores. Fractions such as `0.5` are valid.
`memory` is a positive Kubernetes quantity string, such as `8Gi` or `500Mi`.
Valet trims memory values. Zero, negative, non-finite, or malformed values are invalid.

These fields size the running sandbox. They do not change the image bake.
Kubernetes sets equal requests and limits on the sandbox container. Docker uses
CPU and memory limits and converts the memory quantity to bytes. Non-isolated
providers do not resize the host.

Defaults apply separately to each field, in this order:

1. A value in `.valet/prebuild.yaml`.
2. A repository default saved in **Settings → Organization → Sandbox settings**.
3. The deployment default, `VALET_SANDBOX_CPU` or `VALET_SANDBOX_MEMORY`.
4. The provider's behavior when no value is set.

For example, YAML can set CPU and retain the repository's saved memory default.
In Sandbox settings, clear a field to remove its saved default. Resource controls
remain available when prebuilds are disabled or no image builder is configured.
Only the primary repository supplies settings. Child sessions use the same rules.

Resource edits apply at the next safe reconciliation before a run. Valet replaces
isolated compute when resources change. The persistent working directory survives;
files elsewhere in the sandbox do not. YAML reads use the existing ten-minute
cache. Saved settings are read on each reconciliation.

If YAML or saved-default lookup fails, Valet preserves an existing sandbox's last
known resources. A fresh sandbox uses available defaults. Invalid YAML is reported
and is not cached. Provider startup errors remain visible, including requests
that the cluster cannot schedule. Resource values must satisfy provider constraints.

Changing deployment defaults alone does not restart a running attachment. Current
defaults apply on the next creation or authoritative adoption, including API
restart or recovery. An operator can replace a sandbox to apply them immediately.

### `baseSetup`

Type: `string[]`

REPO-INDEPENDENT setup commands (toolchain installs: compilers, runtimes, apt packages). Split them out of `setup` and they bake into a chained BASE image instead of re-running on every commit's rebake: the platform materializes a per-repo base source (`repo-base:<owner>/<repo>`) whose bake is identity-keyed on these commands, so it rebuilds only when the commands change. The repo bake then builds FROM that image, paying only for the repo-dependent `setup` steps.

Commands here run WITHOUT the repo checkout (before any clone). A command that reads repo files (installs from a lockfile, runs `make`) belongs in `setup`.

The first bake after adding or changing `baseSetup` builds the base layer first; the repo bake follows automatically when it pushes. Removing `baseSetup` reattaches the repo to the org's default base.

### `workspaceStorage`

Type: `string` (a Kubernetes quantity, for example `"4Gi"`; default: the deploy's workspace size, 1Gi)

Declare the workspace volume size this repo needs. The value is a request, not the literal claim size. On kubernetes, the platform bounds the request between the deploy default and the growth cap. Quote the value because a bare `4` names no unit.

The deploy default (`VALET_SANDBOX_WORKSPACE_STORAGE`, default 1Gi) is the floor. The growth cap (`VALET_SANDBOX_WORKSPACE_MAX`, default 20Gi) is the ceiling. A fresh claim starts at this bounded target. When the platform adopts an existing claim for a repo with this declaration, it requests growth toward the same target. The request is best-effort and never shrinks the claim or waits for volume readiness. A read, validation, or resize failure does not block sandbox adoption. The `valet.sandbox.workspace_grow` counter records `pending` and `error` outcomes for these cases. Like `docker`, this key configures the SESSION at create time, not the baked image. See `docs/specs/2026-09-03-sandbox-workspace-fit-design.md`.

The key applies on the kubernetes sandbox backend only. The docker backend (`make dev-local`) mounts `/workspace` from the host filesystem, so it has no volume to size and ignores this key. Use binary or decimal Kubernetes suffixes (`Gi`, `Mi`, `G`, `M`) — forms like `"8GB"` are rejected at read time.

## Dockerfile step order

The bake produces a Dockerfile in this order:

1. `FROM <base image>` — org base (or the `image` override).
2. Clone the repo into `/prebuilt/repo`. The clone runs inside a single `RUN --mount=type=secret,id=git-token` instruction that writes an ASKPASS helper, clones the repo, and removes the helper — all in one layer, so the git token is never written to an image layer. A separate `WORKDIR /prebuilt/repo` directive follows, then a separate `RUN git checkout <sha>` layer checks out the target commit outside the secret mount.
3. Auto-detected install steps — one `RUN` per matched lockfile, unless `skipDetect: true`.
4. `setup` commands — one `RUN` per entry, in list order.
5. `LABEL valet.prebuild.identity="..."` — the identity hash that the cache lookup uses.

## Auto-detection matrix

Valet checks for these files at the repository root, in this order. Multiple entries can fire for the same repo (for example, a Node + Python monorepo gets both `pnpm install` and `uv sync`).

| Lockfile | Command |
|---|---|
| `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` |
| `package-lock.json` | `npm ci` |
| `yarn.lock` | `yarn install --frozen-lockfile` |
| `uv.lock` | `uv sync` |
| `requirements.txt` | `pip install -r requirements.txt` |
| `Cargo.lock` | `cargo fetch` |
| `go.sum` | `go mod download` |

Detection is root-level only. A nested `packages/foo/pnpm-lock.yaml` does not trigger a step.

Repo bakes build on the org's base image (the single full-image lineage — see docs/specs/2026-08-16-single-image-lineage-design.md). The default headless base provides: `git`, `gh`, `ripgrep`, `curl`, `bash`, `openssh-client`, and the Node runtime. It does not include `python3`, `jq`, or `build-essential`. Repos that need more must add it via `setup` or `image`.

## Examples

### Additive: bake in a global tool

Auto yarn install still runs (no `skipDetect`). `serve` is baked in on top.

```yaml
setup:
  - yarn global add serve
```

### Self-provisioned toolchain: bring your own Rust

The org base has no Rust. The repo installs it and fetches dependencies in one `setup` command. `skipDetect: true` prevents a `cargo fetch` step from firing before Rust is present.

```yaml
skipDetect: true
setup:
  - "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal && . $HOME/.cargo/env && cargo fetch"
```
