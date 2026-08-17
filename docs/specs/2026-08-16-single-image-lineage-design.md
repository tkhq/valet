# Single Image Lineage — Design

Date: 2026-08-16
Status: implemented
Supersedes: the per-profile base-image split in
`2026-07-15-sandbox-images-v2-design.md` (seeding) and the image-selection
parts of `2026-08-15-sandbox-docker-design.md`. The profile and docker
FLAGS survive; only image selection changes.

## Problem

Sandboxes had two image lineages:

- headless: `node:22-bookworm-slim` + an agent-tooling bake layer. No
  start scripts, no docker toolchain.
- full: the CI-published `valet-sandbox` image. Ships the agent tooling,
  gateway, ttyd, code-server, the rootless docker toolchain, and the
  start scripts.

Image resolution selected between them per session, and every hop had to
agree: the stock fall-through, the base-bake lookup, the repo-bake
precedence, and the container command. They did not agree. A full-profile
child resolved the headless base bake and ran `/start-full.sh` on an
image without it — the pod exited 127 forever (the dev-v2 DinD outage).
Repo bakes chained only on the headless base, so prebuilds could not
serve full or docker sessions at all.

## Decision

ONE image lineage. Every sandbox and every bake chains on the full
image. The session flags stop selecting images:

- `profile` decides only whether the interactive services start
  (`start-full.sh` keys off `VALET_SANDBOX_PROFILE`; the manifest sets
  the command and `spec.service`).
- `docker` decides only the capability grants (seccomp/AppArmor
  unconfined, SYS_ADMIN + NET_ADMIN, `/dev/fuse` + `/dev/net/tun`,
  fsGroup, exec identity). The toolchain is always in the image.

Consequences:

1. The image×capability mismatch class is gone: no combination of
   `profile`/`docker` can select an image that cannot serve it.
2. Repo bakes (prebuilds) serve every session shape.
3. A resolution or switch failure degrades (services do not start; the
   agent still runs) instead of crash-looping the pod.

## Mechanics

Seeding (`SourceService.seedDefaultBasesIfMissing`) creates two rows per
org:

| kind | name | profile | FROM |
|---|---|---|---|
| `external` | `stock-full` | — | `VALET_FULL_BASE_IMAGE` |
| `base` | `default-full` | `full` | parent = `stock-full` |

- Re-seed follows `VALET_FULL_BASE_IMAGE` pin changes: the external
  row's ref updates, the identity chain moves, and the nightly scheduler
  rebakes the base and its repo children.
- A legacy `default-headless` base row is disabled on re-seed.

Repo sources parent at `default-full`. `ensureRepoSource` heals legacy
parents on re-bind: a null parent and a headless-base parent both adopt
`default-full`.

Session image resolution (`resolveSnapshot` → `computeSpec`) is
shape-independent: `repoBake ?? fullBaseBake ?? stock`, where stock is
`VALET_FULL_BASE_IMAGE ?? VALET_SANDBOX_IMAGE (deprecated)`.

Stock fallback chain (one chain for FROM and identity —
`stockBaseRef()`): `VALET_FULL_BASE_IMAGE` →
`VALET_SANDBOX_IMAGE` (deprecated) → `ghcr.io/tkhq/valet-sandbox:latest`.

Removed: `VALET_HEADLESS_BASE_IMAGE`, the chart's
`sandbox.headlessBaseImage` value, `HEADLESS_SETUP_COMMANDS`, the
per-profile `defaultImages` selection (`defaultImages.headless` is
accepted and ignored).

## Costs accepted

- Headless sessions pull the fat image. One-time per node on
  kubernetes; registry storage grows (retention already bounds it).
- Everything depends on the CI `valet-sandbox` build. The pin-following
  external ref makes deploy rolls effective; a broken pin degrades to
  the previous pushed base bake.

## Transition

- Existing pushed headless-lineage bakes can win resolution until the
  reparented sources rebake. The start-command probe guards degrade
  this window to "services unavailable" instead of a crash loop.
- No schema change: `image_sources.profile` stays; only `full` base
  rows are seeded and resolved.
