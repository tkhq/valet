# Repo Sessions v2 Implementation Plan (foundation for prebuilds)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sessions can be bound to a git repo at creation — repo picker in the web dialog, api-side clone into the sandbox workspace on first provision (org GitHub credential, never persisted in the repo), and git-credentialed sessions — the foundation spec #4 (prebuilds) assumes.

**Architecture:** `agent_sessions` gains nullable repo columns; `POST /api/sessions` accepts a `repo` object; a new `GET /api/repos` lists repos via the org's stored GitHub credential (`CredentialStore.get({type:"org"}, "github")`); the engine gains ONE optional seam — `prepareSandbox?(sandbox, epoch)` on session options, awaited by the attachment after a sandbox first becomes ready in an epoch, before waiters receive it — which the api uses to `git clone` + configure git credentials inside the sandbox. No prebuilds, no builders, no registry in this plan.

**Tech Stack:** TypeScript strict, Hono 4, Drizzle/Postgres (PGlite dev), GitHub REST via fetch, vitest, React 19.

**Scope guard:** this is the FOUNDATION only. Non-goals: prebuilds/ImageBuilder/registry (spec #4's own plan), GitHub App installation-token minting (the org credential is whatever the credential store holds — manual PAT or connect-flow OAuth token), per-user repo credentials, non-GitHub providers (shapes stay provider-ready via `RepoListItem`), push webhooks, PR/branch UI.

## Global Constraints

- Node 22 for every command: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && <cmd>`.
- **Engine contract touchpoint (Task 3) REQUIRES adversarial review (opus):** `prepareSandbox?` — absent = byte-identical (the `resolveModel?`/`gatewayEndpoint?` optional-seam precedents). Prep runs at most once per (sandbox, epoch); a prep failure must fail the waiting operation with a clear error (not hang, not half-prepared silently); re-provision (new epoch) re-runs prep.
- **Tokens never persist in the repo:** the clone uses an ephemeral credential mechanism (askpass script or `http.extraheader` at command scope); `git remote get-url origin` inside the sandbox must show the credential-less URL — pinned by test. Token never appears in engine store, event log, or api responses.
- Pre-1.0 migrations: `0000_app.sql` edited in place + Drizzle schema; `rm -rf ~/.valet/pg` after.
- PGlite one per process; api vitest unit project scrubs provider env keys; only the 2 known `messages.abort` failures allowed.
- Type safety: no `any`/`as unknown as`/`@ts-ignore`. No Co-Authored-By. Root typecheck excludes `packages/web` (run separately).
- Reuse `RepoListItem` from `packages/sdk/src/repos/index.ts` and `mapGitHubRepo` from `packages/plugin-github/src/repo-shared.ts` (types/helpers only — the legacy `RepoProvider` live path stays unwired).

---

### Task 1: Schema + create-route repo binding

**Files:**
- Modify: `packages/api/src/schema/index.ts` (`agentSessions` + 3 nullable columns), `packages/api/migrations/pg/0000_app.sql` (in place)
- Modify: `packages/api/src/wire/types.ts` (`CreateSessionRequest.repo?`, `SessionDetail.repo?`)
- Modify: `packages/api/src/routes/sessions.ts` (accept/validate/persist/return)
- Test: extend `packages/api/src/routes/sessions.create.test.ts`

**Interfaces:**
- Produces (Tasks 3, 4; spec #4 later): columns `repoFullName: text("repo_full_name")`, `repoCloneUrl: text("repo_clone_url")`, `repoRef: text("repo_ref")` (all nullable — null = today's unbound session, byte-identical behavior). Wire `RepoBinding = { fullName: string; cloneUrl: string; ref?: string }`; `CreateSessionRequest.repo?: RepoBinding`; `SessionDetail.repo?: RepoBinding` (null → absent).
- Validation: `cloneUrl` must be `https://` (reject ssh/scp forms, 400 — the credential mechanism is HTTPS-only this pass); `fullName` non-empty; `ref` optional free-form.

- [ ] Steps: failing tests (create with repo persists + echoes; without repo → columns null, response omits `repo`; ssh URL → 400) → implement → `pnpm --filter @valet/api test -- sessions.create && pnpm typecheck` → commit `feat(api): repo binding on session create`.

---

### Task 2: `GET /api/repos` — list via org GitHub credential

**Files:**
- Create: `packages/api/src/routes/repos.ts`, `packages/api/src/services/github-repos.ts`
- Modify: `packages/api/src/app.ts` (mount `/api/repos`, authed)
- Modify: `packages/api/src/wire/types.ts` (`ListReposResponse`)
- Test: `packages/api/src/routes/repos.test.ts` (fixture GitHub API server on port 0 — same pattern as the llm-providers probe fixture)

**Interfaces:**
- `GET /api/repos` (any authed member — repos are for the picker): reads `engineCredentials.get({type:"org", id: user.orgId}, "github")`; no credential → 200 `{ repos: [], connected: false }` (the picker shows "connect GitHub in settings" — NOT an error); with credential → GitHub `GET /user/repos?per_page=100&sort=updated` (token from `accessToken ?? apiKey`), mapped via `mapGitHubRepo` → `{ repos: RepoListItem[], connected: true }`. Upstream 401 → `{ repos: [], connected: false, error: "github credential rejected" }` (200 — soft-fail, picker degrades). Base URL injectable for tests (env `VALET_GITHUB_API_URL` default `https://api.github.com` — follow the `resolveXxx(env)` helper pattern in `packages/api/src/providers/sandbox-backend.ts`).
- No secret leakage: response never contains the token (shape test).

- [ ] Steps: failing tests (connected list mapped; unconnected soft; 401 soft; token absent from response bodies) → implement → gate → commit `feat(api): repo listing via org GitHub credential`.

---

### Task 3: Engine seam — `prepareSandbox?` post-provision hook [ADVERSARIAL REVIEW REQUIRED]

**Files:**
- Modify: `packages/engine/src/types.ts` (session options field), `packages/engine/src/sandbox/attachment.ts` (await prep before flushing waiters)
- Test: `packages/engine/test/prepare-sandbox.test.ts`

**Interfaces:**
- Produces (Task 4-consumer is the api): on the SAME session-options object as `resolveModel?`: `prepareSandbox?: (sandbox: Sandbox, epoch: number) => Promise<void>`. Contract:
  - Runs after a provision (or resume→ready... decide: prep runs when a sandbox becomes ready in a NEW epoch — i.e. inside `doProvision` after `waitReady` succeeds and before `_state="ready"`/`flushWaiters`; the resume path (same epoch, hibernation wake) does NOT re-run prep (workspace persisted on the PVC).
  - At most once per (sandbox id, epoch) — a re-provision (epoch bump) re-runs it (fresh workspace on docker; k8s PVC survives but prep must be idempotent — the API'S prep implementation owns idempotence, e.g. skip clone when `.git` exists; the ENGINE only guarantees the once-per-epoch call).
  - Prep rejection → the provision FAILS exactly like a startup failure: waiters reject with the prep error (wrapped with a clear prefix, e.g. `sandbox preparation failed: ...`), attachment lands in `error`, `reportFailure`-style recovery semantics apply on next touch. No half-ready handout: waiters must never receive a sandbox whose prep threw.
  - Absent hook = byte-identical (structural pin: no new code on the path when undefined; full engine suite unchanged).

- [ ] Steps: failing tests (hook called once with the live sandbox + epoch before any waiter resolves — assert ordering via a prep that writes a marker the waiter then reads; absent hook byte-identical; prep rejection → waiters reject w/ prefixed error + attachment error state + next ensureReady re-provisions and re-runs prep at the new epoch; resume-after-suspend does NOT re-call prep) → implement (verify interaction with `doResume`'s supersession guard — prep belongs to `doProvision` only) → `pnpm --filter @valet/engine test && pnpm typecheck` → commit `feat(engine): prepareSandbox post-provision seam`.

---

### Task 4: API workspace prep — clone + git credentials in the sandbox

**Files:**
- Create: `packages/api/src/engine/workspace-prep.ts` (pure-ish builder: the prep function + the shell script generation, exported for tests)
- Modify: `packages/api/src/engine/host.ts` (`buildSession` threads `prepareSandbox` when the session row has a repo binding; repo fields join the session meta like `profile` did)
- Test: `packages/api/src/engine/workspace-prep.test.ts` (unit: script generation, no-token-in-argv/env-log discipline; integration behind the virtual/docker provider)

**Interfaces:**
- Consumes: Task 1 columns (thread through `loadOwnedSession`→meta→buildSession exactly like `profile`, incl. the restore + messages.ts loadEngineSession call sites that profile needed — grep them), Task 3 seam, org GitHub credential.
- Prep behavior (all via `sandbox.exec`, workspace-relative):
  1. If `<workspace>/.git` exists → `git fetch origin` + `git checkout <ref ?? origin default>` best-effort (fetch failure logs, does not fail prep — offline-tolerant for rebinds/wakes); done.
  2. Else clone: write an askpass script to a tmpfile inside the sandbox (`/tmp/valet-askpass-<rand>.sh` printing the token, mode 700), run `GIT_ASKPASS=<file> git clone <cloneUrl> <workspace> --branch <ref?>` with the token NEVER in argv or the persisted remote; delete the askpass file in a finally-exec; then `git -C <workspace> config user.name "Valet Agent"` + `user.email "agent@valet.local"` and install a session-lifetime credential helper ONLY IF the org credential exists (same askpass pattern written to `/tmp` — documented: lost on pod restart, refreshed on next prep... decide: re-write the askpass on EVERY prep call incl. the `.git`-exists branch so wakes/re-provisions refresh it).
  3. No org credential + private repo → clone fails → prep fails with the git error (clear, surfaced per Task 3 contract). Public repos clone fine without a credential (pin with a test).
- Token discipline pinned: exec'd command strings never contain the token (assert on a recording sandbox: every exec arg/stdin scanned); `git remote get-url origin` returns the bare URL.

- [ ] Steps: failing unit tests (script gen; token absent from all exec calls via recording provider; .git-exists branch skips clone; prep failure propagates) → implement → docker-gated integration (clone a tiny public repo into a real docker sandbox, marker at expected path; ref checkout honored) → `env -u OPENAI_API_KEY pnpm --filter @valet/api test && pnpm typecheck` → commit `feat(api): repo clone + git credentials on sandbox prep`.

---

### Task 5: Web — repo picker on session create

**Files:**
- Modify: `packages/web/src/components/new-session-dialog.tsx` (optional repo select above the workspace field)
- Modify: `packages/web/src/api/` (a `useRepos()` query hook)
- Test: extend `-new-session-dialog.test.tsx`

**Interfaces:**
- `useRepos()` → `GET /api/repos` (staleTime 60s). Dialog: a combobox listing `fullName` (typeahead filter, most-recently-updated order as returned); selecting a repo sets `repo: { fullName, cloneUrl, ref: defaultBranch }` on the create body AND auto-fills workspace to `/workspace/<repoName>` (still editable); `connected: false` → the picker renders a single disabled row "Connect GitHub in settings → Connected accounts" and the dialog works exactly as today otherwise (no repo). No repo selected → body carries no `repo` (byte-identical to today, pinned by existing tests staying green).

- [ ] Steps: failing tests (repo selection posts binding + autofills workspace; unconnected shows hint + no regression; no-selection body identical) → implement → `cd packages/web && pnpm test && pnpm typecheck` → commit `feat(web): repo picker on session create`.

---

### Task 6: E2E + docs

**Files:**
- Create: docker-gated e2e in `packages/api/src/integration/` (repo session end-to-end: create with repo → first prompt provisions + clones → agent `cat`s a repo file; restart → wake keeps workspace; unbound session byte-identical)
- Modify: `docs/specs/2026-07-15-sandbox-images-v2-design.md` (Context note: repo foundation now exists — pointer to this plan), `docs/handoff-2026-07-15-engine-v2.md` (note the foundation arc), `CLAUDE.md` if a durable gotcha emerged
- Test: full battery

- [ ] Steps: e2e (public repo, no-credential path — hermetic-ish; keep it small) → battery (`pnpm typecheck && pnpm --filter @valet/engine test && env -u OPENAI_API_KEY pnpm --filter @valet/api test && cd packages/web && pnpm typecheck && pnpm test`; only the 2 known failures) → docs → commit `docs: repo sessions foundation shipped`.

---

## Self-review notes (already applied)

- **Why a new engine seam instead of api-side-only:** the first tool exec races any api-side "clone after ready" — the attachment hands the sandbox to waiters the moment it's ready, so the only race-free place is inside the provision path before `flushWaiters` (exactly where startup-failure classification already sits). Precedent shape: `resolveModel?`.
- **Resume (hibernation wake) skips prep** deliberately: same epoch, PVC-persisted workspace; the askpass refresh question is handled by re-writing it on every prep — but wakes don't prep, so a woken sandbox may lack the askpass until next re-provision. ACCEPTED for this pass (agent pushes after a wake fail politely; note in docs); spec #4's fetch-on-start revisits wake-time refresh.
- **Type consistency:** `RepoBinding { fullName, cloneUrl, ref? }` (T1) = what T4 reads and T5 posts; `prepareSandbox?(sandbox, epoch)` (T3) = what T4 provides via host.
- **Known softness:** GitHub listing caps at 100 repos (no pagination this pass — note in report); the org credential may be an OAuth token without repo scope (listing 401s → soft-fail path covers it).
