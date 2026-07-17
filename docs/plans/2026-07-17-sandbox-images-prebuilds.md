# Sandbox Images v2 (Prebuilds) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/specs/2026-07-15-sandbox-images-v2-design.md`: an org image catalog, per-repo prebuild configs, the `ImageBuilder` port with docker + Kubernetes (BuildKit Job) implementations, the bundled-registry chart story, recipe auto-detection with `.valet/prebuild.yaml` override, session-create prebuild resolution, and freshness (fetch-on-start + conditional re-install).

**Architecture:** `ImageBuilder` is its own optional port (sibling of `SandboxProvider`, resolved per backend at boot; absent → UI reads "unavailable", everything cold-starts). The docker builder shells `docker build` (this repo's CLI-spawn convention — the spec's "dockerode" is corrected to match the codebase; NO new dependency). The k8s builder runs one `batch/v1` BuildKit Job per build, pushing to the chart's bundled `registry:2` (or an external registry). Recipes are lockfile-detected at build time against the cloned tree (clone via the GitHub/repo arc's `resolveGitHubToken(purpose:"git")` — BuildKit secret, never a layer). Session create resolves repo → newest `pushed` prebuild → `SandboxCreateOpts.image`; prep (the existing `prepareSandbox` flow) handles fetch-on-start + conditional re-install. A rebuild scheduler interval (EngineHost idle-sweep pattern) drives nightly rebuilds.

**Tech Stack:** TypeScript strict, Hono 4, Drizzle/Postgres, docker CLI via child_process, @kubernetes/client-node BatchV1Api, moby/buildkit:rootless, registry:2, vitest, Helm.

**Spec:** `docs/specs/2026-07-15-sandbox-images-v2-design.md` — Decisions (locked) binding; non-goals real (no devcontainer.json, no push webhooks, no multi-arch, no free-form refs for members, no per-user catalogs). The repo foundation (`docs/specs/2026-07-16-github-repo-integration-design.md`, complete) supplies: `session_repos` bindings, `RepoHost`/`resolveGitHubToken`, `prepareSandbox` prep, the repo picker.

## Global Constraints

- Node 22 for every command: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && <cmd>`. (`WebSocket is not defined` in tests = you're on Node 20.)
- **Engine contract touchpoint (Task 4) REQUIRES adversarial review (opus):** `SandboxCapabilities.customImage: boolean` (required field — all four providers stamp it; docker/k8s `true`, local/virtual `false`) and NOTHING else engine-side — `ImageBuilder` deliberately lives in `packages/api` (spec decision 2 keeps it off the `SandboxProvider` contract). Absent builder / `customImage: false` = byte-identical cold-start behavior, pinned.
- **Prebuilds are an optimization, never a correctness dependency** (spec decision 1): EVERY failure mode (no builder, build failed, registry down, image missing at pull) degrades to stock-image cold-start. Reviewers treat any hard dependency as Important.
- **The org GitHub credential is never baked into a layer** (spec decision 8): build-time clone tokens travel as BuildKit secrets (k8s) / ephemeral askpass outside the build context (docker); generated Dockerfiles and build logs are token-free (test-pinned).
- Pre-1.0 migrations: `0000_app.sql` in place + Drizzle; `rm -rf ~/.valet/pg`.
- Kubernetes context safety (BINDING): every cluster op pins `--context rancher-desktop`; cluster-gated tests skip cleanly.
- Builder concurrency default 1; Job `activeDeadlineSeconds` default 1800; retention = last 2 images per config; chart values follow the bundled-postgres toggle pattern.
- PGlite one per process; api vitest unit (env-scrubbed) + integration projects; only the 2 known `messages.abort` failures allowed. No `any`/casts/`@ts-ignore`. No Co-Authored-By. Root typecheck excludes `packages/web`.
- Admin gating via the shared `_org-admin.ts` helper (GitHub arc).

---

### Task 1: Schema + recipe engine (pure)

**Files:** Modify `packages/api/src/schema/index.ts` + `0000_app.sql` (tables `image_catalog`, `prebuild_configs`, `prebuilds`); Create `packages/api/src/prebuilds/recipe.ts` (+ `recipe.test.ts` with golden Dockerfiles).

**Interfaces (consumed by every later task):**
- `imageCatalog`: `{ id ("img_"+uuid), orgId, name, ref (full image ref), pullSecretName?, kind: "base", createdAt }` — admin-registered base images. `prebuildConfigs`: `{ id ("pbc_"+uuid), orgId, repoHost default 'github', repoFullName, cloneUrl, baseImageId? (null → stock sandbox image), schedule: "nightly" | "off" default 'nightly', enabled bool default true, createdAt, updatedAt }`, unique (orgId, repoHost, repoFullName). `prebuilds`: `{ id ("pb_"+uuid), configId, commitSha, imageRef, status: "queued"|"building"|"pushed"|"failed", builderBackend, recipe (jsonb — the RESOLVED recipe snapshot), error?, logTail?, startedAt?, finishedAt?, createdAt }`, index (configId, status, createdAt).
- Recipe engine (pure, no I/O — callers pass a file listing + file-content reader): `detectRecipe(files: string[], read: (p) => Promise<string|null>): Promise<RecipeStep[]>` — lockfile matrix per spec decision 6 (pnpm-lock/package-lock/yarn.lock → corresponding install; uv.lock/requirements.txt → uv/pip; Cargo.lock → cargo fetch; go.sum → go mod download; composable for monorepos — root-level locks only this pass, document); `loadPrebuildOverride(read)` parses `.valet/prebuild.yaml` `{ image?, setup?: string[], skipDetect?: bool }`; `generateDockerfile(opts: { baseImage, cloneUrl, commitSha, recipe: RecipeStep[] }): string` — deterministic (golden-file tested; cache identity = the (base, repo@sha, recipe) triple rendered into a label `valet.prebuild.identity`). The Dockerfile clones via `RUN --mount=type=secret,id=git-token git clone ...` using an askpass one-liner reading the secret mount — NO token in any layer or ARG (golden pins).

- [ ] Steps: failing tests (detection matrix incl. composed monorepo root, override precedence incl. skipDetect, Dockerfile goldens incl. token-free pin + determinism [two calls byte-identical]) → implement (+ `rm -rf ~/.valet/pg`) → `env -u OPENAI_API_KEY pnpm --filter @valet/api test && pnpm typecheck` → commit `feat(api): prebuild schema + pure recipe engine`.

---

### Task 2: `ImageBuilder` port + docker builder

**Files:** Create `packages/api/src/prebuilds/builder.ts` (port + registry), `packages/api/src/prebuilds/docker-builder.ts`, `packages/api/src/providers/image-builder.ts` (boot resolution: `VALET_IMAGE_BUILDER` env override, default paired with `VALET_SANDBOX_BACKEND` — docker→docker, kubernetes→kubernetes, local→none); Test `docker-builder.test.ts` (docker-gated live; pure arg-builder unit tests).

**Interfaces:**
- Port (spec decision 2 verbatim): `interface ImageBuilder { readonly backend: string; build(spec: PrebuildSpec): Promise<{ buildId: string }>; status(buildId): Promise<BuildStatus>; cancel?(buildId): Promise<void> }` with `PrebuildSpec = { configId, cloneUrl, commitSha?, baseImage, recipe, imageRef, gitToken?: string }`, `BuildStatus = { state: "queued"|"building"|"pushed"|"failed"; logTail?: string; error?: string }`. Absent builder at boot → `imageBuilder: null` everywhere (UI "unavailable", resolution skips).
- Docker impl: spawn `docker build` (this repo's CLI convention — extract a pure `buildDockerBuildArgs` helper) with the generated Dockerfile via stdin (`-f -`), tag `valet-prebuild/<repo-slug>:<sha>`, NO registry (daemon store is the store per spec decision 3); the git token via `--secret id=git-token,src=<tmpfile>` (0600 tmpfile, deleted in finally; BuildKit required — `DOCKER_BUILDKIT=1`); in-memory build registry (Map buildId→state+log ring buffer); concurrency cap 1 (queue). Live docker-gated test: build a trivial recipe (public tiny repo, no token) end-to-end → status pushed → `docker image inspect` sees the tag + identity label; failure case (bad base image) → failed with error text; token-file cleanup pinned.

- [ ] Steps: failing tests → implement → `env -u OPENAI_API_KEY pnpm --filter @valet/api test && pnpm typecheck` → commit `feat(api): ImageBuilder port + docker builder`.

---

### Task 3: Prebuild orchestration — service, routes, scheduler

**Files:** Create `packages/api/src/prebuilds/service.ts` (start/watch builds, retention), `packages/api/src/routes/prebuilds.ts` (+ catalog CRUD in `packages/api/src/routes/image-catalog.ts`), scheduler interval in the service (wired from main.ts like the idle sweep); Modify `app.ts`; Test route + service suites (fixture git via the recipe engine's injected reader — the service resolves the recipe by shallow-cloning to a temp dir using `resolveGitHubToken(purpose:"git")`... NO: builds clone INSIDE the builder; the service needs the repo tree only for recipe detection — decide: detection happens in-build? Spec decision 8 says "each build records the resolved recipe on its prebuilds row" and decision 6 "detection ... run against the cloned tree at build time". Implement: the SERVICE does a shallow metadata fetch (ls-remote for head sha + a tarball/contents fetch of lockfile paths via the GitHub API when host is github — cheap, no clone) to resolve the recipe BEFORE dispatching the build; document the deviation if you instead put detection inside the build container. PICK the GitHub-API contents approach: `GET /repos/{owner}/{repo}/contents/{path}` for the ~8 candidate lockfiles + .valet/prebuild.yaml at the head sha via the api-purpose token; record resolved recipe on the row; the generated Dockerfile then clones at that sha).
- Routes (admin-gated): catalog CRUD (`GET/POST/DELETE /api/org/image-catalog` — refs validated non-empty; pullSecretName k8s-only field); configs (`GET/POST/PATCH/DELETE /api/org/prebuilds/configs`, unique-repo 409, `POST /:id/rebuild` → start build [409 when builder absent with "unavailable on this deployment"], `GET /:id/builds` history w/ status+logTail). Build lifecycle: queued row → builder.build → poll status (service interval, 10s) → update row (building/pushed/failed + finishedAt + logTail) → on pushed: retention (delete registry tags/images beyond newest 2 per config — docker: `docker rmi`; k8s: registry API DELETE — Task 5 fills the k8s half; keep a `retention(builderBackend)` seam).
- Scheduler: one 10-min interval (unref, main.ts-wired, cleared on shutdown): for each enabled config with `schedule: "nightly"`, if newest build older than 24h AND head sha (ls-remote via token service... use the GitHub API `GET /repos/.../commits/{defaultBranch}` head) differs from newest pushed build's sha → start a rebuild. Concurrency respected via the builder's own cap.

- [ ] Steps: failing tests (fixture github contents endpoints added to the shared fixture; lifecycle happy/fail; rebuild 409-no-builder; retention keeps exactly 2; scheduler triggers on age+sha-drift, skips fresh/off/disabled; no token in rows/logs) → implement → gate → commit `feat(api): prebuild orchestration — service, routes, nightly scheduler`.

---

### Task 4: Engine capability + session-create resolution + fetch-on-start [ADVERSARIAL REVIEW REQUIRED — engine field]

**Files:** Modify `packages/engine/src/types.ts` (`SandboxCapabilities.customImage`) + the four providers' `capabilities()`; Modify `packages/api/src/engine/session-meta.ts` + `host.ts` (image resolution into the sandbox literal), `packages/api/src/engine/workspace-prep.ts` (prebuilt-image prep variant); Test engine pin + api resolution + prep suites.

**Interfaces:**
- Engine: `customImage: boolean` REQUIRED on `SandboxCapabilities` (docker/k8s true, local/virtual false) — mechanical, byte-identical otherwise (full suites pin).
- Resolution (spec decision 8): `loadSessionMeta` (or a sibling `resolvePrebuildImage(db, meta)` called from buildSession) — when the session's PRIMARY binding matches an enabled config with a newest `pushed` prebuild AND `sandboxProvider.capabilities().customImage` → `SandboxCreateOpts.image = prebuild.imageRef` + record `prebuildId` on the session row (new nullable column `agent_sessions.prebuild_id`, 0000-in-place) — else stock image (byte-identical pin incl. customImage:false provider ignoring catalog refs). NEVER fail session create on resolution errors (log + cold-start).
- Fetch-on-start (spec decision 7): `workspace-prep.ts` — when the session runs a prebuilt image, the workspace ALREADY contains the baked repo at commit X (the image bakes it into the workspace path? NO — the image bakes the repo into an image path e.g. `/prebuilt/<repo>`; the k8s workspace is a fresh PVC. DESIGN DECISION [disclose in report]: prep on a prebuilt image copies/clones from the baked in-image repo (`git clone /prebuilt/<repo> <workspace>` — local objects, fast) then `git fetch origin` + checkout target ref via the credential helper, then lockfile-diff (baked sha vs head) → matching installs re-run (`detectRecipe` names the commands; run only those whose lockfile changed; the baked node_modules etc. live in the in-image clone and are copied over — verify sizes/cost, document) — else skip. Cold path (no prebuild) unchanged (byte-identical pin).

- [ ] Steps: failing tests (engine field pin; resolution matrix [pushed/none/failed/builder-absent/capability-false/disabled-config]; prebuilt-prep: local-clone+fetch+conditional-reinstall sequences on the recording sandbox; cold path unchanged) → implement → `pnpm --filter @valet/engine test && pnpm --filter @valet/sandbox-docker test && FORCE_COLOR=0 pnpm --filter @valet/sandbox-local test && pnpm --filter @valet/sandbox-kubernetes test && env -u OPENAI_API_KEY pnpm --filter @valet/api test && pnpm typecheck` → commit `feat(api): prebuild resolution at session create + fetch-on-start prep`.

---

### Task 5: Kubernetes builder + bundled registry chart

**Files:** Create `packages/api/src/prebuilds/k8s-builder.ts` + a `SandboxBatchJobsApi` adapter in `packages/sandbox-kubernetes` (exported — follow the narrow-adapter pattern; the api consumes it via the existing provider deps seam or a parallel construction — read how the k8s provider's deps are built in `providers/sandbox-backend.ts` and mirror); Modify `deploy/chart/valet/`: `registry-statefulset.yaml` + `registry-service.yaml` (bundled-postgres pattern; ClusterIP, plain HTTP), values (`registry.bundled` toggle + `externalRegistry.{url,pullSecret}`, build resources/concurrency/deadline), `rbac.yaml` (`batch/jobs` create/get/list/watch/delete + the golden assertion), registry GC CronJob template; Test: chart goldens; k8s-builder unit (fake jobs api) + cluster-gated live build.

**Interfaces:**
- K8s builder: one `batch/v1` Job per build (name `valet-prebuild-<id>`, `moby/buildkit:rootless`, the generated Dockerfile via a ConfigMap or stdin-config volume, git token as a per-build Secret mounted as BuildKit secret [deleted with the Job], push `--output type=image,name=<registry>/<repo-slug>:<sha>,push=true,registry.insecure=true` for the bundled registry); `status()` from Job conditions + pod logs tail (pods/log RBAC exists); `cancel` = delete Job; `activeDeadlineSeconds` from values; images pulled by sandbox pods via full registry path + IfNotPresent (the manifest builder already takes arbitrary image refs — verify nothing blocks a registry-host ref).
- Registry: `registry:2` StatefulSet gated `registry.bundled && !externalRegistry.url` (postgres pattern), PVC via default SC, ClusterIP service `valet-registry:5000`; retention deletes via the registry HTTP API (digest DELETE) + a GC CronJob (`registry garbage-collect`, schedule from values); external registry → pushes/pulls use `externalRegistry.url` + pullSecret on sandbox pods (thread `imagePullSecrets` through the sandbox manifest when configured — check the CRD podTemplate supports it; disclose if not).

- [ ] Steps: failing chart goldens (registry on/off, RBAC batch/jobs on the right rule, resources/deadline values, no-secret-in-Job-env assertion) + k8s-builder unit tests (fake jobs api: manifest shape incl. secret mount + deadline; status mapping; cancel) → implement → cluster-gated live: build a tiny public repo through a real Job into the bundled registry on rancher-desktop (deploy the registry via helm upgrade first — coordinate with the coordinator if the live env needs it; skip-clean without cluster) → `pnpm --filter @valet/sandbox-kubernetes test && env -u OPENAI_API_KEY pnpm --filter @valet/api test && bash deploy/chart/valet/test/golden.sh && pnpm typecheck` → commit `feat(k8s): BuildKit Job builder + bundled registry chart`.

---

### Task 6: Web — Sandbox images settings + picker badge

**Files:** Create `packages/web/src/routes/settings.organization.sandbox-images.tsx` + `components/settings/prebuilds-section.tsx` (+ catalog section); Modify `settings-rail.tsx` (+ Sandbox images), `new-session-dialog.tsx` (prebuild badge); hooks; Tests.

**Interfaces:** catalog CRUD list; per-repo config cards (repo picker reuse from the session dialog's `useRepos`, base-image select from catalog, schedule toggle nightly/off, enabled, Rebuild now, build history table w/ status chips + expandable logTail, builder-absent banner "unavailable on this deployment" from a `GET /api/org/prebuilds/meta` `{ builder: string | null }`); session dialog: when the selected repo's config has a newest pushed prebuild, show the spec's badge `prebuilt · repo@<short-sha> · built <ago>` (extend `GET /api/repos` or a lightweight `GET /api/prebuilds/for-repo?fullName=` — pick, disclose).

- [ ] Steps: failing component tests (states incl. builder-absent, rebuild fires, badge appears/absent) → implement → `cd packages/web && pnpm test && pnpm typecheck` → commit `feat(web): sandbox images settings + prebuilt badge`.

---

### Task 7: E2E + docs + dogfood

**Files:** e2e fixture suite (api loop: catalog→config→build[docker builder against real daemon, tiny repo]→resolution→session boots from prebuilt image→fetch-on-start); docs (spec Status → Implemented + Deviations [dockerode→CLI correction, recipe-detection-via-contents-API, in-image repo staging path, whatever else emerged], handoff queue row #4, CLAUDE.md gotchas judged); full battery; live k8s dogfood per the spec's exit criteria (coordinator-driven: bundled registry deployed, big-repo first-session-cold + second-session-prebuilt timing, kill-Job recovery, retention 2-of-3, lockfile-change re-install, `make dev-local` docker variant).

- [ ] Steps: e2e → battery (`pnpm typecheck && pnpm --filter @valet/engine test && pnpm --filter @valet/store-postgres test && env -u OPENAI_API_KEY pnpm --filter @valet/api test && cd packages/web && pnpm typecheck && pnpm test`; only the 2 known failures) → docs → commit `docs(specs): sandbox images v2 implemented` → coordinator dogfood recorded in the ledger.

---

## Self-review notes (already applied)

- **Spec coverage:** decision 1 → T4 (resolution + degrade) + T6 (badge/catalog UX); 2 → T2 (port; `customImage` in T4); 3 → T2; 4 → T5; 5 → T5; 6 → T1; 7 → T4 (fetch-on-start) + T3 (rebuild triggers); 8 → T1/T3/T4 (tables, recipe snapshot, session prebuild_id, BuildKit-secret clone); 9 → T6; 10 → moot (warm pools out of MVP per user; auth-gateway profile services live in base images — prebuild Dockerfiles `FROM` catalog/stock bases and inherit them, note in T1's generator docs). Exit criteria → T7.
- **Spec corrections this plan makes (record as deviations in T7):** "via dockerode" → docker CLI spawn (repo convention, no dockerode dependency exists); recipe detection at build time → resolved by the service via the GitHub contents API at head sha before dispatch (recorded on the row; the build clones at that sha) — same reproducibility, cheaper than an extra clone; the baked repo lives at an in-image path and prep stages it into the fresh workspace (the spec's wording implied the image workspace IS the repo — k8s PVC workspaces make that impossible).
- **Known softness (flagged):** in-image→workspace staging cost for huge repos (T4 discloses measurements from the docker-gated test); BuildKit secret support in the k8s rootless image (T5 verifies flags against the pinned buildkit version); CRD podTemplate imagePullSecrets support (T5 verifies; disclose if the CRD lacks it → bundled-registry-only until upstream).
- **Type consistency:** `PrebuildSpec`/`BuildStatus` (T2) consumed by T3/T5; `RecipeStep` (T1) by T2/T3/T4; `prebuild_id` on sessions (T4) read by T6's badge via the api.
