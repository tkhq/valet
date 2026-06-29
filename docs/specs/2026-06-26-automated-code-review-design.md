# Valet Automated AI Code Review (`valet-review`)

**Date:** 2026-06-26
**Status:** Draft — spec-driven flow (this spec PR must be approved before implementation begins)
**Owner:** xiangan9
**Subsystems:** GitHub App (`integrations`), `workflows`, `sessions`, `orchestrator`
**Prior art:** Author's AI-reviewer pipeline for **Slopless**. Honest scope note: Slopless posts a *single issue-level comment* with `path:line` citations and a **cosmetic** verdict (it never calls GitHub's `/reviews` API, so it can't gate a merge), reviews the **diff only** (no clone), and runs **single-pass with no verification** on its PR path. This spec ports Slopless's proven pieces — single batched review, verdict taxonomy, per-head-SHA dedup, "no hand-wavy findings" — and deliberately **improves** on them: real merge-gating verdict events, durable dedup (D1 vs. Slopless's ephemeral Redis set), changed-lines filtering, a confidence floor, and cloned-tree context. The **inline, line-anchored `create_review`** is **net-new** (more than Slopless ever shipped), so its anchoring + failure modes (§5) are budgeted as real work, not a port. Three things Slopless's experience tells us to add up front — a deterministic pre-scan, an input-side large-diff cap, and a verification pass before `REQUEST_CHANGES` — are folded into §10.

---

## 1. Summary & End-State Goal

Build an automated AI code-review job on top of Valet's existing GitHub App. When a pull request is opened or updated, Valet launches a sandboxed "code reviewer" agent session that clones the PR head, diffs against the base, reasons about the changed lines, and posts a **single batched PR review** with **actionable inline comments** (path + line + concrete suggestion) plus an overall verdict (`COMMENT` / `REQUEST_CHANGES` / `APPROVE`). A follow-up Valet session can then **consume those review comments and open a fix PR** — gated behind an explicit human approval so no unreviewed AI code lands on the branch.

The work is feasible on existing rails. It requires exactly three substantive changes plus wiring:

1. **One critical webhook-path fix** — the App manifest registers its delivery URL behind `authMiddleware`, so every GitHub delivery is 401'd before signature verification runs (root-caused in §4).
2. **One new inline-review-comment action** — `github.create_review` (today only issue-level comments exist).
3. **Wiring `pull_request` events into the trigger/session dispatch path** — today `pull_request` only updates already-linked sessions; it never starts a review.

**End state:** A repo opts in → every qualifying PR gets a Valet review with inline, line-anchored comments within minutes → an operator clicks "fix" (or approves a plan) → Valet pushes a fix and updates the PR.

---

## 2. Motivation & Scope

### Motivation
Valet is already a GitHub App with `pull_requests:write` + `contents:write`, installation-token minting, a sandbox that gets `GITHUB_TOKEN` + `REPO_URL` injected, and a workflow executor with idempotency and concurrency control. Everything needed to read a PR, reason about it, and post a review already exists — except the ability to post *inline* comments and a trigger that *starts* a review. This is a small, high-leverage addition that turns Valet from "agent you ask to look at a PR" into "agent that reviews every PR automatically."

### Direction (per 2026-06-29 sync)
- **Bar for v1 = feature parity with Replete / sloppy.codes PR review**, ported onto Valet's rails. Match the table-stakes behavior first; don't gold-plate.
- **Push model + `@valet` re-review.** GitHub webhooks push PRs to Valet for review; additionally a user can **`@valet` in a PR thread to re-review** the current head mid-conversation.
- **Vanilla session, not an orchestrated thread.** A single PR review isn't compute-heavy enough to warrant the orchestrator — it runs as a plain session (see §6, dispatch).
- **Defer quality tuning.** Review-*quality* fine-tuning is the known rabbit hole; get the base rails (trigger → session → `create_review`) working first, tune later.
- **Sequencing — gated on workflows (#43).** This is **blocked on the workflows interpreter landing first**; its session/dispatch interfaces will shift when it does. Target start: week of 6 July.

### In scope (v1)
- Fix the manifest webhook URL so GitHub deliveries reach the signature-verifying handler (`/webhooks/github`).
- Add `github.create_review` (batched inline comments + verdict event).
- Extend `github.inspect_pull_request` to optionally return per-file `patch` hunks for line/position anchoring.
- Wire `pull_request` events (`opened`, `synchronize`, `reopened`, `ready_for_review`) into a review-session launch (dispatch path firms up once workflows #43 lands — see §6).
- Wire an **`@valet` mention re-review trigger**: an `issue_comment` on a PR mentioning `@valet` re-reviews the current head. The triggers plugin already lists `issue_comment` among its event types (`triggers.ts:3-16`), so the ingress hook exists.
- A "code reviewer" persona/skill and the review prompt contract.
- A **deterministic pre-scan** that primes the model with high-signal pattern hits, plus an **input-side large-diff cap** so huge PRs stay in budget (§10).
- A **verification/self-critique pass** gating any `REQUEST_CHANGES` finding before it posts (§10).
- A **GitHub-422 fallback**: findings that can't be anchored inline degrade into the review body rather than being dropped (§5).
- Per-repo opt-in toggle; idempotency by `X-GitHub-Delivery` + per-head-SHA dedup; OTEL tracing.
- A new `review_runs` table for run tracking / dedup / audit.

### Out of scope (v1, deferred)
- **The autonomous fix loop (v2).** v1 posts review comments only. The fix session is specified in §9 but ships behind a flag in a later milestone.
- Reacting *automatically* to every human reply on review threads (`pull_request_review` / `pull_request_review_comment` events) — **not** in the App's default events (`admin-github.ts:146`) and only needed for v2. (The explicit `@valet` re-review mention, via `issue_comment`, **is** in scope above — it's a deliberate mention, not passive thread-watching.)
- A scheduled cron sweep over open PRs (crons exist at `wrangler.toml:69`; event-driven is the v1 path — cron is an open question, §13).
- Migrating already-installed Apps automatically (runbook step only — see Risks).
- Language-specific linters / SAST integration (the agent reasons from the diff; deterministic tools are a future workflow step).

---

## 3. Background: What the GitHub App Can Do Today

All paths verified on the current checkout (`feat/usage-user-model-breakdown` — see Open Questions re: branch).

### 3.1 App lifecycle & credentials
- **Manifest creation:** `POST /api/admin/github/app/manifest` builds the App manifest (`admin-github.ts:154-169`) and returns the GitHub creation URL.
- **Setup callback:** `GET /github/app/setup` (mounted public at `/github`, `index.ts:192`) exchanges the temp code for App credentials, stored encrypted in D1: `appId`, `appPrivateKey` (PEM), `appOauthClientId/Secret`, `appSlug`, `appWebhookSecret`.
- **Default permissions** (`admin-github.ts:138-145`): `contents:write, metadata:read, pull_requests:write, issues:write, actions:write, checks:read`. These already cover posting reviews and opening fix PRs.
- **Default events** (`admin-github.ts:146`): `['push', 'pull_request']`. `pull_request_review` / `pull_request_review_comment` are **not** requested (needed only for v2).
- **Octokit App construction:** `loadGitHubApp(env, db)` reads D1 config and builds `App` with `{appId, privateKey, oauth, webhooks:{secret}}` (`services/github-app.ts:101-117`). Note the PKCS#1→PKCS#8 conversion (`ensurePkcs8`) — GitHub's manifest returns PKCS#1, which the Workers JWT lib can't use directly.
- **Installation tokens:** `mintInstallationToken` / `getOrMintInstallationToken` — D1-cached, re-minted 5 min before expiry, encrypted at rest (`services/github-app.ts:129-195`).
- **Credential resolution for in-session actions:** `githubCredentialResolver` (`integrations/resolvers/github.ts:31-97`) — user OAuth token first, else org installation bot token (strict `params.owner` match). Bot tokens get a "Created on behalf of" attribution suffix appended to bodies (`actions.ts:14-29`).

### 3.2 GitHub actions available today (`plugin-github/src/actions/actions.ts`)
**Read:** `github.get_pull_request`, `github.list_pull_requests`, `github.read_repo_file`, and the key reviewer-input action **`github.inspect_pull_request`** (`actions.ts:651-735`) — returns PR metadata, files changed (filename/status/additions/deletions — **not patch text**, `actions.ts:708-713`), existing reviews, existing review comments (path/line/body), and check-run status.

**Write:** `github.create_comment` (`actions.ts:610-620`) — **issue-level only** (`POST /issues/{n}/comments`); `github.create_pull_request`, `update_pull_request`, `create_branch`, `merge_pull_request`; CI/Actions actions; Dependabot reads.

**Gap:** No action posts inline PR review comments. (§5.)

### 3.3 Webhook handling today (`routes/webhooks.ts`)
`POST /webhooks/github` (`webhooks.ts:63-124`): reads `X-GitHub-Event` + `X-Hub-Signature-256`, loads the App, verifies via `app.webhooks.verify(rawBody, signature)` against the D1 `appWebhookSecret`, then routes `installation` → `handleInstallationWebhook`, `pull_request` → `handlePullRequestWebhook`, `push` → `handlePushWebhook`. Unhandled events are only logged (explicit TODO at `webhooks.ts:116` to route them to the org orchestrator).

Current `pull_request` handling (`services/webhooks.ts:220-274`) only **updates `session_git_state` for sessions already linked to that PR** and notifies their DOs. It does **not** start any review session.

The triggers plugin has its own correct HMAC verifier `githubTriggers.verifySignature` (`triggers.ts:25-57`, constant-time compare) and `parseWebhook`, used by the generic workflow-trigger path; it lists `pull_request`, `issue_comment`, `pull_request_review` among event types (`triggers.ts:3-16`).

### 3.4 The current blocker: webhooks fail with "Missing or invalid authentication"
Diagnosed in §4. Root cause is a **path mismatch**, not the secret.

---

## 4. The Webhook-Auth Fix (Work Item 1)

### 4.1 Root cause
The error string `Missing or invalid authentication` is thrown by `authMiddleware` (`middleware/auth.ts:46`) when no valid bearer/session/API-key token is present.

The App manifest registers the delivery URL as:
```
hook_attributes.url = `${workerUrl}/api/webhooks/github`   // admin-github.ts:158
```
But the webhook router is mounted at **`/webhooks`** (`index.ts:169`), and `authMiddleware` is applied to **`/api/*`** (`index.ts:195`). **There is no `/api/webhooks` mount anywhere** (verified: grep for `api/webhooks` returns only the manifest string).

So GitHub `POST`s to `/api/webhooks/github` → matched by `app.use('/api/*', authMiddleware)` → GitHub sends no `Authorization` header → 401 "Missing or invalid authentication" **before** the signature-verifying handler at `/webhooks/github` is ever reached. The `integrations` spec documents the handler as `/webhooks/github` (`integrations.md:234, :372`) — the manifest URL is the bug, the handler path is correct.

### 4.2 Ruling out the usual suspects
- **Missing `GITHUB_WEBHOOK_SECRET` env var:** Not the cause. The secret is the `appWebhookSecret` minted by GitHub during manifest conversion and stored in D1 (`admin-github.ts:321`; read at `github-app.ts:106`), not an env var. If the secret were wrong, the error would be `{error:'Invalid signature'}` from `webhooks.ts:81-82`, **not** "Missing or invalid authentication".
- **Signature header name:** Handler reads `X-Hub-Signature-256` (`webhooks.ts:66`) — matches GitHub's SHA-256 header. Correct.
- **Body parsing before HMAC:** Correct — `rawBody` via `c.req.raw.clone().text()` (`webhooks.ts:72`) before `JSON.parse`; verify runs on the raw string.

### 4.3 The fix
- **Option A (preferred — one line):** Change `admin-github.ts:158` to `${workerUrl}/webhooks/github` so deliveries hit the public, signature-verifying router.
- **Option B (rejected):** Mount a webhook router under `/api/webhooks` *and* exempt it from `authMiddleware` — more surface area, easy to mis-exempt, not recommended.

**Signature verification (unchanged, confirmed correct):** the dedicated `/github` handler verifies `app.webhooks.verify(rawBody, signature)` over the cloned raw body using the D1-stored `appWebhookSecret`. We keep this exactly; we only change where GitHub delivers. (Note: `integrations.md:240` flags a separate caveat that *generic*-path verification re-serializes the payload; the dedicated `/github` handler does **not** — it verifies raw body, so no change there.)

### 4.4 Migration (mandatory)
The manifest URL is baked in at App-creation time. **Already-installed Apps keep the broken `/api/webhooks/github` URL** until manually updated. Ship a runbook step: GitHub → App settings → Webhook → set URL to `${workerUrl}/webhooks/github`. Add this to the rollout checklist (§12).

### 4.5 Regression test (mandatory)
The manifest URL and the route mount live in **different files** and silently drifted. Add a test asserting `manifest.hook_attributes.url` resolves to a **mounted, unauthenticated** webhook route (i.e., ends in `/webhooks/github`, and `/webhooks/*` is not under `authMiddleware`). This is the test that would have caught the original bug.

**Route-ordering note (no change needed):** `webhooksRouter.all('/*')` (`webhooks.ts:14`) is declared before `post('/github')` (`webhooks.ts:63`), but the catch-all `return next()`s for hardcoded integration paths including `github` (`webhooks.ts:20-23`), so the dedicated `/github` handler still wins.

---

## 5. New Action: `github.create_review` (Work Item 2)

Today's only comment action is `github.create_comment` → `POST /issues/{n}/comments` (issue-level, `actions.ts:613`). Inline review comments need a new action.

**`github.create_review`** → `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`:
```ts
params: {
  owner: string;
  repo: string;
  pullNumber: number;
  event: 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE';
  body?: string;                       // overall summary
  comments?: Array<{
    path: string;
    line?: number;                     // line in the diff (new side)
    side?: 'LEFT' | 'RIGHT';           // default RIGHT (added/changed lines)
    start_line?: number;               // for multi-line comments
    body: string;
  }>;
  commitId?: string;                   // pin review to head SHA
}
```
Batching all findings into **one review** (vs N `create_review_comment` calls) avoids N notifications — this matches the Slopless single-batched-review model.

**Optional companion:** `github.create_review_comment` → `POST .../pulls/{n}/comments` for single threaded replies (needed for v2 thread replies; defer unless the reviewer needs to reply to a specific human comment).

**Diff/anchoring support — extend `inspect_pull_request`:** Inline comments require precise line/position anchors, but `inspect_pull_request` returns file names without patch text (`actions.ts:708-713`). Add an opt-in `includePatch?: boolean` param that includes per-file `patch` (from `GET .../pulls/{n}/files`, which already returns `patch`). Alternative for large diffs: the review session computes anchors from the cloned working tree + `git diff` (the sandbox already has the PR branch checked out). v1 default: agent anchors from the cloned tree; `includePatch` is the fallback for small diffs / when no clone is available.

**Un-anchorable findings — GitHub 422 fallback (don't drop them):** GitHub returns `422` for a review comment whose `line`/`side` doesn't fall on the PR's diff (also for deleted-file or binary paths). The reviewer must **not** silently drop such findings: any finding that can't be placed inline is **appended to the review `body`** as a `path:line — <finding>` list. Submit inline comments + body in the single `create_review`; on a partial `422`, retry once with the offending comment(s) demoted to the body. (This degraded "everything in one comment body" mode is, notably, the *only* thing Slopless ever did — so it's a safe floor, not a regression.)

**Wiring (per CLAUDE.md "Adding a plugin action"):** add `createReview` to `allActions` (`actions.ts:461`), add a `PERMISSION_HINTS` entry (`actions.ts:497`) → `'github.create_review': 'pull_requests:write'` (already granted), define the Zod params schema, implement the `case`, then run `make generate-registries`.

---

## 6. Architecture: End-to-End Flow

```
GitHub: PR opened / synchronize / reopened / ready_for_review
        │  (X-GitHub-Event: pull_request, X-Hub-Signature-256, X-GitHub-Delivery)
        ▼
[FIXED] POST /webhooks/github            routes/webhooks.ts:63   (public, NOT /api/*)
        │  app.webhooks.verify(rawBody, signature)  ← D1 appWebhookSecret  (webhooks.ts:80)
        ▼
   event === 'pull_request' && action ∈ {opened,synchronize,reopened,ready_for_review}
        │  + repo opted-in?  + head-SHA not already reviewed?  (review_runs dedup)
        ▼
[NEW] dispatchReviewSession()            services/webhooks.ts (new branch)
        │  reuses handleGenericWebhook job-launch shape (webhooks.ts:163-216):
        │    createWorkflowSession(purpose='workflow')  +  createExecution(idempotencyKey=delivery-id)
        ▼
   enqueueWorkflowExecution()            services/executions.ts:87  → WORKFLOW_EXECUTOR DO /enqueue (retry/backoff)
        ▼
   WorkflowExecutorDO                    durable-objects/workflow-executor.ts
        │  buildSandboxEnvVars() injects GITHUB_TOKEN, REPO_URL, REPO_BRANCH(=PR head), git identity  (:308-347)
        │  → SESSIONS DO /start  (boots Modal sandbox)
        ▼
   Review session (sandbox + Runner + OpenCode, "code reviewer" persona)
        │  1. git clone PR head (env already set) ; git diff origin/<base>...HEAD
        │  2. github.inspect_pull_request (existing reviews/comments — avoid dup) [+ includePatch fallback]
        │  3. agent reasons over changed hunks → findings[] (path,line,severity,suggestion,confidence)
        │  4. filter: only changed lines, dedup vs existing, confidence ≥ threshold
        ▼
[NEW] github.create_review  (event=COMMENT|REQUEST_CHANGES, comments[], body=summary)
        ▼
   GitHub PR: one batched review with inline, line-anchored comments
        ┊
        ┊  (v2) human clicks "fix" / approves plan
        ▼
   Fix session  → reads comments via inspect_pull_request → [approval gate] → edit/commit/push
                → github.create_pull_request / push to PR branch
```

### Step → concrete Valet component map
| Step | Component(s) | File |
|---|---|---|
| Ingress + signature verify | `webhooksRouter.post('/github')` | `routes/webhooks.ts:63-124` |
| PR-event → review dispatch (**new**) | new branch calling a `dispatchReviewSession` service | `services/webhooks.ts` |
| Job launch (session + execution + enqueue) | reuse `handleGenericWebhook` shape | `services/webhooks.ts:163-216`, `executions.ts:87` |
| Sandbox boot + env injection | `WorkflowExecutorDO.buildSandboxEnvVars` | `durable-objects/workflow-executor.ts:308-347` |
| Session prompt dispatch | `SESSIONS` DO `/start` / `/prompt` (`initialPrompt`) | `session-agent.ts:597` |
| Read PR + existing reviews | `github.inspect_pull_request` | `actions.ts:651-735` |
| Post review (**new**) | `github.create_review` | `actions.ts` (new case) |
| In-session credentials | `githubCredentialResolver` / `assembleRepoEnv` | `resolvers/github.ts:31`, `env-assembly.ts:329-345` |
| Approval gate (v2) | workflow `waiting_approval` + `resumeToken` | `workflows.md:199-201, 319-331` |

### Dispatch identity decision
Per the 2026-06-29 sync, the review runs as a **plain ("vanilla") session — not an orchestrated/orchestrator thread** (a single PR review isn't compute-heavy enough to justify orchestration). It still needs the sandbox env-wiring the workflow-execution path provides today — `GITHUB_TOKEN` + `REPO_URL/BRANCH/REF` via `buildSandboxEnvVars`, delivery-id idempotency, concurrency caps — with `REPO_BRANCH`/`REPO_REF` pinned to the **PR head** so the sandbox clones the PR branch. **The exact session-launch interface is gated on the workflows interpreter (#43):** when it lands, the dispatch path may simplify, so **don't lock this until then.** (An earlier draft recommended the workflow-execution path outright; the sync narrowed it to "vanilla session, dispatch interface TBD post-workflows.") The remaining identity question is the *initiator* for org installs — see Open Questions.

---

## 7. New vs. Reused Components

| Component | New / Reuse | Notes |
|---|---|---|
| Manifest webhook URL (`/webhooks/github`) | **Fix** | `admin-github.ts:158` one-line + migration runbook |
| Manifest↔route regression test | **New** | §4.5 |
| `github.create_review` action | **New** | §5; register + `make generate-registries` |
| `inspect_pull_request` `includePatch` | **Extend** | §5; per-file `patch` |
| `pull_request` → review-session dispatch | **New** | branch in `/webhooks/github` + `dispatchReviewSession` |
| Per-repo review opt-in toggle | **New** | admin setting + `review_configs` (or reuse org settings) |
| `review_runs` table (dedup/audit) | **New** | §8 |
| "Code reviewer" persona/skill | **New** | content plugin `packages/plugin-*/personas|skills` |
| Review prompt contract | **New** | §10 |
| Webhook ingress + signature verify | **Reuse** | `webhooks.ts:63-124` |
| Job launch (session+execution+enqueue) | **Reuse** | `webhooks.ts:163-216`, `executions.ts:87` |
| Sandbox env injection (`GITHUB_TOKEN`, repo) | **Reuse** | `workflow-executor.ts:308-347` |
| Installation-token minting (fix loop clone/push) | **Reuse** | `github-app.ts:129-195`, `env-assembly.ts:329-345` |
| Credential resolver | **Reuse** | `resolvers/github.ts:31-97` |
| Concurrency / idempotency | **Reuse** | `checkWorkflowConcurrency`, delivery-id key |
| Approval gate (v2) | **Reuse** | `workflows.md:319-331` |
| Runner workflow interpreter (tool + agent steps) | **Reuse (optional)** | `runner/src/workflow-engine.ts:64` |

---

## 8. Data Model / Persistence

One new table (migration `NNNN_review_runs.sql`, Drizzle schema in `src/lib/schema/review-runs.ts`, helpers in `src/lib/db/review-runs.ts`, types in `packages/shared/src/types/index.ts` — per CLAUDE.md "Adding a D1 table").

### `review_runs`
| Column | Type | Notes |
|---|---|---|
| `id` | text PK | uuid |
| `repo_full_name` | text NOT NULL | `owner/repo` |
| `pr_number` | int NOT NULL | |
| `head_sha` | text NOT NULL | dedup anchor — one review per (repo, pr, head_sha) |
| `delivery_id` | text NOT NULL | `X-GitHub-Delivery` — idempotency on webhook retries |
| `execution_id` | text | FK → workflow execution |
| `session_id` | text | review session |
| `status` | text NOT NULL | `pending`/`running`/`posted`/`skipped`/`failed` |
| `verdict` | text | `COMMENT`/`REQUEST_CHANGES`/`APPROVE` |
| `comment_count` | int | inline comments posted |
| `error` | text | failure detail |
| `created_at` / `updated_at` | text | ISO |

**Indexes:** `UNIQUE(delivery_id)` (retry idempotency); `UNIQUE(repo_full_name, pr_number, head_sha)` (don't double-review the same head on a `synchronize` retry / re-delivery).

**Dedup logic:**
1. On ingress, if `delivery_id` exists → return `{deduplicated:true}` (reuse the existing execution-row idempotency pattern from `createExecution`'s `idempotencyKey`).
2. Before dispatch, if a `posted`/`running` row exists for `(repo, pr, head_sha)` → skip (a push that produces no new commit, or a redelivery). New commits produce a new `head_sha` → new review.

**Per-repo opt-in:** a `review_enabled` flag — either a small `review_configs(repo_full_name, enabled, severity_floor, max_comments)` table or fields on the existing org/installation settings. Default **off** (opt-in).

---

## 9. The "Valet Fixes Its Own Review Comments" Loop (v2)

Reuses the same rails — no new infra.

1. **Trigger:** human clicks a "Valet fix" button/label on the PR, or (if `pull_request_review` events are added to default events, `admin-github.ts:146`) a `REQUEST_CHANGES` review fires it.
2. **Read comments:** the fix session calls `github.inspect_pull_request` (returns reviews + review comments with path/line/body, `actions.ts:714-724`).
3. **Plan (spec-driven gate):** the fixer drafts a **plan/spec comment** describing intended changes, then **halts on an approval gate**. Use the existing workflow approval mechanism: engine hits an `approval` step → `status='waiting_approval'` + `resumeToken` on the execution row (`workflows.md:199-201, 319-331`); on approval, `/resume` replays and continues (`workflows.md:274`). Alternatively, the human gate is a GitHub PR "approve" event. **No new approval mechanism is built.**
4. **Implement:** on approval, the session already has a usable `GITHUB_TOKEN` + `REPO_URL` (workflow path: `workflow-executor.ts:333-345`; general sessions: `assembleRepoEnv`/`mintInstallationToken`, `env-assembly.ts:329-345`). It clones, branches, edits, commits, pushes.
5. **Open/update PR:** `github.create_pull_request`, or push to the same PR branch.

**Loop safety (critical):** the fixer must **not** trigger a new review on its own push. Guard: when dispatching reviews (§6), skip if the PR head commit author/committer is the Valet bot identity (`GIT_USER_*` from `buildSandboxEnvVars`), and/or tag fixer pushes with a marker the review dispatcher recognizes. Combined with per-head-SHA dedup, this prevents an infinite review↔fix loop.

---

## 10. Review Prompt / Agent Design

The reviewer is an OpenCode agent session with a **"code reviewer" persona** (content plugin) and the review prompt as `initialPrompt`.

### What it reads
- The unified diff: `git diff origin/<base>...HEAD` from the cloned PR head (sandbox already checked out via `REPO_BRANCH`).
- PR metadata + existing reviews/comments via `github.inspect_pull_request` (to avoid re-posting and to respect prior human verdicts).
- Surrounding context: it may `read_repo_file` / open files in the working tree to understand callers and types — but findings are restricted to changed lines.

### Deterministic pre-scan (priming)
Before the model call, a cheap regex pass over the **added lines only** (lines starting with `+`, tracking absolute line numbers from the `@@` hunk headers) flags the obvious high-signal classes — hardcoded secrets, SQL/command injection, SSRF, path traversal, missing-auth — plus a check for whether the PR touches files that carry **prior known findings**. These are injected into the prompt as **hints, not auto-posted findings** (the model still decides and must still cite/anchor). Cheap, deterministic, and raises recall on the obvious classes at no extra model cost. (Lifted from Slopless's `_scan_for_patterns` / `_check_known_vulnerabilities`, which seed its prompt the same way.)

### Severity rubric (mirrors the Slopless model)
| Severity | Definition | Maps to |
|---|---|---|
| **Blocker** | Correctness bug, security issue, data loss, breaking change | `REQUEST_CHANGES` |
| **Major** | Likely bug, missing edge case, perf regression on a hot path | `REQUEST_CHANGES` if confident, else `COMMENT` |
| **Minor** | Readability, naming, small refactor, missing test | `COMMENT` |
| **Nit** | Style/preference | suppressed unless explicitly enabled |

Overall **event**: `REQUEST_CHANGES` if any Blocker (or confident Major); else `COMMENT`; `APPROVE` only when explicitly enabled per-repo (default: never auto-approve).

### Inline comment format (actionable, not hand-wavy)
Each comment targets `{path, line, side:'RIGHT'}` and contains:
- One-line **what & why** (the concrete failure mode, not "consider improving").
- A **suggestion block** using GitHub's ```` ```suggestion ```` syntax when a mechanical fix exists, so the human can one-click apply.
- A **severity tag** and a short rationale.

Every finding cites the exact `path:line` it anchors to — no findings without a citation (the Slopless "no hand-wavy findings" rule).

### Noise controls
- **Only changed lines:** drop any finding whose anchor isn't in the diff hunks.
- **Confidence threshold:** the agent emits a `confidence ∈ [0,1]` per finding; suppress below the per-repo floor (default 0.6). Blockers post regardless above a lower floor.
- **Dedup vs. existing:** skip a finding if an existing review comment already covers the same `path:line` (from `inspect_pull_request`).
- **Cap (output):** `max_comments` per review (default 20) — if exceeded, post the top-N by severity/confidence and summarize the rest in the review body.
- **Large-diff cap (input, cost bound):** cap the diff fed to the model — review at most N changed files / M hunks per pass (e.g. 30 files); when a PR exceeds that, review the highest-risk files first (pre-scan hits + change size) and note in the review body which files were not deep-reviewed. This is the *input* analogue of `max_comments`: without it a 200-file PR blows context/cost or silently under-reviews. (Slopless caps at 20 files × 3000 chars for exactly this reason.)
- **Batched:** all findings posted in **one** `github.create_review` call (single notification).
- **Attribution:** the review body clearly states it's an automated Valet review (the bot-token attribution suffix at `actions.ts:20-23` already appends "on behalf of"; ensure the persona/body makes the AI authorship unambiguous so it isn't mistaken for a human reviewer).

### Verification pass before `REQUEST_CHANGES`
This spec's verdict is **load-bearing** — `REQUEST_CHANGES` can gate a merge, unlike Slopless's cosmetic verdict — so a false Blocker costs more here than anywhere in Slopless, which ships single-pass with **no verification** on its PR path (its own paper flags false positives as the top unmeasured risk). Before emitting any merge-gating finding, run a **lightweight second-pass self-critique**: re-prompt (the same or a cheaper model) to adversarially confirm each Blocker / confident-Major against the diff — *"is this real, on a changed line, and not a false positive?"* — and demote or drop findings that don't survive. Scope it to the gating findings only (cheap); Minor/Nit comments post without it. This is the single highest-trust safeguard and the main thing Slopless lacks on its PR path; it directly protects reviewer trust in the bot.

---

## 11. Security & Permissions

- **Least privilege:** no new App scopes — `pull_requests:write` (already granted) covers `create_review`; `contents:write` (already granted) covers the v2 fix push. Do **not** add `pull_request_review` events until v2 needs them.
- **Who can trigger:** reviews are **opt-in per repo** (default off). Only org admins toggle a repo on. Webhook ingress is authenticated by HMAC signature (`app.webhooks.verify`), so only GitHub (holding `appWebhookSecret`) can dispatch a review.
- **Comment spam prevention:** per-head-SHA dedup + delivery-id idempotency (§8) + `max_comments` cap + single batched review (§10). `synchronize` on rapid pushes is debounced by per-head-SHA uniqueness — only the latest distinct commit gets reviewed (consider a short debounce window per PR head, Open Questions).
- **Infinite-loop prevention (v2):** the review dispatcher skips PR heads authored by the Valet bot identity, so the fixer's own pushes never re-trigger a review (§9).
- **Autonomous-fix containment:** the fixer has `contents:write` + `pull_requests:write` and can push code. The implement step is **gated behind explicit human approval** (workflow approval gate or PR approval event, §9) — no unreviewed AI commit lands on a branch without a human releasing the gate.
- **Attribution clarity:** every Valet review/comment is unmistakably labeled AI-authored to avoid confusion with human reviews.

---

## 12. Idempotency, Rate Limits, Failure Handling, Observability

- **Idempotency:** `X-GitHub-Delivery` is the idempotency key on the execution row (reusing the `createExecution` `idempotencyKey` pattern, `services/webhooks.ts:184`) **and** `UNIQUE(delivery_id)` on `review_runs`. Per-head-SHA uniqueness stops double-reviewing the same commit across redeliveries/`synchronize`.
- **Rate limits / concurrency:** reuse `checkWorkflowConcurrency` (counts `pending`/`running`/`waiting_approval`, `workflows.md:217`). Size a per-org review concurrency cap so PR bursts throttle gracefully instead of 429-ing; queued reviews dispatch via the existing executor retry/backoff (`executions.ts:87`). GitHub API rate limits are bounded by the batched single-review design.
- **Failure handling:** the webhook handler **always returns 200** (`webhooks.ts:122`) so GitHub doesn't retry-amplify; dispatch failures are recorded on `review_runs.status='failed'` + `error`. A failed review session is retried by the executor, not by GitHub redelivery.
- **Observability (tie into existing OTEL):** the Worker + DOs emit OpenTelemetry traces via `@microlabs/otel-cf-workers`; tracing is a no-op until `OTEL_EXPORTER_OTLP_ENDPOINT` is set (CLAUDE.md → `docs/observability.md`). Tag the review span with `repo_full_name`, `pr_number`, `head_sha`, `delivery_id`, `review_run_id`, `verdict`, `comment_count` (mirror the `setSessionAttributes` userId-tagging pattern at `index.ts:198-199`). Structured logs via `lib/log.ts` with the existing `[github webhook]` prefix.

---

## 13. Rollout Plan / Milestones

**M0 — Unblock ingress (no behavior change)**
- Fix manifest URL (`admin-github.ts:158`) → `/webhooks/github`.
- Add manifest↔route regression test (§4.5).
- Runbook: update existing installed Apps' webhook URL in GitHub settings.
- *Acceptance:* a GitHub redelivery to a configured App reaches the handler and returns `{received:true}`; the 401 "Missing or invalid authentication" no longer occurs for webhook deliveries.

**M1 — Posting primitive**
- Add `github.create_review`; extend `inspect_pull_request` with `includePatch`; register + `make generate-registries`.
- *Acceptance:* a manual session can post a batched inline review to a test PR; permission hint correct; typecheck + `make test` green.

**M2 — Review dispatch (event-driven, opt-in)**
- Add `pull_request` → `dispatchReviewSession` branch; `review_runs` table; per-repo opt-in toggle; idempotency + per-head-SHA dedup.
- Code-reviewer persona/skill + review prompt.
- *Acceptance:* opening a PR on an opted-in test repo produces one Valet review with line-anchored inline comments within N minutes; a `synchronize` redelivery does not double-review.

**M3 — Hardening / observability**
- OTEL span attributes, concurrency cap sizing, debounce, attribution polish, `max_comments` / confidence-floor config.

**M4 (v2, flagged) — Fix loop**
- Fix session + approval gate + bot-author loop guard. Add `pull_request_review` events only if reacting to human thread replies. Ships behind a per-repo flag, default off.

---

## 14. Acceptance Criteria & Test Plan

**Unit**
- Manifest↔route invariant test (M0) — the bug-catching test.
- `github.create_review` param schema validation; maps to `POST .../pulls/{n}/reviews` with `comments[]` + `event`; registered in `allActions` with a `PERMISSION_HINTS` entry.
- `inspect_pull_request` `includePatch` returns per-file `patch`.
- `review_runs` dedup: same `delivery_id` → `deduplicated`; same `(repo,pr,head_sha)` → skipped; new `head_sha` → new run.
- Noise filters: only-changed-lines, confidence floor, existing-comment dedup, `max_comments` cap.

**Integration** (extend `make test-webhooks`)
- Signed `pull_request.opened` to `/webhooks/github` (valid signature) → review dispatched; invalid signature → `{error:'Invalid signature'}` 401; unsigned to `/api/webhooks/github` is no longer the delivery target.
- `pull_request.synchronize` redelivery (same head) → no second review.
- Repo not opted-in → no dispatch.
- Loop guard: PR head authored by Valet bot → no review dispatched.

**E2E (manual / staging)**
- Opt-in a test repo; open a PR with a deliberate bug → Valet posts a `REQUEST_CHANGES` review with an inline comment + ```` ```suggestion ```` on the correct line; verdict reflects severity; AI authorship is unmistakable.
- (v2) Click fix → plan comment posted → approve gate → fix pushed; the fix push does **not** trigger a new review.

---

## 15. Open Questions for Reviewers

1. **Branch parity:** This was verified on `feat/usage-user-model-breakdown` (current checkout), not the expected `perf/memory-import-d1-batch-nomig`. Confirm the manifest-URL bug and route mount are identical on the intended target branch before M0 lands.
2. **Reproduction of the 401:** Confirm the observed failure body is `Missing or invalid authentication` (path/auth, this diagnosis) vs `Invalid signature` (secret/HMAC) — an already-created App could have a manually-corrected URL and a different (secret) failure.
3. **Batched vs threaded:** Single batched review (`create_review` alone) for v1, or also `create_review_comment` for individual threaded replies? Affects v1 scope.
4. **Review session identity:** Sync decided a **vanilla session (not an orchestrator thread)**; the open part is the *initiator* identity for org installs — the org orchestrator user (`orchestrator:org:{orgId}`, the documented home for "unattributed events + automation rules") vs a dedicated review-bot user. The exact session-launch path is pending the workflows interpreter (#43).
5. **Spec-driven gate (v2):** GitHub PR approval event, Valet workflow approval gate (`resumeToken`), or action-policy override (`docs/specs/2026-05-19-approval-policy-overrides-design.md`)? Different UX + audit trails — pick one.
6. **Event-driven vs cron sweep:** v1 is event-driven per PR webhook. Do we also want a scheduled cron sweep over open PRs (crons already configured, `wrangler.toml:69`) as a backstop for missed deliveries?
7. **Debounce window:** Beyond per-head-SHA dedup, do we want a short per-PR debounce on rapid `synchronize` bursts, or is head-SHA uniqueness sufficient?

---

### Key files referenced
- `packages/worker/src/routes/admin-github.ts:158` (manifest URL bug), `:138-146` (perms/events)
- `packages/worker/src/index.ts:169` (`/webhooks` mount), `:192` (`/github` public), `:195` (`/api/*` auth)
- `packages/worker/src/middleware/auth.ts:46` (blocker error)
- `packages/worker/src/routes/webhooks.ts:63-124` (handler), `:80` (verify), `:116` (TODO hook point)
- `packages/worker/src/services/webhooks.ts:163-216` (job launch), `:220-274` (current PR handler)
- `packages/worker/src/services/executions.ts:87` (enqueue)
- `packages/worker/src/durable-objects/workflow-executor.ts:308-347` (env injection)
- `packages/worker/src/services/github-app.ts:101-117, 129-195` (App + tokens)
- `packages/worker/src/lib/env-assembly.ts:329-345` (general-session token)
- `packages/worker/src/integrations/resolvers/github.ts:31-97` (credential resolver)
- `packages/worker/src/durable-objects/session-agent.ts:597` (`/prompt`)
- `packages/plugin-github/src/actions/actions.ts:610-620` (issue comment), `:651-735` (`inspect_pull_request`), `:461` (`allActions`), `:497` (`PERMISSION_HINTS`)
- `packages/plugin-github/src/actions/triggers.ts:3-16, 25-57` (event types, HMAC verifier)
- `packages/runner/src/workflow-engine.ts:64` (tool/agent steps)
- `docs/specs/integrations.md:234, :372` (handler is `/webhooks/github`)
- `docs/specs/workflows.md:199-201, 319-331` (approval gate / resume)
- `packages/worker/wrangler.toml:69` (crons)
