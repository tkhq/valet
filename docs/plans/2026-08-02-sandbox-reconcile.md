# Sandbox Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sandboxes converge transparently to current platform state (images, prep, bakes) with zero buttons; prebuilds unify into an ImageSource → Bake chain with an org base image and zero-config repo sources.

**Architecture:** A pure `computeSpec(snapshot)` produces the desired `{image, steps}`; the engine attachment reconciles observed state (read from `/etc/valet/applied.json` inside the sandbox) against it at run-start windows — in-place step re-runs for prep drift, release+create pod replacement for image drift. Credentials move to a live-updatable mount (k8s Secret volume / docker bind dir) rotated by an hourly sweep. Spec: `docs/specs/2026-08-02-sandbox-reconcile-design.md` (16 locked decisions — read it first).

**Tech Stack:** TypeScript, Hono, Drizzle/PGlite, vitest, React 19 + TanStack Query, agent-sandbox CRD v0.5.1 (vendored), BuildKit.

## Global Constraints

- Pre-1.0: edit `packages/api/migrations/pg/0000_app.sql` + Drizzle schema in place; NO numbered migrations; after schema edits `rm -rf ~/.valet/pg` locally and manual DDL on the live cluster.
- No `any`, no `as unknown as T`, no `@ts-ignore` (CLAUDE.md type rules).
- All prose (comments, errors, UI copy) follows ASD-STE100 per CLAUDE.md; user-facing errors name the corrective action.
- Kubernetes commands ALWAYS pin `--context rancher-desktop` (make targets do this).
- Workspace survival is the replacement invariant: k8s uses `release()` + `create()` and never `destroy()` (PVC cascade); docker may `destroy()` + `create()` (bind mount survives).
- Every task: `pnpm typecheck` green before commit; commit subjects ≤72 chars.
- Final validation is `make e2e` with a clean scorecard + UI walkthrough on the local k8s deploy.

---

## Phase 1 — Spec extraction (pure, no behavior change)

### Task 1: `sandbox-spec.ts` — StepSpec/SandboxSpec types, computeSpec, specHash

**Files:**
- Create: `packages/api/src/engine/sandbox-spec.ts`
- Test: `packages/api/src/engine/sandbox-spec.test.ts`

**Interfaces (Produces — later tasks depend on these EXACT shapes):**
```ts
export const PREP_VERSION = 1;
export interface ResolveSnapshot {
  apiUrl: string;                 // sandboxApiUrl — embedded in shim scripts
  stockImage: string;             // resolveDefaultImage(env) result
  repoBake: { imageRef: string; bakedSha: string; recipe: RecipeStep[]; bakeId: string } | null;
  baseBakeRef: string | null;     // org base bake image ref (null until phase 4)
  repos: RepoBinding[];           // position order, with targetDir (Task 14)
  userName?: string;
  userEmail?: string;
}
export interface StepSpec { id: string; hash: string; critical: boolean }
export interface SandboxSpec { image: string; steps: StepSpec[] }
export function computeSpec(snap: ResolveSnapshot): SandboxSpec;
export function specHash(spec: SandboxSpec): string;   // sha256 hex over canonical JSON
```

Resolution order inside `computeSpec`: `repoBake?.imageRef ?? baseBakeRef ?? stockImage`. Steps, in order:
1. `{ id: "credential-scripts", hash: sha256(gitCredentialHelperScript(apiUrl) + ghWrapperScript(apiUrl) + PREP_VERSION), critical: false }`
2. `{ id: "git-identity", hash: sha256(`${userName ?? ""}|${userEmail ?? ""}|${PREP_VERSION}`), critical: false }`
3. Per binding: `{ id: `clone:${fullName}`, hash: sha256(`${fullName}|${cloneUrl}|${ref ?? ""}|${auth}|${targetDir}|${PREP_VERSION}`), critical: true }` — hash covers CONFIGURATION only, never head SHA (spec decision 2).

- [ ] **Step 1: Write failing golden tests** — determinism (same snapshot → identical `specHash` twice); image resolution order (repoBake > baseBakeRef > stockImage, with a fixed golden hash string per case); hash sensitivity matrix (changing apiUrl changes only `credential-scripts` hash; changing a binding's ref changes only its clone step; changing `userEmail` changes only `git-identity`); world-state exclusion (two snapshots differing only in `repoBake.bakedSha` → identical step hashes, different image only if imageRef differs).
- [ ] **Step 2: Run** `pnpm --filter @valet/api exec vitest run src/engine/sandbox-spec.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `sandbox-spec.ts` with `node:crypto.createHash("sha256")`; canonical JSON = `JSON.stringify` over explicitly ordered fields (never object spread — key order must be pinned).
- [ ] **Step 4: Run tests → PASS; `pnpm typecheck`.**
- [ ] **Step 5: Commit** `feat: pure SandboxSpec computation with hash goldens`

### Task 2: `resolveSnapshot` — the thin impure gatherer

**Files:**
- Create: `packages/api/src/engine/resolve-snapshot.ts`
- Test: `packages/api/src/engine/resolve-snapshot.test.ts` (real PGlite via existing test helpers, no mocks)

**Interfaces:**
- Consumes: `resolvePrebuildImage(db, meta, provider, preflight)` (existing, `prebuilds/resolve.ts`), `SessionMeta`.
- Produces: `resolveSnapshot(deps: { db?: AppDb; provider: SandboxProvider; meta: SessionMeta; apiUrl: string; stockImage: string; preflight?: PrebuildPreflightOpts }): Promise<ResolveSnapshot>`

- [ ] Step 1: Failing test — with no prebuild rows, snapshot carries `repoBake: null`, `baseBakeRef: null`, given stock/apiUrl verbatim; with a seeded pushed prebuild for the bound repo, `repoBake.imageRef` matches.
- [ ] Step 2: Implement (wraps `resolvePrebuildImage`; `baseBakeRef` hardcoded `null` with a `// phase 4` note pointing at Task 16).
- [ ] Step 3: Tests PASS; typecheck; commit `feat: resolveSnapshot gathers spec inputs`.

---

## Phase 2 — PrepPlan in the engine

### Task 3: Engine types — PrepStep, DesiredSandboxSpec, SpecProvider

**Files:**
- Modify: `packages/engine/src/types.ts` (CreateSessionOptions/RestoreSessionOptions: REMOVE `prepareSandbox`, ADD `specProvider`)
- Modify: `packages/engine/src/engine.ts:26-99` (`materializeSandbox` threading)

**Interfaces (Produces):**
```ts
export interface PrepStep { id: string; hash: string; critical: boolean; apply(sandbox: Sandbox): Promise<void> }
export interface DesiredSandboxSpec { image?: string; specHash: string; steps: PrepStep[] }
export type SpecProvider = () => Promise<DesiredSandboxSpec>;
// CreateSessionOptions.specProvider?: SpecProvider   (replaces prepareSandbox)
```
Clean cut, pre-1.0: delete `PrepareSandbox` from `attachment.ts:16`, update `packages/engine/test/prepare-sandbox.test.ts` fixtures to specProvider shape (their assertions carry over: runs before waiters, failure → `SandboxPreparationError` + destroy, re-provision re-runs).

- [ ] Step 1: Update types + engine.ts + attachment constructor signature (`specProvider?: SpecProvider` instead of `prepare?`); fix all compile errors in engine (`pnpm --filter @valet/engine exec tsc --noEmit` drives the worklist — api callers break until Task 6; that is expected mid-phase, keep commits engine-scoped and run engine-filtered checks only).
- [ ] Step 2: Port prepare-sandbox.test.ts to a single-step specProvider; suite green: `pnpm --filter @valet/engine test`.
- [ ] Step 3: Commit `feat!: engine SpecProvider replaces prepareSandbox closure`.

### Task 4: Applied state + plan runner

**Files:**
- Create: `packages/engine/src/sandbox/applied-state.ts`
- Test: `packages/engine/test/applied-state.test.ts` (virtual sandbox)

**Interfaces (Produces):**
```ts
export const APPLIED_PATH = "/etc/valet/applied.json";
export interface AppliedState { image: string; specHash: string; steps: Record<string, string> }
export function readAppliedState(sandbox: Sandbox): Promise<AppliedState | null>;  // null on missing/corrupt
export function diffSteps(desired: PrepStep[], applied: AppliedState | null): PrepStep[];
export function applyPlan(sandbox: Sandbox, desired: DesiredSandboxSpec, image: string, applied: AppliedState | null): Promise<void>;
```
`applyPlan` runs `diffSteps` output in order; after EACH successful step it rewrites the full applied file (`{ image, specHash, steps: {...prior, [step.id]: step.hash} }` — mkdir -p /etc/valet via exec first). Non-critical failure: log via `console.error`, continue to next step. Critical failure: throw (caller maps to `SandboxPreparationError`). Corrupt JSON reads as `null` → full re-apply (spec decision 3).

- [ ] Step 1: Failing tests — full apply on null applied; subset re-run when one hash drifts; per-step applied persistence (kill after step 2 of 3 → applied has steps 1-2); critical throw stops plan, applied keeps successes; corrupt file → all steps.
- [ ] Step 2: Implement; engine suite green; commit `feat: applied-state file + convergent plan runner`.

### Task 5: `attachment.reconcile()` — observe/diff/converge

**Files:**
- Modify: `packages/engine/src/sandbox/attachment.ts` (doProvisionInner prep block lines ~460-481; new public method)
- Test: `packages/engine/test/attachment-reconcile.test.ts`

**Interfaces (Produces):**
```ts
// on SandboxAttachment:
reconcile(): Promise<void>;           // caller gates idleness; single-flight; no-op unless state === "ready"
observedImage(): string | null;       // from cache/applied file — for tests + metrics
```
Behavior (spec decisions 3-7):
- Provision path: `doProvisionInner` calls `specProvider()`; `provider.create({...createOpts, image: desired.image ?? createOpts.image, ...})`; then `applyPlan` with `applied: null`; caches `{applied, at}` in memory.
- `reconcile()`: single-flight (`if (this.reconciling) return this.reconciling`). Not `ready` → return. Fetch desired. Observe: use cached applied unless cache older than `OBSERVE_TTL_MS = 5 * 60_000` or epoch changed since read → `readAppliedState` (also refreshes cache). Image differs → **replace**: backoff check first (`this.convergeFailure` `{specHash, at}` — skip if same hash failed < `min(30min, 2^n * 1min)` ago); epoch++, null sandbox, `provider.release?.() ?? provider.destroy()` on old handle (docker path: destroy is workspace-safe), `kickProvision` with the desired image threaded into createOpts (persist: `this.createOpts = {...this.createOpts, image: desired.image}` — observed image source of truth, spec decision 9). Steps-only diff → `applyPlan` in place. Success clears `convergeFailure`.
- Suspended + stale (wake folding): `ensureReady` resume path consults a cheap pre-check — if `specProvider` desired image ≠ cached applied image, skip `doResume`, go straight to fresh provision (same epoch rules as replace).

- [ ] Step 1: Failing tests (virtual provider + fake specProvider you mutate between calls): image drift → new epoch + provider.create called with new image + steps re-applied; step-hash drift → same epoch, only drifted step re-applied; no drift → zero provider/exec calls (fast-path); concurrent `reconcile()` calls → one execution (count specProvider invocations); replace failure → state degrades per existing reportFailure semantics, second reconcile within backoff window is a no-op, after backoff expiry retries; suspended+stale wake provisions fresh (provider.resume NOT called).
- [ ] Step 2: Implement; run full engine suite (attachment/suspend/prepare pins must stay green).
- [ ] Step 3: Commit `feat: attachment reconcile — in-place prep convergence + image replacement`.

### Task 6: Host builds the SpecProvider (api side)

**Files:**
- Create: `packages/api/src/engine/prep-steps.ts` (StepSpec → PrepStep pairing)
- Modify: `packages/api/src/engine/host.ts` (buildPrepareSandbox → buildSpecProvider; both create+restore paths)
- Modify: `packages/api/src/engine/workspace-prep.ts` (export step-shaped wrappers: `credentialScriptsStep(apiUrl)`, `gitIdentityStep(name,email)`, `cloneStep(binding, targetDir, prebuild?)` — bodies are the EXISTING functions `installCredentialHelper`/`configureGitIdentity`/`prepBinding`/`prepPrebuiltBinding` unchanged)
- Test: `packages/api/src/engine/host.spec-provider.test.ts`

**Interfaces:**
- Consumes: Task 1 `computeSpec`/`specHash`, Task 2 `resolveSnapshot`, Task 3 `SpecProvider`.
- Produces: `buildSpecProvider(hostDeps, meta): SpecProvider | undefined` — undefined when `capabilities().isolated !== true` (spec decision 8). The provider closure re-runs `resolveSnapshot` + `computeSpec` on every call (that is the lazy-staleness read) and pairs each StepSpec with its apply via `prep-steps.ts`.

- [ ] Step 1: Failing tests — unbound session on isolated provider gets specProvider with exactly [credential-scripts, git-identity]; repo session appends clone steps in position order; non-isolated → undefined; two invocations after seeding a newer pushed prebuild return different image + identical step hashes.
- [ ] Step 2: Implement; delete `buildWorkspacePrep`/`buildCredentialOnlyPrep` call sites in host.ts (keep exported step bodies); fix api compile; run `pnpm --filter @valet/api test -- engine` + workspace-prep suite.
- [ ] Step 3: Commit `feat: host SpecProvider — computeSpec wired into session build`.

### Task 7: Pre-run window in the thread loop

**Files:**
- Modify: `packages/engine/src/thread.ts` (insert at line ~1277, before `await this.runItem(claimed)`)
- Modify: `packages/engine/src/session.ts` (add `hasOtherActiveRuns(excludeThreadId): boolean` over thread registry)
- Modify: `packages/engine/src/sandbox/policy.ts` (PolicySandbox tracks vended-not-terminal execJob handles: `pendingJobCount(): number`)
- Test: `packages/engine/test/pre-run-reconcile.test.ts`

Window logic (spec decision 4): `if (!session.hasOtherActiveRuns(this.threadId) && policySandbox.pendingJobCount() === 0) await attachment.reconcile().catch(log)` — awaited so replacement finishes before the turn's first tool call; errors degrade to running stale, never fail the turn. Mid-run `ensureReady` untouched (pure fast-path by construction — reconcile is only ever called here).

- [ ] Step 1: Failing tests — reconcile called exactly once per run start when idle; NOT called when a second thread has `runningItem`; NOT called with a pending exec job; reconcile rejection does not fail the run.
- [ ] Step 2: Implement; engine suite + `pnpm --filter @valet/api test` (integration suites exercise the loop); commit `feat: run-start reconcile window`.

**PHASE 2 CHECKPOINT:** deploy to k8s (`make k8s-build-fast` — CHECK exit 0 — + rollout restart), edit a shim comment, redeploy, send a prompt in the UI: pod NOT replaced, `kubectl exec ... cat /etc/valet/applied.json` shows new credential-scripts hash, new shim text present. This is exit criterion 1 and ships standalone value.

---

## Phase 3 — Replacement mechanics + creds mount

### Task 8: k8s provider — create() rolls the pod on image drift

**Files:**
- Modify: `packages/sandbox-kubernetes/src/provider.ts` (create path), `src/lifecycle.ts` (pod lookup/delete helper exists for conformance recreate — reuse)
- Test: `packages/sandbox-kubernetes/test/conformance.cluster.test.ts` (extend, cluster-gated)

Verified behavior (exploration): CR spec replace does NOT roll the pod; pod deletion under the retained CR is the blessed recreate path. So after `applySandbox`, `create()` reads the live pod; if `pod.spec.containers[0].image !== manifest image`, delete the pod and wait for the controller's fresh one (same readiness wait as today).

- [ ] Step 1: Cluster-gated failing test — create sandbox with image A, write `/workspace/keep.txt` AND `/root/lose.txt`; `release()`; `create()` with image B; assert new pod runs B, `keep.txt` survives, `lose.txt` gone.
- [ ] Step 2: Implement; run `pnpm --filter @valet/sandbox-kubernetes test` (non-cluster suites) + the cluster suite against rancher-desktop; commit `feat: k8s create() converges live pod image to manifest`.

### Task 9: Creds mount — port + k8s Secret volume

**Files:**
- Modify: `packages/engine/src/types.ts` (SandboxCreateOpts.`credsFiles?: Record<string,string>`; `SandboxProvider.updateCreds?(id: string, files: Record<string,string>): Promise<void>`; `SandboxCapabilities.credsMount?: boolean`)
- Modify: `packages/sandbox-kubernetes/src/manifest.ts:98-173` (Secret volume `valet-creds-<name>` mounted at `/etc/valet/creds`), `provider.ts` (create: upsert Secret BEFORE applySandbox; updateCreds: PATCH Secret data; destroy: delete Secret; capabilities `credsMount: true`), `src/lifecycle.ts` (Secret helpers via existing CoreV1 client)
- Modify: `deploy/chart/valet/templates/` RBAC — confirm secrets create/patch/delete in the sandbox namespace (BuildKit git-token Secrets already need create/delete; add patch if absent)
- Test: manifest golden update + cluster-gated propagation test

- [ ] Step 1: Manifest unit test — with credsFiles, podTemplate gains the secret volume + mount (golden); without, byte-identical to today.
- [ ] Step 2: Cluster-gated — create with `credsFiles: {token: "a"}`; `updateCreds(id, {token: "b"})`; poll `cat /etc/valet/creds/token` inside the pod until "b" (timeout 120s — kubelet sync). 
- [ ] Step 3: Implement + chart change; commit `feat: k8s creds mount — live-updatable per-sandbox Secret`.

### Task 10: Creds mount — docker/local

**Files:**
- Modify: `packages/sandbox-docker/src/sandbox.ts` (`buildDockerRunArgs` adds `-v <credsHostDir>:/etc/valet/creds:ro` when credsFiles set; create() writes files to `~/.valet/creds/<sandboxId>/` first; updateCreds rewrites them; destroy removes the dir; capabilities `credsMount: true`)
- Test: `packages/sandbox-docker/test/docker-sandbox.test.ts` (docker-gated: updateCreds visible in-container immediately)

- [ ] Step 1: Failing docker-gated test; Step 2: implement; Step 3: run docker suite; commit `feat: docker creds mount via host bind dir`.

### Task 11: Shims read the creds file first

**Files:**
- Modify: `packages/api/src/engine/git-credential-helper.ts` (both scripts: `token=$(cat /etc/valet/creds/token 2>/dev/null); [ -n "$token" ] || token=${VALET_SANDBOX_TOKEN:-}` — then use `$token` in the header)
- Modify: `packages/api/src/engine/git-credential-helper.test.ts` (goldens + a pin: creds path read BEFORE env fallback)
- Note: changing script text changes the `credential-scripts` step hash → deployed sandboxes converge in place at next prompt. That is the mechanism working as designed; say so in the commit body.

- [ ] Steps: golden update → implement → suite green → commit `feat: shims read creds mount, env fallback`.

### Task 12: Host wiring + rotate sweep

**Files:**
- Modify: `packages/api/src/engine/host.ts` (mintSandboxEnv: also thread `credsFiles: { token }` into CreateSessionOptions.sandbox; keep env var for fallback; record `{sessionId → mintedAt}`)
- Create: `packages/api/src/engine/rotate-sweep.ts` — hourly `setInterval().unref()` started next to prebuildService.start(): for each engine-cached session whose attachment is ready/suspended and `capabilities().credsMount` and mintedAt > 12h: `mintSandboxToken` (verify-don't-revoke path, additive) + `provider.updateCreds(sandboxId, {token})` + update mintedAt. Errors per-session logged, isolated.
- Test: `packages/api/src/engine/rotate-sweep.test.ts` (fake clock, fake provider — assert re-mint at >12h only, updateCreds payload, per-session error isolation)

- [ ] Steps: failing tests → implement → api suite → commit `feat: hourly sandbox-token rotation through creds mount`.

**PHASE 3 CHECKPOINT (exit criteria 2, 3, 4):** on k8s: push a NEW stock image tag → next UI prompt replaces pod, `/workspace` file survives; `kubectl delete pod <sandbox-pod>` → next prompt re-applies all steps, no replacement, restarted pod holds the current Secret token; fake a 13h-old mint (shrink interval via env in a dev deploy) → token file rotates with zero pod events.

---

## Phase 4 — Generation unification (sources + bakes)

### Task 13: Schema restructure

**Files:**
- Modify: `packages/api/migrations/pg/0000_app.sql`, `packages/api/src/schema/index.ts`

DDL (replaces `image_catalog`, `prebuild_configs`, `prebuilds` — DROPPED, not migrated, spec decision 11):
```sql
CREATE TABLE image_sources (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('external','base','repo')),
  parent_id TEXT REFERENCES image_sources(id),
  name TEXT NOT NULL,
  external_ref TEXT, pull_secret_name TEXT,          -- kind=external
  setup_commands JSONB,                               -- kind=base
  repo_host TEXT, repo_full_name TEXT, clone_url TEXT,-- kind=repo
  schedule TEXT NOT NULL DEFAULT 'nightly' CHECK (schedule IN ('nightly','off')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_bound_at BIGINT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX image_sources_org_repo ON image_sources(org_id, repo_host, repo_full_name) WHERE kind = 'repo';
CREATE UNIQUE INDEX image_sources_org_base ON image_sources(org_id) WHERE kind = 'base';
CREATE TABLE bakes (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES image_sources(id) ON DELETE CASCADE,
  identity_hash TEXT NOT NULL, commit_sha TEXT, image_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','building','pushed','failed')),
  builder_backend TEXT, recipe JSONB, error TEXT, log_tail TEXT,
  started_at BIGINT, finished_at BIGINT, created_at BIGINT NOT NULL
);
CREATE INDEX bakes_source_status_created ON bakes(source_id, status, created_at);
ALTER TABLE agent_sessions RENAME COLUMN prebuild_id TO bake_id;  -- historical observability only
ALTER TABLE session_repos ADD COLUMN target_dir TEXT;             -- Task 14
```
- [ ] Steps: edit SQL + Drizzle schema → `rm -rf ~/.valet/pg` → `pnpm --filter @valet/store-postgres test` + api boot smoke → commit `feat!: image_sources + bakes replace prebuild tables`. Record the live-cluster DDL block in the commit body.

### Task 14: Uniform subdir clone layout (spec decision 15)

**Files:**
- Modify: `packages/api/src/engine/workspace-prep.ts:140-151` (`computeTargetDirs`: DELETE the single-repo `["."]` case — always `<repo>/` with existing collision disambiguation)
- Modify: session-create path (`packages/api/src/routes/sessions.ts` where `session_repos` rows insert): persist `targetDir` computed at bind time; `loadSessionMeta` reads it; `RepoBinding` gains `targetDir: string`.
- Modify: `packages/api/src/engine/workspace-prep.test.ts` layout pins; `resolveStartRef` callers pass `dirs[0]` (already do).

Sessions created BEFORE this change have `target_dir NULL` → meta loader falls back to the OLD layout rule (single→`.`) so convergence never relocates an existing clone (spec decision 15). New sessions always persist explicit subdirs.

- [ ] Steps: failing layout tests (new session single repo → `widgets/`; legacy NULL row → `.`) → implement → api suite → commit `feat: uniform subdir clone layout; target_dir persisted per binding`.

### Task 15: SourceService — CRUD, bake-or-skip nightly, decay, zero-config

**Files:**
- Create: `packages/api/src/bakes/source-service.ts` (port `prebuilds/service.ts` internals: builder dispatch, poll sync, retention, orphan sweep — same ImageBuilder port, unchanged)
- Delete: `packages/api/src/prebuilds/service.ts` (after parity)
- Test: `packages/api/src/bakes/source-service.test.ts`

**Interfaces (Produces):**
```ts
class SourceService {
  identityHash(source: SourceRow, parentIdentity: string | null): string; // base: sha256(parent|commands); repo: sha256(parent|repo|recipeHash)
  startBake(sourceId: string): Promise<BakeRow>;
  runSchedulerPass(): Promise<void>;   // walk sources PARENT-FIRST (spec decision 14); per source: skip when identityHash AND head sha match newest pushed bake; decay: skip+disable when kind=repo AND no live session binds the repo AND last_bound_at > 30d
  ensureRepoSource(orgId, repo): Promise<void>; // zero-config (spec decision 13): upsert + touch last_bound_at + first bake if none; gated on org-scoped GitHub credential AND builder present; call site = session create AFTER session_repos insert, fire-and-forget
  currentBake(sourceId): Promise<BakeRow | null>;
}
```
- [ ] Step 1: Failing tests — identity chain (base commands change → base identity changes → repo identity changes); skip matrix (same identity+sha → skip; sha moved → bake; identity moved → bake); parent-first ordering (base bakes before dependent repo in one pass — assert dispatch order); decay (live binding blocks decay; 31d + no live binding → disabled; ensureRepoSource re-enables); zero-config gating (no org credential → no source; no builder → no source).
- [ ] Step 2: Implement (Dockerfile generation for `base` kind: `FROM <parent image>` + one `RUN` per command, reusing `recipe.ts` generation helpers; repo bakes now `FROM` parent source's current bake ref, recorded in the bake's recipe snapshot).
- [ ] Step 3: api suite; commit `feat: SourceService — chained bakes, skip, decay, zero-config`.

### Task 16: Resolution walks the chain

**Files:**
- Modify: `packages/api/src/engine/resolve-snapshot.ts` (repoBake from repo source's current bake; `baseBakeRef` from org base source's current pushed bake; drop `prebuilds/resolve.ts` after parity — keep its k8s pull-preflight logic)
- Test: extend `resolve-snapshot.test.ts` — unbound session + pushed base bake → image = base ref; repo session, no repo bake, base present → base ref; both → repo ref.

- [ ] Steps: failing tests → implement → commit `feat: image resolution walks source chain`. (From this commit, a new base bake makes every session's next prompt replace its pod — the reconcile rollout mechanism, live.)

### Task 17: Routes + wire types

**Files:**
- Create: `packages/api/src/routes/sources.ts` (`/api/org/sources`: GET list (+bake history per source), POST (kind external|base|repo), PATCH `:id` (enabled/schedule/setup_commands/external_ref), DELETE `:id`, POST `:id/bake` (manual), GET `/api/sources/for-repo` narrow badge — same shape as today's `/for-repo`)
- Delete: `routes/prebuilds.ts`, image-catalog routes; Modify: `app.ts` mounts, `wire/types.ts` (SourceSummary, BakeSummary — mirror old shapes plus `kind`, `parentId`, `identityHash`)
- Test: port `routes/prebuilds.test.ts` → `routes/sources.test.ts` (same auth gates: admin CRUD, member badge only)

- [ ] Steps: port tests first (they define the contract) → implement → suite green → commit `feat: /api/org/sources routes replace prebuilds+catalog`.

### Task 18: Settings UI — Images page

**Files:**
- Modify: `packages/web/src/routes/settings.organization.sandbox-images.tsx` (title "Sandbox images" stays)
- Create: `packages/web/src/components/settings/sources-section.tsx` (replaces `prebuilds-section.tsx`; delete it)
- Create: `packages/web/src/api/sources.ts` (TanStack hooks mirroring Task 17 routes)
- Test: `sources-section.test.tsx` (jsdom, mock `~/api/sources` exactly like `github-app-section.test.tsx` mocks `~/api/settings`)

Layout: three groups on one page — **Base image** card (setup-commands textarea, one command per line, Save = PATCH + "Bake now" button, current bake status badge + relative time); **Repository images** list (auto-created rows badge "auto", enabled toggle, bake history drawer per row, Bake now, decay state shown as "paused — repo unused 30d"); **External images** (existing catalog CRUD, renamed copy). Builder-unavailable banner carries over verbatim. All copy STE: every error names the corrective action.

- [ ] Steps: failing component tests (base card saves commands + fires bake; repo row toggle PATCHes; decayed row shows paused copy; unavailable banner when meta.builder null) → implement → `pnpm --filter @valet/web test` → commit `feat: sources settings UI — base image editor + repo bake list`.

### Task 19: Session-create integration + badge

**Files:**
- Modify: session create route (call `ensureRepoSource` fire-and-forget after binding insert), new-session dialog badge hook → `/api/sources/for-repo`
- Test: api integration — creating a session with a repo + org credential + builder seeds an enabled repo source and a queued first bake; without credential seeds nothing.

- [ ] Steps: failing test → implement → commit `feat: zero-config repo sources on session create`.

---

## Phase 5 — End-to-end validation (the deliverable)

### Task 20: Full scorecard + live k8s dogfood via UI

- [ ] `pnpm typecheck` + `make e2e` — clean scorecard; every red row must be a named pre-existing environmental failure.
- [ ] Deploy: `make k8s-build-fast` (assert exit 0) + rollout restart + port-forward.
- [ ] Walk the spec's exit criteria IN THE UI (Chrome, screenshots at each step): (1) shim edit → in-place convergence, no pod replacement; (2) new stock tag → pod replaced, `/workspace` file survives, `/root` file gone; (3) `kubectl delete pod` → steps re-apply, current token at boot; (4) 12h rotation (env-shrunk interval) with zero pod events; (5) org base commands edit in Settings → bake → next prompt gets python3/jq; (6) bind fresh repo → auto source + background bake → second session boots prebuilt (badge shows); (7) two nightly passes, no commits → second pass all-skip (assert via logs); (8) decay + re-bind re-enable (manipulate last_bound_at via psql).
- [ ] Update `docs/specs/2026-08-02-sandbox-reconcile-design.md` Deviations section with anything discovered live; update CLAUDE.md's prep/prebuild references (buildWorkspacePrep → SpecProvider, prebuild tables → sources/bakes).
- [ ] Commit per fix; final commit `docs: reconcile spec deviations from live dogfood`.

---

## Self-review notes (run before execution)

- Spec coverage: decisions 1-16 map to Tasks 1-2 (d1), 3-6 (d2), 5 (d3,6,7,9), 7 (d4), 9-12 (d5), 6 (d8), 4+6 (d10), 13/15/17 (d11), 15+18 (d12), 15+19 (d13), 15 (d14), 14 (d15), 16 (d16... content-addressing), named risks → Tasks 8-9 verify-first, topology → no code (invariants pinned in Tasks 5/7 tests).
- Type consistency: `DesiredSandboxSpec`/`PrepStep`/`AppliedState`/`ResolveSnapshot` names are used identically across Tasks 1-7; `credsFiles`/`updateCreds`/`credsMount` across 9-12; `image_sources`/`bakes` DDL matches Task 15-17 row types.
- Known sequencing hazard: Tasks 3-6 break api compile mid-phase — Task 3 and Task 6 must land in the same PR-sized window; run engine-filtered checks between them, full typecheck only after Task 6.
