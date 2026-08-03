# `.valet/prebuild.yaml` schema

Place this file at the root of your repository to customize sandbox image prebuild behavior. All fields are optional. Omit the file entirely to use pure auto-detection.

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

## Dockerfile step order

The bake produces a Dockerfile in this order:

1. `FROM <base image>` — org base (or the `image` override).
2. Clone the repo into `/prebuilt/repo`. The clone runs inside a single `RUN --mount=type=secret,id=git-token` instruction, so the git token is never written to an image layer. The instruction writes an ASKPASS helper, clones, sets `WORKDIR /prebuilt/repo`, checks out the commit SHA, and removes the helper — all in one layer.
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

The org base image provides: `python3`, `jq`, `build-essential`, `curl`, and the Node runtime. Repos that need more must add it via `setup` or `image`.

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
