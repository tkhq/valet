# Sandbox Images v2 Design — custom images + repo prebuilds

**Date:** 2026-07-15
**Status:** Draft
**Scope:** User-facing custom sandbox images (admin catalog) and repo prebuilds — images baked with repo contents + installed dependencies so big repos don't cold-clone and reinstall every session. Covers the backend-neutral `ImageBuilder` port, docker and Kubernetes (BuildKit Job) builder implementations, the registry story (bundled + external toggle), the recipe model (auto-detect + override), and freshness semantics. Replaces the legacy Modal-era `docs/specs/sandbox-images.md` direction for the v2 stack (that spec stays as legacy documentation).

## Context

- `SandboxCreateOpts.image` already exists as a per-session knob (wired by the k8s deployment pass), but nothing user-facing sets it, and there is no build pipeline and **no registry anywhere** — the reference env is local `docker build` in moby mode.
- Session start today is: provision sandbox from the stock image → clone the repo → install deps. For large repos this dominates time-to-first-command.
- CLAUDE.md's locked decision 4 ("repo-specific images from day one, base image fallback") was implemented for the legacy Modal stack; this spec is its v2 successor.
- Composition: warm pools (hibernation spec, Stage 2) are per-`SandboxTemplate`, i.e. per-image — prebuilds and pools multiply per-repo. The auth-gateway spec's `full`-profile services live in the base images prebuilds build `FROM`, so prebuilds inherit them.

## Decisions (locked)

1. **UX is repo-first; the catalog is the advanced surface.** Selecting a repo when starting a session is the entire flow for most users. Resolution at session create: repo has a ready prebuild → boot from it; no prebuild (or builder unavailable, or build failed) → stock/base image + cold clone, exactly today's behavior. **Prebuilds are an optimization, never a correctness dependency** — every failure mode degrades to cold-start. The **image catalog** is an org-admin settings surface: register base images (public refs, or private refs + pull secret) and manage per-repo prebuild configs. Members never enter free-form image refs; they pick a repo (and, at most, a catalog entry).

2. **`ImageBuilder` is its own optional port, a sibling of `SandboxProvider` — not a method on it.**
   ```
   interface ImageBuilder {
     readonly backend: string;
     build(spec: PrebuildSpec): Promise<{ buildId: string }>;   // async; returns immediately
     status(buildId): Promise<BuildStatus>;                      // queued|building|pushed|failed + log tail
     cancel?(buildId): Promise<void>;
   }
   ```
   Resolved per backend at boot (`VALET_SANDBOX_BACKEND` picks the default pairing; overridable independently). **No builder configured → prebuild UI reads "unavailable on this deployment" and everything falls back to cold-start.** Building images is not sandbox lifecycle: keeping the port separate means a deployment can later mix providers and builders without touching the (adversarial-review-protected) `SandboxProvider` contract. Separately and more weakly, `SandboxCapabilities` gains `customImage: boolean` — whether the provider can run arbitrary catalog refs at all (docker/kubernetes `true`, local `false`).

3. **Docker builder ships first (dev backend).** `docker build` against the local daemon via dockerode, image tagged `valet-prebuild/<repo-slug>:<commitSha>`, **no registry involved** (the daemon's image store is the store; the docker sandbox provider runs it directly). This is the cheapest full implementation and the recipe format's dogfooding vehicle on `make dev-local`.

4. **Kubernetes builder: one BuildKit Job per build.** The api creates a `batch/v1` Job in the sandbox namespace running rootless BuildKit (`moby/buildkit:rootless`), building from a generated Dockerfile + build context (see decision 6) and pushing to the configured registry. The api watches Job status and streams pod logs into the build record — the same client-node driving pattern as sandboxes. RBAC addition to the existing namespaced Role: `batch/jobs` create/get/list/watch/delete (pods/log already granted). Build resource limits and a concurrency cap (default 1 concurrent build) come from chart values — builds are the most resource-hungry thing we schedule. Timeout via Job `activeDeadlineSeconds` (default 30 min).

5. **Registry: bundled + external toggle (bundled-Postgres pattern).** The chart optionally ships an in-cluster `registry:2` StatefulSet (PVC via default storage class, ClusterIP Service; plain HTTP inside the cluster, cluster-internal only — no ingress). `externalRegistry: { url, pullSecret }` in values disables it and points builder pushes + sandbox pod pulls at ghcr/ECR/etc. Retention: keep the **last 2 images per prebuild config** (newest ready + previous, so an in-flight rebuild never deletes the image a running session was created from); older tags deleted via the registry API + periodic GC (`registry garbage-collect` CronJob for the bundled instance; external registries own their retention). Sandbox pods reference images by full registry path with `IfNotPresent`.

6. **Recipe: auto-detect + optional committed override.** A prebuild bakes: base image (catalog entry or the stock sandbox image) → `git clone` at head (bakes commit X) → detected dependency install → optional extra setup commands. Detection is lockfile-driven, run against the cloned tree at build time: `pnpm-lock.yaml`/`package-lock.json`/`yarn.lock` → corresponding install; `uv.lock`/`requirements.txt` → uv/pip; `Cargo.lock` → `cargo fetch` + optional build; `go.sum` → `go mod download`; composable when several match (monorepos). A committed **`.valet/prebuild.yaml`** overrides: `{ image?, setup?: [commands], skipDetect?: bool }`. The generated Dockerfile is deterministic from (base image, repo@sha, recipe) — that triple is the build's cache identity. devcontainer.json is a non-goal.

7. **Freshness: stale-OK + fetch-on-start.** The image carries the repo at commit X; correctness comes from session start, not build recency:
   - Session start on a prebuilt image runs `git fetch` + checkout of the target ref (fast: most objects are already baked) as part of workspace preparation.
   - Setup re-run condition: if any detected lockfile differs between X and head, the corresponding install re-runs before the session is handed over; otherwise skip.
   - Rebuild triggers: manual ("Rebuild now" on the config) and a coarse schedule (default nightly, per-config configurable, off allowed). **No push webhooks this pass.**

8. **Data model (app-side tables, `packages/api`):**
   - `prebuild_configs`: org, repo (provider/owner/name + clone URL), catalog image ref (nullable → stock), schedule, enabled. The recipe itself is not stored here — it's read from `.valet/prebuild.yaml` (or auto-detected) at build time, and each build records the resolved recipe on its `prebuilds` row for reproducibility.
   - `prebuilds`: config id, commit SHA, image ref, status (`queued|building|pushed|failed`), builder backend, started/finished timestamps, error, log location.
   - Session create resolves repo → newest `pushed` prebuild → `SandboxCreateOpts.image`; the chosen prebuild id is recorded on the session for observability. Pre-1.0 rule applies: columns land in the existing `0000` app migration.
   - **Repo credentials:** clone at build time uses the org's existing GitHub credential (the credential store / GitHub App integration) injected as a BuildKit secret — never baked into a layer. The baked repo keeps its origin remote pointed at the credential-less URL; session-start fetch uses the session's normal git credential wiring.

9. **Web UI:** repo picker on session create (already the direction) gains a subtle "prebuilt · repo@<short-sha> · built <ago>" badge when a prebuild will be used. Settings → Sandbox images: catalog CRUD (admin), per-repo prebuild configs with build history, status, log view, "Rebuild now".

10. **Composition with in-flight specs (both are one-line seams, no coupling):**
    - **Warm pools (hibernation spec, Stage 2):** `SandboxTemplate` is per-image, so each prebuild config maps to at most one template/pool; pool sizing is image-keyed. Nothing in Stage 1 touches images.
    - **Auth gateway:** the `full`/`headless` profile split lives in the *base* images; prebuilds build `FROM` a base and inherit the profile's services. Prebuild configs record which base they extend.

## Exit criteria (the dogfood)

Kubernetes (Rancher Desktop, bundled registry): configure nothing; pick a large repo — first session cold-clones while a prebuild bakes (Job visible, logs streaming in settings); second session boots from the prebuilt image and time-to-first-command drops to pull+prep time (measured and shown on the build record); push a commit upstream, next session's workspace is at head via fetch; change a lockfile upstream, next session re-runs install before hand-over; kill the builder Job mid-build → build marked failed, sessions keep cold-starting, "Rebuild now" recovers; retention keeps exactly 2 tags after 3 builds. Docker (`make dev-local`): the same repo flow end-to-end minus registry.

## Testing

- **Recipe unit:** lockfile detection matrix (single + monorepo-composed), Dockerfile generation determinism (golden files), `.valet/prebuild.yaml` parsing/override precedence, cache-identity triple.
- **Builder contract:** a shared conformance suite over `ImageBuilder` (build→status→pushed happy path, failure surfacing, cancel, timeout) run by both implementations — docker-gated and k8s-cluster-gated respectively, same pattern as the sandbox provider suites.
- **Resolution integration:** session create picks newest pushed prebuild; falls back on none/failed/builder-absent; records prebuild id; `customImage: false` provider ignores catalog refs.
- **Fetch-on-start:** baked-at-X + upstream-moves-to-Y → workspace at Y; lockfile-change → setup re-ran; no-change → skipped (timing-asserted).
- **Chart:** golden-file assertions for bundled registry on/off, builder RBAC (`batch/jobs`), build resource values; secret never rendered into the generated Dockerfile or Job env (BuildKit secret mount only).

## Non-goals

- devcontainer.json support (revisit on demand).
- Push-webhook-triggered rebuilds and build queues beyond a simple concurrency cap.
- Cross-repo/base-image layer dedup optimizations beyond what BuildKit's cache gives per build.
- Free-form image refs for non-admin members.
- Per-user (non-org) catalogs.
- Multi-arch builds (build for the cluster's arch; values-level knob later if a mixed cluster shows up).
- Snapshot-based alternatives (filesystem snapshots of warmed sandboxes) — different mechanism, possibly a later complement via `capabilities().snapshot`.
