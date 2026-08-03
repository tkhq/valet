# Prebuild Cache Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Prebuild activity never fills a local dev machine's disk, with zero manual cleanup — automatic build-cache bounding first, then a bounded baked-image budget, then a working k8s registry GC.

**Architecture:** Bound the moby build cache automatically at the two seams that create it (the docker `ImageBuilder` after each bake; the `make k8s-build*` dev targets). Add a global size ceiling on baked images (both backends) on top of the existing per-source retention floor, driven by a new `bakes.size_bytes`. Fix the erroring k8s registry-gc CronJob so tag deletes reclaim blobs.

**Tech Stack:** TypeScript, Node `child_process.spawn` (docker CLI), Drizzle/PGlite, vitest, Helm.

## Global Constraints

- Spec: `docs/specs/2026-08-03-prebuild-cache-management-design.md` — read it; decisions 1-7 are the ground truth.
- Priority order is deliberate: build-cache bounding (Phase 1) is the user's #1 concern and ships first and standalone.
- Pre-1.0: edit `packages/api/migrations/pg/0000_app.sql` + Drizzle schema (`packages/api/src/schema/index.ts`) in place; NO numbered migrations; record live-cluster DDL in the migration commit body.
- No `any`, no `as unknown as T`, no `@ts-ignore` (CLAUDE.md type rules).
- All pruning/eviction is BEST-EFFORT: a prune/delete failure logs one line and never fails a bake or the poll loop.
- Never delete a protected bake: a source's newest pushed bake, or a bake referenced by a live session (`agent_sessions.bake_id` where status ∈ {active, hibernated}).
- Config defaults: `VALET_PREBUILD_BUILD_CACHE_GB=10`, `VALET_PREBUILD_CACHE_BUDGET_GB=20`.
- Every task: `pnpm typecheck` green before commit; commit subjects ≤72 chars.
- Final validation: `make e2e` clean scorecard + live dual-backend disk check.

---

## Phase 1 — Automatic build-cache bounding (the priority)

### Task 1: Bound the moby build cache (runtime docker builder + dev tooling)

**Files:**
- Create: `packages/api/src/prebuilds/build-cache.ts`
- Test: `packages/api/src/prebuilds/build-cache.test.ts`
- Modify: `packages/api/src/prebuilds/docker-builder.ts` (prune after each bake), `packages/api/src/providers/image-builder.ts` (read `VALET_PREBUILD_BUILD_CACHE_GB`, pass to the docker builder), `Makefile` (`k8s-build`/`k8s-build-fast` prune post-build)

**Interfaces (Produces):**
```ts
export function buildCachePruneArgs(capGb: number): string[]; // ["builder","prune","-f","--keep-storage",`${capGb}GB`]
export function pruneBuildCache(spawnFn: SpawnFn, capGb: number): Promise<void>; // best-effort; never throws
```
`SpawnFn` is the same type the docker builder already imports.

- [ ] **Step 1: Write failing tests** — `buildCachePruneArgs(10)` deep-equals `["builder","prune","-f","--keep-storage","10GB"]`; `pruneBuildCache` spawns `docker` with those args; a spawn that errors (non-zero / throws) resolves (does NOT reject) and logs via `console.error`.
- [ ] **Step 2: Run** `pnpm --filter @valet/api exec vitest run src/prebuilds/build-cache.test.ts` → FAIL.
- [ ] **Step 3: Implement** `build-cache.ts` (mirror `docker-builder.ts`'s spawn/exit handling; `--keep-storage=<n>GB` keeps at most that much cache, prunes the rest).
- [ ] **Step 4: Wire the docker builder** — in `docker-builder.ts` `runBuild`'s `finally` (after the tmpdir cleanup, `~line 232`), call `await pruneBuildCache(this.spawnFn, this.buildCacheCapGb).catch(()=>{})`. Add `buildCacheCapGb` to the builder's constructor opts (default 10). In `image-builder.ts`, read `Number(env.VALET_PREBUILD_BUILD_CACHE_GB ?? 10)` and pass it when constructing `DockerImageBuilder`.
- [ ] **Step 5: Makefile** — after the `docker build` line in `k8s-build`, `k8s-build-api`, and `k8s-build-fast`, add: `docker builder prune -f --keep-storage=$(VALET_BUILD_CACHE_GB)GB || true` with `VALET_BUILD_CACHE_GB ?= 10` near the other build vars. One comment line explaining why.
- [ ] **Step 6: Run** the test + `pnpm --filter @valet/api test -- prebuilds` + `pnpm typecheck`.
- [ ] **Step 7: Commit** `feat: bound moby build cache after docker bakes + make builds`

**PHASE 1 CHECKPOINT (the user's core ask):** on the docker backend (`make dev-local`) or by running `make k8s-build-fast` twice, confirm `docker system df` build-cache stays bounded (≈≤10GB) with no manual prune. This ships the disk-safety win standalone.

---

## Phase 2 — Bounded baked-image budget

### Task 2: `bakes.size_bytes` + record size at push

**Files:**
- Modify: `packages/api/migrations/pg/0000_app.sql` (bakes: `size_bytes BIGINT`), `packages/api/src/schema/index.ts` (bakes table + row type), `packages/store-postgres`/helpers only if a raw row mapper touches bakes (grep; bakes is app-side Drizzle so likely just schema)
- Create: `packages/api/src/prebuilds/bake-size.ts` + test
- Modify: `packages/api/src/bakes/source-service.ts` (record size on the pushed transition, before `applyRetention`)

**Interfaces (Produces):**
```ts
export function measureBakeSize(
  backend: string, imageRef: string,
  deps: { spawnFn: SpawnFn; fetchImpl: typeof fetch; registryInsecure: boolean; registryPushHost?: string },
): Promise<number | null>; // docker: `docker image inspect --format {{.Size}}`; k8s: sum registry manifest config+layer sizes; null on any failure
```

- [ ] **Step 1: Schema** — add `sizeBytes: bigint("size_bytes")` (nullable; funnel through `toNum` per the bigint-ms convention if the row interface needs a number) to the `bakes` Drizzle table + SQL. `rm -rf ~/.valet/pg`. Run `pnpm --filter @valet/store-postgres test` + api boot smoke. Record live DDL (`ALTER TABLE bakes ADD COLUMN size_bytes BIGINT;`) in the commit body.
- [ ] **Step 2: Write failing `bake-size.test.ts`** — docker branch: spawn `docker image inspect --format {{.Size}}` returns "12345" → 12345; k8s branch: fixture `fetch` returns a manifest `{config:{size:100},layers:[{size:200},{size:300}]}` → 600; failure (spawn error / non-2xx) → null.
- [ ] **Step 3: Implement** `measureBakeSize` (reuse `pushRefFor` + the registry host/insecure handling from `source-service.ts`'s retention helpers for the k8s manifest GET; docker uses inspect).
- [ ] **Step 4: Wire** — in `source-service.ts` where a bake flips to `pushed` (the `syncActiveBuilds` success branch, ~line 728, before `applyRetention`), call `const size = await measureBakeSize(...); if (size !== null) await db.update(bakes).set({sizeBytes: size}).where(eq(bakes.id, row.id))`. Best-effort.
- [ ] **Step 5: Run** api suite + typecheck.
- [ ] **Step 6: Commit** `feat: record bakes.size_bytes at push (docker inspect / registry manifest)`

### Task 3: Global size ceiling — `enforceCacheCeiling`

**Files:**
- Modify: `packages/api/src/bakes/source-service.ts` (new method + wire after `applyRetention`), `packages/api/src/providers/image-builder.ts` or the SourceService constructor wiring (read `VALET_PREBUILD_CACHE_BUDGET_GB`)
- Test: extend `packages/api/src/bakes/source-service.test.ts`

**Interfaces:**
- Consumes: Task 2 `bakes.size_bytes`; existing `this.retention(backend, imageRefs)`.
- Produces: `private enforceCacheCeiling(orgId: string, backend: string): Promise<void>`

Behavior (spec decision 3): load all `pushed` bakes for the org (join `image_sources` on `orgId`) with `sizeBytes`, oldest-first. Protected = each source's newest pushed bake id ∪ bakes whose id is an `agent_sessions.bake_id` with session status ∈ {active, hibernated}. `budget = VALET_PREBUILD_CACHE_BUDGET_GB * 1_000_000_000`. While `sum(sizeBytes ?? 0) > budget` and an unprotected bake remains: evict the oldest unprotected — `this.retention(backend, [ref])` (dedupe refs still referenced by a kept bake) + delete the `bakes` row + subtract its size. If only protected bakes remain over budget → `console.warn` once and stop. Never throws.

- [ ] **Step 1: Failing tests** (real PGlite, seed sources/bakes/sessions, fake `retention` recording calls): over-budget evicts oldest-first down to budget; a source's newest pushed bake is NEVER evicted even if oldest; a bake referenced by an active/hibernated session is NEVER evicted; all-protected-over-budget → warns, evicts nothing; under-budget → no retention calls; evicted rows are deleted; a ref shared by a kept bake is not deleted.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `enforceCacheCeiling`; wire `await this.enforceCacheCeiling(source.orgId, backend)` right after `applyRetention` in the pushed branch. Read the budget in the SourceService constructor (`Number(env.VALET_PREBUILD_CACHE_BUDGET_GB ?? 20)`).
- [ ] **Step 4: Run** the ceiling tests + full api suite + typecheck.
- [ ] **Step 5: Commit** `feat: global baked-image size ceiling with protected-bake guards`

**PHASE 2 CHECKPOINT:** seed bakes past a tiny budget in a test/dev deploy → oldest non-protected evicts, current + live-referenced survive.

---

## Phase 3 — k8s registry GC (deploy-only)

### Task 4: Fix the registry-gc CronJob so deletes reclaim

**Files:**
- Modify: `deploy/chart/valet/templates/registry-gc-cronjob.yaml`, `deploy/chart/valet/values.yaml` (if a flag is added), `deploy/README.md`
- Test: `make e2e E2E_ARGS="--only helm-golden"` golden + live cluster verify

- [ ] **Step 1: Diagnose live** — deploy, inspect a `registry-gc` pod's status/events/logs. Determine the failure: most likely the CronJob mounts the registry's RWO PVC already held by the running registry StatefulSet (multi-attach), and/or `registry garbage-collect` needs the registry in read-only mode to be safe, and/or wants `--delete-untagged`. Record the root cause in the task notes.
- [ ] **Step 2: Apply the fix** matching the cause. Likely shape: add `--delete-untagged=true` to the command; ensure the GC runs against the same storage safely (registry `config.yml` with `storage.delete.enabled: true`; if RWO multi-attach is the blocker, schedule GC on the same node as the registry via pod affinity, or run it as a `kubectl exec` into the registry pod instead of a separate PVC-mounting pod — pick per the diagnosis). Keep it best-effort (a failed GC never blocks anything).
- [ ] **Step 3: Verify live** — delete a tag (via the ceiling or manually), run the CronJob (`kubectl create job --from=cronjob/...`), confirm the pod completes 0 and blob bytes drop (`du` in the registry pod before/after).
- [ ] **Step 4: helm-golden** — update the CronJob golden; `make e2e E2E_ARGS="--only helm-golden"` green.
- [ ] **Step 5: Commit** `fix: registry-gc CronJob reclaims blobs (diagnosed <cause>)`

---

## Phase 4 — Docs + live validation

### Task 5: Docs + full dual-backend dogfood

**Files:**
- Modify: `deploy/README.md` (cache-management runbook: the two budgets, the api-image-eviction note), `docs/` (new short `.valet/prebuild.yaml` schema doc — the spec's Part 1 follow-up: fields `setup`/`image`/`skipDetect`, Dockerfile order, the skipDetect-for-toolchains pattern), `CLAUDE.md` (one line pointing at the prebuild cache knobs if the sandbox section warrants it)

- [ ] **Step 1:** Write the `.valet/prebuild.yaml` user doc (STE; the two ProofLabDev examples as reference) + the cache runbook note.
- [ ] **Step 2:** `make e2e` — clean scorecard (only named env-skips red).
- [ ] **Step 3: Live, docker backend** (`make dev-local`): run several bakes/iterations → `docker system df` build cache stays ≤ cap, no manual prune; drive image bakes past a small `VALET_PREBUILD_CACHE_BUDGET_GB` → oldest non-protected images `rmi`'d, current survives.
- [ ] **Step 4: Live, k8s backend**: same image-ceiling check + registry GC reclaims; confirm a full iteration session never hits DiskPressure.
- [ ] **Step 5: Commit** `docs: prebuild.yaml schema + cache-management runbook`

---

## Self-review notes

- Spec coverage: decision 1 → Task 1; decision 2 (floor) → existing `applyRetention` (unchanged, asserted in Task 3 tests); decision 3 (ceiling) → Tasks 2+3; decision 4 (size) → Task 2; decision 5 (registry GC) → Task 4; decision 6 (ephemeral BuildKit) → no change; decision 7 (api-image note) → Task 5. Part 1 docs follow-up → Task 5.
- Type consistency: `buildCachePruneArgs`/`pruneBuildCache`/`measureBakeSize`/`enforceCacheCeiling` signatures are used identically where referenced; `SpawnFn` is the docker-builder's existing type; `sizeBytes`/`size_bytes` naming consistent (Drizzle camel ↔ SQL snake).
- Ordering: Phase 1 is standalone and ships the priority first; Phases 2-4 layer on. Task 2 must land before Task 3 (ceiling needs `size_bytes`).
