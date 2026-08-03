# Prebuild Cache Management + `.valet/prebuild.yaml` Customization

**Date:** 2026-08-03
**Status:** Customization model — implemented + verified live. Cache management — approved design, not yet implemented.
**Scope:** Two things. (1) Records the settled per-repo prebuild customization model: ONE org base image plus a committed `.valet/prebuild.yaml` per repo that needs special handling — no named/per-language base images. (2) Designs bounded cache management so baked images cannot fill the node's disk. Amends `2026-08-02-sandbox-reconcile-design.md` (generation path). Supersedes the abandoned `2026-08-03-named-base-images-design.md` (multi-base/Heroku-detection was rejected as too complex).

## Part 1 — Customization model (settled, already built)

**One org base image.** A single `base` source per org (unchanged from the reconcile spec). It carries the common denominator: `python3`, `jq`, `build-essential`, `curl` on top of the stock sandbox image (which already ships node + yarn). Repo bakes chain `FROM` it.

**`.valet/prebuild.yaml` is the per-repo customization surface.** Already wired (`recipe.ts` `loadPrebuildOverride` + `resolveRecipe`, `generateDockerfile`). Fields:
- `setup: string[]` — commands layered onto the base in the repo's prebuilt image (after clone + auto-detected install). Covers BOTH "modify the base for this repo" (e.g. install a toolchain) and "additional commands baked into the prebuilt image."
- `image: string` — override the base ref entirely for this repo.
- `skipDetect: boolean` — turn off lockfile auto-install for full manual control.

Dockerfile order (per repo bake): `FROM base → clone → WORKDIR /prebuilt/repo → checkout → [auto-detected install unless skipDetect] → setup commands`.

**Verified live (2026-08-03):**
- `ProofLabDev/prooflab-frontend` `.valet/prebuild.yaml` = `setup: [yarn global add serve]` → baked image has node_modules (1021 pkgs, auto-detected) plus `serve` 14.2.6.
- `ProofLabDev/prooflab-rs` `.valet/prebuild.yaml` = `skipDetect: true` + `setup: ["curl … rustup … | sh -s -- -y --profile minimal && . $HOME/.cargo/env && cargo fetch"]` → baked image has cargo + 830 fetched crates, with NO system cargo in the (lean) base — proving a repo self-provisions its toolchain without an org-wide language base.

**Rationale for rejecting named bases.** Per-language base images (Python/Rust/JS) with detection added a template registry, lazy seeding, a selection-precedence ladder, and multi-language ambiguity — for a capability `.valet/prebuild.yaml` already delivers. A repo that needs Rust commits a `prebuild.yaml` that installs Rust. The org base stays lean; special cases live with the repo that needs them.

**Follow-up (docs, in scope):** document the `.valet/prebuild.yaml` schema for users (fields, order, the skipDetect-for-toolchains pattern) in `docs/` — it is now the primary prebuild customization mechanism and has no user-facing doc.

## Part 2 — Cache management (to build)

The live dogfood filled the single-node cluster's disk: cumulative baking → DiskPressure → kubelet image GC evicted the api's local-only image → api `ImagePullBackOff`, everything stalled. Baked images accumulate in the bundled registry and the node store; a lean base + many repos still grows without bound. Policy: a per-source retention floor plus a global size ceiling, with a working registry GC.

### Decisions (locked)

1. **Per-source retention floor.** Keep the newest `N = 2` pushed bakes per source (existing `applyRetention`) — every source always has a current image plus one rollback.

2. **Global size ceiling.** `VALET_PREBUILD_CACHE_BUDGET_GB` (default `40`). After any bake pushes, if the summed size of all pushed bake images exceeds the budget, evict oldest-first until under budget. NEVER evict: (a) a source's current (newest pushed) bake, or (b) a bake referenced by a live session (`agent_sessions.bake_id` of an `active`/`hibernated` session). Eviction = delete the registry tag + the `bakes` row. If the budget cannot be met without touching protected bakes, stop and log (a visible "over budget, all remaining protected" warning — never delete a protected image).

3. **Bake size recorded at push.** New nullable `bakes.size_bytes BIGINT`, set from the registry manifest (sum of layer sizes) when a bake flips to `pushed`. The ceiling sums this column.

4. **Registry GC actually reclaims.** The bundled `registry-gc` CronJob was erroring (observed: `Error` pods). Fix it so `registry garbage-collect` runs and reclaims blob bytes — deleting a tag/manifest frees nothing until GC runs. Retention + ceiling delete tags; GC reclaims the blobs.

5. **BuildKit job cache stays ephemeral.** One buildkitd per job over an `emptyDir` context — no cross-build accumulation. Accepted tradeoff: no cross-bake layer reuse. Not changing this pass.

6. **Dev api-image fragility — documented, not code-fixed.** On Rancher Desktop the api image is a local-only tag; kubelet image GC under pressure can evict it and it cannot re-pull (no registry), taking the api down. Dev-only (prod pulls from a registry). Mitigations: a runbook note in `deploy/README.md`, and a `make prune-build-cache` helper for the local moby build cache (the 64 GB dev-loop accumulation that triggered the incident — distinct from the product's registry cache).

### Data model (pre-1.0, edit `0000_app.sql` + Drizzle in place)

- `bakes`: ADD `size_bytes BIGINT` (nullable). Live-cluster DDL in the migration commit body.

### Components (independently testable)

- `SourceService.enforceCacheCeiling(orgId)` — after a push: sum `size_bytes`, evict oldest non-current, non-live-referenced bakes until under `VALET_PREBUILD_CACHE_BUDGET_GB`; log when blocked by protected bakes.
- Bake push path — record `size_bytes` from the registry manifest (extend the existing pushed-transition in `syncActiveBuilds`).
- `applyRetention` — unchanged (floor); the ceiling runs after it.
- Registry GC — fix the CronJob command/manifest in the chart.
- `deploy/README.md` note + `make prune-build-cache`.

### Testing

- **Ceiling unit:** over-budget evicts oldest first; NEVER a source's current bake or a live-session-referenced bake; stops + logs when only protected bakes remain; under-budget is a no-op. `size_bytes` summed correctly.
- **Size recording:** a pushed bake gets `size_bytes` from the (fixture) registry manifest.
- **Retention floor still holds** alongside the ceiling (N=2 per source preserved).
- **Chart:** registry-gc CronJob golden (fixed command); `VALET_PREBUILD_CACHE_BUDGET_GB` plumbed.
- **Live (exit criteria):** drive bakes past a small budget → oldest non-protected images evict, registry GC reclaims bytes, current + live-referenced bakes survive; disk stays bounded.

## Non-goals

- Named/per-language base images (rejected).
- Persistent/shared BuildKit layer cache.
- Code-fixing the dev-only api-image eviction.
