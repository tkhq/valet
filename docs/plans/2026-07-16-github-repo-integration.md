# GitHub / Repo Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/specs/2026-07-16-github-repo-integration-design.md`: GitHub App-first credentials (manifest-flow creation, installations, cached installation tokens, user App-OAuth + refresh), one canonical token-resolution service, multi-repo sessions with clone-on-first-provision, the in-sandbox dynamic git credential helper, and the settings surfaces.

**Architecture:** A `github-app` service module (App JWT, discovery, minting) and a `github-tokens` service (the ONE `resolveGitHubToken`) sit behind a thin `RepoHost` port. Sessions bind repos via `session_repos`; the engine gains `prepareSandbox?` (awaited before waiters, once per epoch); prep clones bindings using a `valet-git-credential` helper that fetches short-lived tokens from `POST /api/sandbox/git-credential` (VALET_SANDBOX_TOKEN-authed, owner-scoped). Plugin actions resolve `github` credentials through the token service. Settings: org GitHub App card + user Connect GitHub + generic credentials list.

**Tech Stack:** TypeScript strict, Hono 4, Drizzle/Postgres (PGlite dev), node:crypto RS256 App JWTs, fetch-based GitHub API (fixture server in tests), vitest, React 19.

**Spec:** `docs/specs/2026-07-16-github-repo-integration-design.md` — Decisions (locked) binding; non-goals real (no webhook-triggered workflows, no non-GitHub hosts beyond the port, no mid-session binding additions, no SSH URLs).

## Global Constraints

- Node 22 for every command: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && <cmd>`. (Node 20 fails WS tests with `WebSocket is not defined` — do not misdiagnose.)
- **Engine contract touchpoint (Task 1) REQUIRES adversarial review (opus):** `prepareSandbox?(sandbox, epoch)` — absent = byte-identical; awaited in `doProvision` after readiness, BEFORE `flushWaiters`; prep rejection = startup-failure semantics (waiters reject, attachment `error`); once per (sandbox, epoch); hibernation wake (`doResume`, same epoch) does NOT re-run; re-provision (new epoch) re-runs.
- **One resolution function, one minting path** (spec decisions 3): `resolveGitHubToken` is the only precedence implementation; installation minting has exactly one (cached) implementation. Reviewers should treat a second implementation of either as Important.
- **Token discipline (binding, test-pinned):** no token in any sandbox env var, exec argv, or persisted git config/remote; `git remote get-url origin` credential-less; helper route owner-scoped to the union of the session's bound-repo owners (unbound owner → 403); explicit `auth` selection is STRICT (missing selected credential → clear error, never silent fallback).
- **Secrets never in responses:** App private key/client secret/tokens never appear in any API response (`hasKey`-style summaries only); webhook route HMAC-verified with the stored secret; fixture-first tests, no live network.
- Pre-1.0 migrations: `packages/api/migrations/pg/0000_app.sql` edited in place + Drizzle; `rm -rf ~/.valet/pg` after schema edits.
- PGlite one per process; api vitest has unit (env-scrubbed) + integration projects; only the 2 known `messages.abort` failures allowed.
- Type safety: no `any`/`as unknown as`/`@ts-ignore`. No Co-Authored-By. Root typecheck excludes `packages/web`.
- Org-admin gating: the DB-backed `requireOrgAdmin` pattern (`packages/api/src/routes/llm-providers.ts:66-73`); extract it to a shared helper (`packages/api/src/routes/_org-admin.ts`) in the first task that needs it and refactor llm-providers/org/org-invites opportunistically ONLY if trivial — otherwise just share going forward.
- GitHub API base URL injectable everywhere (`VALET_GITHUB_API_URL` default `https://api.github.com`, `VALET_GITHUB_URL` default `https://github.com`) via the `resolveXxx(env)` pure-helper pattern (`packages/api/src/providers/sandbox-backend.ts:94-110` precedent) — fixture servers depend on this.

---

### Task 1: Engine seam — `prepareSandbox?` [ADVERSARIAL REVIEW REQUIRED]

**Files:** Modify `packages/engine/src/types.ts` (session options field beside `resolveModel?`), `packages/engine/src/sandbox/attachment.ts` (await prep in `doProvision` between readiness and `flushWaiters`); Test `packages/engine/test/prepare-sandbox.test.ts`.

**Interfaces:** `prepareSandbox?: (sandbox: Sandbox, epoch: number) => Promise<void>` on the same options object as `resolveModel?`. Contract (all pinned by tests): called with the live sandbox + epoch before ANY waiter resolves (ordering pinned by a prep that writes a marker a waiter then reads); prep rejection → waiters reject with `sandbox preparation failed: {message}`, attachment `error`, next `ensureReady` re-provisions and re-runs prep at the new epoch; `doResume` (hibernation wake, same epoch) does NOT call prep; interaction with the wake supersession guard verified (prep belongs to `doProvision` only); absent hook = byte-identical (structural: no new code on the path when undefined; full engine suite unchanged).

- [ ] Steps: failing tests → implement → `pnpm --filter @valet/engine test && pnpm typecheck` → commit `feat(engine): prepareSandbox post-provision seam`.

---

### Task 2: Schema — `session_repos`, `github_installations`, wire types, create-route bindings

**Files:** Modify `packages/api/src/schema/index.ts` + `packages/api/migrations/pg/0000_app.sql` (in place); `packages/api/src/wire/types.ts`; `packages/api/src/routes/sessions.ts`; Test extend `sessions.create.test.ts` + a pg-schema round-trip.

**Interfaces (consumed by Tasks 3-11):**
- `sessionRepos` table: `{ sessionId text notNull (FK-style, no actual FK — match sibling tables' conventions), host text notNull default 'github', fullName text notNull, cloneUrl text notNull, ref text, auth text enum ["auto","app","user"] notNull default 'auto', position integer notNull }`, index on sessionId, unique (sessionId, position).
- `githubInstallations` table: `{ id text PK ("ghi_"+uuid), orgId text notNull, installationId bigint notNull, accountLogin text notNull, accountType text notNull, repositorySelection text, suspended boolean notNull default false, linkedUserId text, cachedToken text (encrypted, nullable), cachedTokenExpiresAt bigint, createdAt bigint, updatedAt bigint }`, unique (orgId, installationId), index on (orgId, accountLogin).
- Wire: `RepoBinding = { host?: string; fullName: string; cloneUrl: string; ref?: string; auth?: "auto"|"app"|"user" }`; `CreateSessionRequest.repos?: RepoBinding[]` + `repo?: RepoBinding` (sugar → one-element list; 400 if both present); `SessionDetail.repos?: RepoBinding[]` (present only when bound). Validation: https-only cloneUrl (400), fullName non-empty, ≤5 bindings, positions assigned by array order.
- Unbound create/response byte-identical (existing tests untouched green).

- [ ] Steps: failing tests → implement (+ `rm -rf ~/.valet/pg`) → `env -u OPENAI_API_KEY pnpm --filter @valet/api test && pnpm typecheck` → commit `feat(api): session repo bindings + github installations schema`.

---

### Task 3: GitHub App core service — App JWT, discovery, cached installation minting

**Files:** Create `packages/api/src/services/github-app.ts`, `packages/api/src/services/github-fixture.ts` (test-only fixture server builder — export from a test-helpers path if the repo convention prefers; check how `llm-providers` tests host fixtures and mirror); Test `packages/api/src/services/github-app.test.ts`.

**Interfaces (consumed by 4-7):**
- App config: stored/read via credential store service `github_app`, owner `{type:"org"}`: `{ type: "service_account", metadata: { appId, appSlug, oauthClientId, htmlUrl }, apiKey: <PEM private key>, accessToken: <oauthClientSecret>, refreshToken: <webhookSecret> }` — document the field mapping in one place (`loadAppConfig(deps, orgId)` returns a typed `GithubAppConfig | null`). (Reviewer note: reusing StoredCredential fields for three distinct secrets is deliberate — one encrypted row, no new table; the mapping is centralized and typed.)
- `mintAppJwt(config): string` — RS256 via `node:crypto` `createSign`/`KeyObject` (no new deps; handle PKCS#1 PEMs via `createPrivateKey` which accepts both), `{ iat: now-60, exp: now+540, iss: appId }`.
- `discoverInstallations(deps, orgId): Promise<InstallationRow[]>` — `GET {api}/app/installations` (App JWT), upserts `github_installations` (insert/update by installationId; removes rows absent from the response), returns rows. Sets `linkedUserId` when an installation's `account.login` matches a connected user's GitHub login (read from user `github` credentials' `metadata.login` — Task 6 writes it).
- `mintInstallationToken(deps, orgId, accountLogin): Promise<string | null>` — THE one cached path: row lookup by (orgId, accountLogin, suspended=false) → cached token fresh (expiry - 5min) → return; else `POST /app/installations/{id}/access_tokens`, encrypt+cache on the row, return. Null when no installation.
- Fixture server: fake `GET /app/installations`, `POST /app/installations/:id/access_tokens`, `GET /user`, `POST /login/oauth/access_token`, `GET /user/repos`, `GET /installation/repositories`, manifest conversion `POST /app-manifests/:code/conversions` — one composable Hono fixture used by Tasks 3-7 tests.

- [ ] Steps: failing tests (JWT claims/signature verified with the fixture's public key; discovery upsert incl. removal + linkedUserId match; mint caching behavior at the 5-min margin incl. re-mint; suspended excluded) → implement → gate → commit `feat(api): github app service — jwt, discovery, cached installation tokens`.

---

### Task 4: Token service — `resolveGitHubToken` + user refresh subsystem

**Files:** Create `packages/api/src/services/github-tokens.ts`; Modify `packages/api/src/auth/provisioning.ts` (capture `expiresAt` on social auto-save); Test `packages/api/src/services/github-tokens.test.ts`.

**Interfaces (consumed by 5-10):**
- `resolveGitHubToken(deps, req: { orgId, userId?, purpose: "git"|"api", repo?: { owner, name }, auth?: "auto"|"app"|"user" }): Promise<{ token: string | null; source: "installation"|"user"|"pat"|"none"; login?: string } >` implementing spec decision 3 verbatim:
  - explicit `auth: "app"` → installation for owner or THROW `GitHubAuthError("the GitHub App is not installed on {owner}")`; `auth: "user"` → healthy user credential or THROW naming the gap; never silent fallback across explicit.
  - auto + git: installation(owner) → user → `{ token: null, source: "none" }` (tokenless — callers proceed bare).
  - auto + api: user → installation(primary owner when `repo` given) → sole-installation → THROW with connect hint.
- User-token freshness inside the service: credential `expiresAt - 5min` stale → single-flight refresh (`POST {github}/login/oauth/access_token` grant_type=refresh_token with the App's client id/secret) → persist rotated `{accessToken, refreshToken, expiresAt}`; refresh failure → mark unhealthy (`metadata.refreshFailedAt`) and treat as absent for auto (STRICT error for explicit `auth:"user"`). Single-flight: an in-module `Map<credKey, Promise>`.
- PATs: user/org `github` credential without `expiresAt`/`refreshToken` = non-expiring; `metadata.identityOnly` (set by Task 6 when scopes are the social-login defaults) excludes it from repo-capable resolution.
- `provisioning.ts` auto-save gains `expiresAt: account.accessTokenExpiresAt?.getTime()` and `metadata: { identityOnly: true }` (better-auth default scopes are read:user/user:email — spec Context).

- [ ] Steps: failing tests (full matrix per the spec Testing section incl. strict-explicit both directions, single-flight under concurrent calls [two awaits, one fixture hit], rotation persisted, unhealthy fallthrough, identityOnly excluded, sole-install fallback, tokenless) → implement → gate → commit `feat(api): canonical github token resolution + refresh subsystem`.

---

### Task 5: App setup routes — manifest flow, installations admin, webhook sync

**Files:** Create `packages/api/src/routes/github-app.ts` (+ extract `packages/api/src/routes/_org-admin.ts` shared `requireOrgAdmin`); Modify `packages/api/src/app.ts` (mount authed `/api/org/github-app` + PUBLIC `/webhooks/github-app` alongside the telegram webhook pattern — read how `packages/api` mounts the hardened public telegram route and mirror its body-cap/throttle hygiene); Test `packages/api/src/routes/github-app.test.ts`.

**Interfaces:**
- Admin-gated: `GET /api/org/github-app` → `{ configured: boolean, app?: { appId, appSlug, htmlUrl, installUrl }, installations: InstallationSummary[], webhook: { mode: "public"|"manual" } }` (no secrets); `POST /api/org/github-app/manifest` `{ target?: "org:{login}" | "personal" }` → `{ url, manifest, state }` for the browser to POST to GitHub (state = HMAC-signed `{orgId, nonce, exp}` using `VALET_ENCRYPTION_KEY`-derived key); `GET /api/org/github-app/setup` (callback; validates state, exchanges `code` at `POST /app-manifests/{code}/conversions`, saves the `github_app` credential, kicks discovery, redirects to settings); `POST /api/org/github-app/refresh` → discovery; `DELETE /api/org/github-app` (remove config + installations rows; refuse while any session... no — allowed, resolution degrades per spec; note it).
- Public webhook `POST /webhooks/github-app`: HMAC `X-Hub-Signature-256` against the stored webhook secret; handles `installation` + `installation_repositories` events (upsert/remove/suspend rows); everything else 204 ignored; 1MiB cap; signature-fail throttled logging (telegram precedent).
- Wire types + no-secret shape tests.

- [ ] Steps: failing tests (state tamper 400; conversion saves config + discovery ran [fixture]; webhook HMAC good/bad; suspend event flips row; non-admin 403; secrets absent from every body) → implement → gate → commit `feat(api): github app setup — manifest flow, installations, webhook sync`.

---

### Task 6: User connect flow — App user-OAuth routes

**Files:** Extend `packages/api/src/routes/github-app.ts` (or a sibling `github-connect.ts` — one router file per concern, your judgment, say which); Test extend.

**Interfaces:**
- `POST /api/me/github/connect` → `{ url }` (App authorize URL `{github}/login/oauth/authorize?client_id=...&state=...` — HMAC state `{userId, orgId, nonce, exp}`); `GET /api/me/github/callback` → validates state, exchanges code (`POST {github}/login/oauth/access_token`), fetches `GET /user` for `login`, saves user `github` credential `{ type:"oauth2", accessToken, refreshToken, expiresAt, metadata: { login } }` (NO identityOnly — this flow is repo-capable), triggers installation `linkedUserId` re-match, redirects to `/settings/connected-accounts`; `DELETE /api/me/github` → delete credential (+ clear linkedUserId rows).
- `GET /api/credentials` already exists — verify it lists these; extend only if the summary lacks fields the UI needs (health badges need `expiresAt`/`metadata.refreshFailedAt`/`metadata.identityOnly` surfaced — add to the summary WITHOUT secret material).

- [ ] Steps: failing tests (connect URL shape; callback saves w/ login + expiresAt; state tamper; disconnect clears link; credentials list surfaces health fields, never secrets) → implement → gate → commit `feat(api): github user connect — app oauth + credential health`.

---

### Task 7: `RepoHost` port + `GET /api/repos`

**Files:** Create `packages/api/src/repos/host.ts` (port + registry-by-host), `packages/api/src/repos/github-host.ts` (impl over Tasks 3-4), `packages/api/src/routes/repos.ts`; Modify `app.ts` (mount authed `/api/repos`), `packages/api/src/wire/types.ts`; Test `packages/api/src/routes/repos.test.ts`.

**Interfaces:** the spec decision 8 port verbatim (`RepoHost { id, listRepos(ctx), resolveGitToken(ctx, {owner, repo, purpose}) }`; ctx carries `{orgId, userId, deps}`). `GET /api/repos` (any member): union of installation repos (`GET /installation/repositories` per non-suspended installation, via minted tokens) + user App-OAuth repos (`GET /user/repos?affiliation=...`), deduped by fullName (installation wins for `installed: true` flag), sorted most-recently-updated, mapped through `RepoListItem` (import from `@valet/sdk` — types only); `{ repos, connected: boolean, installed: boolean }`. Soft-empty when nothing configured. Reuse `mapGitHubRepo` from `packages/plugin-github/src/repo-shared.ts` if importable without dragging legacy deps — else copy the 14-line mapper with a provenance comment (say which in the report).

- [ ] Steps: failing tests (union/dedupe/flags matrix; pagination cap 100 per source documented; no secrets; unconnected soft state) → implement → gate → commit `feat(api): RepoHost port + repo listing`.

---

### Task 8: Sandbox credential surface — helper route, helper script, gh CLI, images

**Files:** Create `packages/api/src/routes/sandbox-git-credential.ts` (mount under the sandbox-token-authed surface — find how existing `VALET_SANDBOX_TOKEN`-authed routes authenticate [the sandbox tokens table / auth middleware] and mirror), `packages/api/src/engine/git-credential-helper.ts` (generates the helper + gh wrapper script text — pure, unit-tested); Modify `docker/Dockerfile.sandbox-k8s` (install `gh` CLI via GitHub's apt repo, pinned version ARG); Test route tests + script-gen unit tests.

**Interfaces:**
- `POST /api/sandbox/git-credential` body `{ host: string, owner: string }`, auth: sandbox token → sessionId; loads the session's bindings; `owner` ∉ union of bound owners (case-insensitive) → 403 `{ error: "owner not bound to this session" }`; else `resolveGitHubToken(purpose:"git", repo:{owner}, auth: binding.auth)` → `{ username: "x-access-token", password: token }` or `{ anonymous: true }` for tokenless. Never logs the token.
- Helper script (installed by prep, Task 9): git-credential protocol (`get` verb only): reads stdin keys, curls the route with the sandbox token (from env — the token already lives in sandbox env today), emits `username=`/`password=` or nothing for anonymous; `store`/`erase` verbs no-op. gh wrapper: `valet-gh` shim exporting `GH_TOKEN=$(helper-fetch)` for the single invocation then exec `gh "$@"` (document: agents use `gh` normally — the wrapper IS installed as `gh` ahead of the real binary on PATH? NO — keep honest: install real gh; prep sets `gh` alias/shim only when a binding exists. Decide in-task, disclose).
- Image: `gh` CLI added to `Dockerfile.sandbox-k8s` (build not run in-task; validated by `docker build --check` + Task 12 dogfood).

- [ ] Steps: failing tests (scope 403; bound-owner token shape; anonymous passthrough; auth-strict propagation; script-gen golden incl. no-token-material-embedded pin) → implement → gate (`docker build --check`) → commit `feat(api): in-sandbox git credential surface + gh wiring`.

---

### Task 9: Workspace prep — clone bindings via the helper

**Files:** Create `packages/api/src/engine/workspace-prep.ts`; Modify `packages/api/src/engine/host.ts` (thread `session_repos` through session meta [the `profile` precedent — ALL call sites: buildSession create/restore, boot-restore, messages.ts loadEngineSession] and pass `prepareSandbox` when bindings exist); Test `workspace-prep.test.ts` (recording provider) + a docker-gated integration case.

**Interfaces:** prep, per binding in position order: target dir = single binding → `<workspace>` itself; multiple → `<workspace>/<repoName>`; `.git` exists → best-effort `git fetch origin && git checkout {ref?}` (failure logs, prep continues — offline-tolerant); else install helper script + set `credential.helper` + `user.name`/`user.email` (valet profile) in sandbox-global git config, then `git clone {cloneUrl} {dir} [--branch ref]` (helper supplies auth; failure → prep throws → startup-failure semantics per Task 1). Token discipline pinned on a recording sandbox: no token in any exec argv (the helper fetches out-of-band); `git remote get-url origin` bare.

- [ ] Steps: failing unit tests (layouts single/multi; fetch-vs-clone branch; failure propagation; argv scan) → implement → docker-gated e2e (public repo tokenless clone real) → `env -u OPENAI_API_KEY pnpm --filter @valet/api test && pnpm typecheck` → commit `feat(api): repo clone on sandbox prep via credential helper`.

---

### Task 10: Actions credential path — plugin `github` resolves through the token service

**Files:** Modify `packages/api/src/plugins/action-invoker.ts` (or wherever `PluginActionContext.credentials` is built — read it first): when the requested service is `github`, resolve via `resolveGitHubToken(purpose:"api", repo: session's primary binding?, auth: primary binding.auth ?? "auto")` and synthesize the `StoredCredential` shape the actions expect (`{ type:"oauth2", accessToken: token }`); other services unchanged (byte-identical pin). Test: invoker-level tests with fixture (user-connected → user token; unconnected + installation → installation token [anonymous org path]; explicit binding auth honored; non-github services untouched).

- [ ] Steps: failing tests → implement → gate incl. plugin-github suite → commit `feat(api): github actions resolve via the token service`.

---

### Task 11: Web — picker, org GitHub settings, connected accounts

**Files:** Create `packages/web/src/routes/settings.organization.github.tsx`, `packages/web/src/components/settings/github-app-section.tsx`; Modify `settings-rail.tsx` (+`{ to: "/settings/organization/github", label: "GitHub" }`), `packages/web/src/routes/settings.connected-accounts.tsx` (+GitHub row + generic credentials list w/ revoke), `packages/web/src/components/new-session-dialog.tsx` (repo typeahead + add-another + conditional auth selector + workspace autofill), api hooks; Tests per component.

**Interfaces:** consumes Tasks 5-7 routes. Picker: `useRepos()` (staleTime 60s); selection → binding rows; auth selector rendered ONLY when the repo is both installed and user-connected; unconnected → hint row linking settings; no selection = today (pin). Org page inside `OrgRouteGuard`: not-configured → Create App (posts manifest, renders the auto-submitting form to GitHub — the manifest flow requires a browser POST; mirror how legacy did the form or use a `<form action={github} method="post">` with the manifest JSON field); configured → card + installs list + refresh + install link + webhook mode badge. Connected accounts: GitHub connect/disconnect/health badges + "Install on your personal account" link + credentials list with revoke.

- [ ] Steps: failing tests (picker flows incl. auth-selector visibility matrix; org card states; connect/health/disconnect; credentials list revoke; no-repo dialog regression pin) → implement → `cd packages/web && pnpm test && pnpm typecheck` → commit `feat(web): github settings + repo picker`.

---

### Task 12: E2E + docs + dogfood

**Files:** Create `packages/api/src/integration/github-repo.e2e.test.ts` (fixture-first full loop; live-gated variant behind real App creds env); Modify spec Status → Implemented + Deviations, `docs/handoff-2026-07-15-engine-v2.md`, `CLAUDE.md` if durable gotchas emerged; full battery.

- [ ] Steps: fixture e2e (App setup → discovery → bind private repo [fixture git server? — clone paths already covered docker-gated in T9; e2e focuses on the API loop: setup→install→list→create-session→helper-route mint→action token attribution matrix) → full battery (`pnpm typecheck && pnpm --filter @valet/engine test && env -u OPENAI_API_KEY pnpm --filter @valet/api test && cd packages/web && pnpm typecheck && pnpm test`; only the 2 known failures) → docs → commit `docs(specs): github/repo integration implemented`. **Live dogfood (coordinator, human-in-the-loop items flagged in the ledger):** real App via manifest flow, org install, private-repo session clone+push (bot-attributed), personal connect → user-attributed action, fork flow, two-repo session, public tokenless, >1h session push, token refresh past 8h if timeboxable — record PASS/FAIL per the spec's exit criteria.

---

## Self-review notes (already applied)

- **Spec coverage:** decision 1 → T3/T5; 2 → T2/T3/T5 (personal installs need no special code — pinned by an accountType:User test in T3); 3 → T4 (+T8/T10 consumers); 4 → T4/T6; 5 → T2/T9; 6 → T1/T9; 7 → T8/T9; 8 → T7; 9 → T7/T11; 10 → T5/T6/T11. Exit criteria → T12.
- **Order-of-need:** helper script (T8) lands before prep (T9) which installs it; token service (T4) before every consumer; fixture (T3) shared forward.
- **Type consistency:** `RepoBinding` (T2) = picker payload (T11) = prep input (T9); `resolveGitHubToken` signature (T4) = consumers T5-T10; `GithubAppConfig` mapping centralized in T3.
- **Known softness (flagged for implementers):** better-auth `account.accessTokenExpiresAt` availability in the provisioning hook needs verification in-task (T4); the manifest flow's browser POST mechanics (T11) should crib legacy's `admin-github.ts` form rendering; gh-CLI auth wiring has a disclosed decide-in-task point (T8); `GET /api/credentials` summary extension (T6) must stay secret-free.
