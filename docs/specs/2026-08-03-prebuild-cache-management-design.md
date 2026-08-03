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

**Primary goal: a local dev machine / single-user Valet must never fill its disk from prebuild activity, with zero manual cleanup.** The incident that motivated this was NOT registry images — it was **64 GB of moby build cache** accumulated from iterating (`docker build` runs), which nothing bounds today. A fix that requires the user to remember a prune command fails the goal. So the design leads with automatic build-cache bounding, makes the **docker builder** path (what `dev-local` / single-user uses) first-class, and treats the k8s registry path as the secondary (multi-user/deploy) surface.

Three distinct things accumulate:
1. **moby/docker build cache** — from `docker build` (the api image on every `make k8s-build`, AND every docker-builder bake). The 64 GB killer. Untouched today.
2. **baked images** — docker local image store (docker backend) or the bundled registry + node store (k8s backend). Retention keeps 2/source but there is no global ceiling.
3. **BuildKit job cache** (k8s) — already ephemeral (`emptyDir`), no accumulation.

### Decisions (locked)

1. **Auto-bound the build cache (the priority; automatic, no manual step).** Cap moby build cache to `VALET_PREBUILD_BUILD_CACHE_GB` (default `10`) via `docker builder prune --keep-storage=<cap> -f` (or `--filter until=` where `--keep-storage` is unavailable), run automatically at two seams:
   - **Runtime, docker builder** (single-user local): the docker `ImageBuilder` prunes after each bake. A single-user user never accumulates cache — the daemon self-bounds.
   - **Dev tooling**: `make k8s-build` / `k8s-build-fast` prune after building, so the maintainer's iteration loop (the actual 64 GB source) self-bounds too.
   No cron, no reminder — pruning rides the same actions that create the cache.

2. **Per-source retention floor.** Keep the newest `N = 2` pushed bakes per source (existing `applyRetention`, both backends) — every source always has a current image plus one rollback.

3. **Global size ceiling on baked images (both backends).** `VALET_PREBUILD_CACHE_BUDGET_GB` (default `20` — modest, local-friendly). After any bake pushes, if the summed size of all pushed bake images exceeds the budget, evict oldest-first until under budget. NEVER evict (a) a source's current (newest pushed) bake, or (b) a bake referenced by a live session (`agent_sessions.bake_id` of an `active`/`hibernated` session). Eviction deletes the image (docker `rmi`; k8s registry tag delete) AND the `bakes` row. If the budget cannot be met without touching protected bakes, stop and log a visible warning — never delete a protected image.

4. **Bake size recorded at push.** New nullable `bakes.size_bytes BIGINT`, set when a bake flips to `pushed` — docker: `docker image inspect --format {{.Size}}`; k8s: sum of registry manifest layer sizes. The ceiling sums this column.

5. **Registry GC actually reclaims (k8s only).** The bundled `registry-gc` CronJob was erroring (observed: `Error` pods). Fix it so `registry garbage-collect` runs — deleting a tag frees nothing until GC runs. Retention + ceiling delete tags; GC reclaims blobs. (Docker backend needs no GC — `rmi` frees immediately.)

6. **BuildKit job cache stays ephemeral** (`emptyDir`, one buildkitd per job). No change.

7. **Dev api-image fragility — documented, not code-fixed.** On Rancher Desktop the api image is a local-only tag; kubelet image GC under pressure can evict it and it cannot re-pull, taking the api down. Dev-only (prod pulls from a registry). Decision 1 (bounded build cache) prevents the DiskPressure that triggers this in the first place; a `deploy/README.md` note covers the residual.

### Data model (pre-1.0, edit `0000_app.sql` + Drizzle in place)

- `bakes`: ADD `size_bytes BIGINT` (nullable). Live-cluster DDL in the migration commit body.

### Components (independently testable)

- Build-cache prune helper — a small pure `buildCachePruneArgs(capGb)` → argv, plus the wiring: docker `ImageBuilder` calls it after a bake; `make` targets call `docker builder prune` post-build. `VALET_PREBUILD_BUILD_CACHE_GB` config.
- `SourceService.enforceCacheCeiling(orgId)` — after a push: sum `size_bytes`, evict oldest non-current/non-live bakes until under `VALET_PREBUILD_CACHE_BUDGET_GB`; log when blocked by protected bakes. Backend-agnostic (delegates image delete to the existing `RetentionFn`).
- Bake push path — record `size_bytes` on the pushed transition (docker inspect / registry manifest), then run `applyRetention` (floor) then `enforceCacheCeiling` (ceiling).
- Registry GC — fix the CronJob command/manifest in the chart.
- `deploy/README.md` note.

### Testing

- **Build-cache prune unit:** `buildCachePruneArgs(10)` → correct argv; docker builder invokes prune after a bake (spy the spawn); make-target smoke (documented, not unit).
- **Ceiling unit:** over-budget evicts oldest first; NEVER a source's current or a live-session-referenced bake; stops + logs when only protected remain; under-budget no-op; `size_bytes` summed correctly; delegates delete to the backend `RetentionFn`.
- **Size recording:** a pushed docker bake records `size_bytes` from inspect; k8s from the fixture manifest.
- **Retention floor still holds** alongside the ceiling (N=2 per source).
- **Chart:** registry-gc CronJob golden (fixed command); both `VALET_PREBUILD_*` budgets plumbed.
- **Live (exit criteria, both backends):** iterate builds → moby build cache stays under the cap automatically (no manual prune); drive bakes past a small image budget → oldest non-protected images evict, current + live-referenced survive; k8s registry GC reclaims bytes; disk stays bounded across a full iteration session.

## Non-goals

- Named/per-language base images (rejected).
- Persistent/shared BuildKit layer cache.
- Code-fixing the dev-only api-image eviction (prevented indirectly by decision 1).
