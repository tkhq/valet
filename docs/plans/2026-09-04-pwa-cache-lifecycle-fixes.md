# PWA Cache Lifecycle Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the PWA asset cache exact, lifecycle-safe, and optional when Cache Storage fails.

**Architecture:** The Vite plugin stamps an exact emitted-asset allowlist into the worker. The worker uses the browser's normal update lifecycle and treats Cache Storage as a best-effort optimization around network fetches.

**Tech Stack:** Vite 6 plugin API, service workers, Cache Storage, Vitest, TypeScript

---

### Task 1: Lock the update lifecycle in tests

**Files:**
- Modify: `packages/web/src/pwa/sw.test.ts`
- Test: `packages/web/src/pwa/sw.test.ts`

- [ ] **Step 1: Write the failing lifecycle test**

Replace the immediate-activation assertions with a test that expects no
`install` listener and no `clients.claim()` call during activation. Populate
the current cache through `dispatchFetch()`. Then seed an old Valet cache and a
foreign cache. Assert that activation keeps the populated current cache and the
foreign cache, but deletes the old Valet cache.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @valet/web test src/pwa/sw.test.ts`

Expected: FAIL because the worker registers `install`, calls `skipWaiting()`,
and claims existing clients.

- [ ] **Step 3: Implement the standard lifecycle**

Remove the `install` listener and `clients.claim()` from
`packages/web/src/pwa/sw.js`. Keep old-cache deletion in `activate`; the browser
runs it only after the previous worker has no clients.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm --filter @valet/web test src/pwa/sw.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the lifecycle fix**

```bash
git add packages/web/src/pwa/sw.js packages/web/src/pwa/sw.test.ts
git commit -m "fix(web): preserve PWA clients during updates"
```

### Task 2: Cache only emitted asset paths

**Files:**
- Modify: `packages/web/src/pwa/sw.test.ts`
- Modify: `packages/web/src/pwa/sw.js`
- Modify: `packages/web/src/pwa/vite-plugin.ts`

- [ ] **Step 1: Write failing allowlist tests**

Extend the `buildServiceWorkerSource()` test with unordered, duplicated bundle
names plus names outside `assets/`. Assert that the source contains no template
tokens, contains each normalized `/assets/*` path once, excludes other bundle
paths, and gets the same build ID for equivalent sorted allowlists.

Add worker behavior tests that require an emitted asset path, ignore an unknown
`/assets/*` path, and ignore a navigation whose pathname is otherwise
allowlisted. Create the navigation request with `new Request(...)`, then use
`Object.defineProperty(request, "mode", { value: "navigate" })`; Node does not
accept `navigate` in the constructor.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm --filter @valet/web test src/pwa/sw.test.ts`

Expected: FAIL because the worker accepts every `/assets/*` pathname and does
not inspect `request.mode`.

- [ ] **Step 3: Stamp and enforce the exact allowlist**

In `vite-plugin.ts`, normalize, sort, and deduplicate emitted names under
`assets/`. Replace an `__ASSET_PATHS__` token with their JSON array. Derive the
build ID from the same sorted paths.

In `sw.js`, construct a `Set` from the stamped paths. Require `GET`, the same
origin, a non-navigation request, and exact set membership.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `pnpm --filter @valet/web test src/pwa/sw.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the allowlist fix**

```bash
git add packages/web/src/pwa/sw.js packages/web/src/pwa/sw.test.ts packages/web/src/pwa/vite-plugin.ts
git commit -m "fix(web): cache only emitted PWA assets"
```

### Task 3: Preserve successful network responses when caching fails

**Files:**
- Modify: `packages/web/src/pwa/sw.test.ts`
- Modify: `packages/web/src/pwa/sw.js`

- [ ] **Step 1: Write failing cache-failure tests**

Change `createWorker()` to accept `cacheFailure?: "open" | "match" | "put"`.
Make the matching fake Cache Storage operation reject. Pass a fake `console`
into `new Function()` and record `warn` calls so the tests stay quiet.

Add one table-driven case for each failure point. Each case must return the
successful network response, call the network once, and record a warning that
states whether the worker used the network or preserved its response.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm --filter @valet/web test src/pwa/sw.test.ts`

Expected: FAIL because Cache Storage rejections currently reject `respondWith`.

- [ ] **Step 3: Make caching best-effort**

Isolate cache open and lookup from the network fetch. On a cache read failure,
log that the worker will use the network. On a cache write failure, log that
the worker will return the network response. Do not catch the network failure.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `pnpm --filter @valet/web test src/pwa/sw.test.ts`

Expected: PASS with no unexpected warnings.

- [ ] **Step 5: Commit the fallback fix**

```bash
git add packages/web/src/pwa/sw.js packages/web/src/pwa/sw.test.ts
git commit -m "fix(web): tolerate PWA cache failures"
```

### Task 4: Synchronize documentation

**Files:**
- Modify: `packages/web/README.md`
- Modify: `docs/specs/2026-09-04-pwa-install-design.md`

- [ ] **Step 1: Update lifecycle and cache prose**

Document the exact allowlist, standard worker lifecycle, delayed activation,
and network fallback for cache errors. Change the design status to
`Implemented` after the tests pass.

- [ ] **Step 2: Run docs lint**

Run: `make e2e E2E_ARGS="--only docs-lint"`

Expected: PASS.

- [ ] **Step 3: Commit the synchronized documentation**

```bash
git add packages/web/README.md docs/specs/2026-09-04-pwa-install-design.md docs/plans/2026-09-04-pwa-cache-lifecycle-fixes.md
git commit -m "docs(web): document safe PWA updates"
```

### Task 5: Verify and deliver the PR

**Files:**
- Verify all modified files.
- Update: PR #569 description on GitHub.

- [ ] **Step 1: Run focused and package validation**

Run:

```bash
pnpm --filter @valet/web test src/pwa
pnpm --filter @valet/web test
pnpm --filter @valet/web build
pnpm typecheck
```

Expected: all commands pass.

- [ ] **Step 2: Run the full E2E scorecard**

Run: `make e2e 2>&1 | tee /tmp/pr569-e2e.log`

Expected: every runnable row passes. Record any environment-only skipped row.

- [ ] **Step 3: Inspect the final diff**

Run `git diff --check`. Before each commit, inspect staged and unstaged changes
with `git diff 138e36e7e`. After all commits, inspect the complete PR change
with `git diff origin/dev-v2...HEAD`.

Expected: no whitespace errors and no unrelated changes.

- [ ] **Step 4: Push and update the PR description**

Push the new commits to `pwa-v2-install`. Update the Security and caching,
Updates, and Validation sections with the final behavior and command results.
Save the proposed body in `/tmp/pr569-body.md` and run:

```bash
python3 scripts/docs/pr_description_lint.py < /tmp/pr569-body.md
```

Expected: exit 0. After the edit, confirm the PR lint and required GitHub checks
pass.
