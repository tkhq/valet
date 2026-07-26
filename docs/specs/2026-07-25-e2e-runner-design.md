# Unified e2e entrypoint (`make e2e`) — design

**Date:** 2026-07-25
**Status:** Approved design, not yet implemented

## Purpose

Valet's real end-to-end coverage exists but is scattered across three gating
regimes with no front door: the `packages/api/src/integration/` vitest project
(each suite behind its own env-var gate), the `dogfood.ts` real-Anthropic+Docker
script, the T9 CLI suite (`VALET_CLI_E2E=1`), and per-backend sandbox suites in
`packages/sandbox-{local,docker,kubernetes}`. `make test` runs none of the
armed-with-real-creds paths; `make test-e2e` still points at the frozen legacy
worker.

This design adds a single orchestrating entrypoint — `make e2e` — so an agent
(or human) validating a v2 change can run one command, provide credentials once,
and get a per-feature scorecard of what passed, failed, or was skipped and
exactly which credential would arm each skipped row.

v1 wraps existing suites; the only new test code is two small smoke scripts and
a shared full-stack scenario driver.

## The runner

`scripts/e2e.ts` at the repo root, run via `tsx`, invoked by `make e2e`.

- **Env loading:** sources `.env.e2e` from the repo root if present (ambient
  env always wins, so exported vars and CI work without the file). A committed
  `.env.e2e.example` documents every variable by tier. `.env.e2e` is
  gitignored. The runner never prints secret values — only variable names.
- **Prerequisite probes (once, up front):** Docker daemon reachable; kubectl
  context `rancher-desktop` exists; which credential vars are set. Probes are
  cheap and read-only.
- **Execution:** each step runs as a child process (pnpm/vitest/tsx/make),
  sequentially (several steps contend for Docker and ports; parallelism is a
  later optimization). Per-step timeout; a step's stdout/stderr is captured
  and replayed only on failure (or with `--verbose`).
- **Flags:** `--json` (machine-readable scorecard, mirrors the CLI
  convention), `--only <step>[,<step>…]` (run a subset), `--list` (print steps
  + armed state without running), `--verbose`.
- **Exit code:** nonzero iff any *armed* step failed. Skipped steps never fail
  the run.

## Steps (the scorecard rows)

A coverage audit (2026-07-25) found that root `pnpm test` runs only four vitest
projects (`shared`, `sdk`, `api`, `web`); `engine`, `workflow`,
`store-postgres`, `sandbox-gateway`, `runner`, and all `plugin-*` packages are
reachable only via `pnpm --filter <pkg> test`, and several Docker/cluster-gated
suites live outside `src/integration`. The scorecard therefore includes them
explicitly — the goal is that anything that could break during a v2 change has
a row, so `make e2e` is sufficient validation on its own (it does not assume
`pnpm test` was run separately).

**Static + unit (always armed, no external deps):**

| Step | Wraps |
|---|---|
| `typecheck` | root `pnpm typecheck` (all packages except frozen `worker`) |
| `unit` | root `pnpm test` (`shared`, `sdk`, `api`, `web` projects) |
| `engine-unit` | `pnpm --filter @valet/engine test` — store contract, compaction, gates, signals, kill-mid-turn, model switching |
| `workflow-unit` | `pnpm --filter @valet/workflow test` — DAG interpreter, node executors, expression eval, checkpoints |
| `gateway-unit` | `pnpm --filter @valet/sandbox-gateway test` — sandbox JWT mint/verify, WS proxy |
| `runner-unit` | `pnpm --filter @valet/runner test` |
| `plugins-unit` | `pnpm --filter './packages/plugin-*' test` — telegram/slack/github/google-* action + transport tests |
| `sandbox-local` | `packages/sandbox-local` test suite |

**Integration + smoke:**

| Step | Wraps | Armed when |
|---|---|---|
| `integration-core` | keyless tests in `packages/api/src/integration` (auth, memory routes, session filters, GitHub-fixture loop, events webhook) | always |
| `orchestrator-smoke` | **new** `packages/api/scripts/smoke-orchestrator.ts` | `ANTHROPIC_API_KEY` |
| `session-smoke` | `packages/api/scripts/smoke-session.ts` (renamed from `dogfood.ts`) | key + Docker |
| `integration-agent` | key-gated integration suites (orchestrator lifecycle/loop, cross-thread, plugins, workflow-run) | key (+ Docker for workflow-run) |
| `cli` | T9 `cli.e2e.test.ts` with `VALET_CLI_E2E=1` | always; real-turn subtests need key |

**Docker / cluster-gated suites:**

| Step | Wraps | Armed when |
|---|---|---|
| `sandbox-docker` | `packages/sandbox-docker` test suite | Docker |
| `sandbox-k8s` | `packages/sandbox-kubernetes` `*.cluster.test.ts` (conformance, provider, exec) | `rancher-desktop` context |
| `store-postgres` | `make test-pg` — real `postgres:17` conformance + api `pg-store`/`credential-store` suites | Docker |
| `workspace-prep-docker` | `packages/api/src/engine/workspace-prep*.docker.test.ts` — git checkout, credential helper, prebuilt-image fetch against a real sandbox | Docker |
| `prebuilds-docker` | `packages/api/src/integration/prebuilds.e2e.test.ts` — real `docker build` → fetch-on-start | Docker |
| `k8s-builder-cluster` | `packages/api/src/prebuilds/k8s-builder.cluster.test.ts` — in-cluster image build via bundled registry | context + registry present |

**Full stack:**

| Step | Wraps | Armed when |
|---|---|---|
| `fullstack-docker` | **new** full-stack scenario against a spawned `valet serve` (docker backend) | key + Docker |
| `fullstack-k8s` | **new** full-stack scenario against the helm deployment on rancher-desktop | key + context + `VALET_E2E_K8S=1` |

**Live external integrations:**

| Step | Wraps | Armed when |
|---|---|---|
| `telegram` | live outbound `telegram.e2e.test.ts` | `TELEGRAM_TEST_BOT_TOKEN` + `TELEGRAM_TEST_CHAT_ID` |
| `github-live` | live GitHub App block in `github-repo.e2e.test.ts` | `VALET_GITHUB_LIVE_TEST=1` + app id + private key PEM |
| `openai` | `llm-providers.e2e.test.ts` | `OPENAI_API_KEY` |

Step names are stable identifiers (used by `--only` and the JSON output).
Note: several docker-gated suites self-skip when `CI` is set
(`workspace-prep.docker`, `prebuilds.e2e`) — the runner is local-first, so this
is fine, but it must not set `CI` itself.

## New test code

### `smoke-orchestrator.ts` (packages/api/scripts/)

Fastest "is the agent loop alive" check. Modeled on the existing smoke script:
boot the app in-process (fresh PGlite, virtual/no sandbox — the orchestrator is
a sandbox-less wake), ensure the orchestrator session, send one prompt, follow
the WS until the turn settles, assert a non-empty assistant reply. Exit 0/2/3
like `smoke-session`. Requires only `ANTHROPIC_API_KEY`.

### `smoke-session.ts` (rename of `dogfood.ts`)

Content unchanged in v1 beyond the rename: real API in-process + real Docker
sandbox, create session, "write hello.txt then read it back", assert the file
landed on the bind mount. Renames ripple to: package script `dogfood` →
`smoke:session`, Makefile `dogfood-api` → `smoke-session` (old target removed,
no alias — pre-1.0), and every doc that mentions `dogfood` (CLAUDE.md,
deploy/README.md, Makefile comments).

### `fullstack-scenario.ts` (scripts/e2e/)

A client-side scenario driver shared by both full-stack steps so they cannot
drift: given `{ baseUrl, apiKey }`, it (1) health-checks, (2) creates a
session, (3) sends a prompt instructing the agent to write a marker file and
report back, (4) follows the WS to settle, (5) asserts the assistant's reply
via `GET /messages`. It talks only the public HTTP/WS surface — the same wire
contract the web client and CLI use.

- **`fullstack-docker`:** the runner spawns a real `valet serve` child
  (docker sandbox backend, fresh data dir, random port, stub local auth),
  waits for `/api/health`, runs the scenario, kills the child. Unlike
  `session-smoke` (in-process app), this exercises the real server boot path,
  config/env handling, and the wire surface end to end.
- **`fullstack-k8s`:** ensures the vendored sandbox controller
  (`make k8s-sandbox-install`), ensures images (`make k8s-build` only when the
  `valet-api:dev`/`valet-sandbox:dev` images are absent — a cold build is
  15–20 min, which is why this step additionally gates on
  `VALET_E2E_K8S=1`), deploys via `make k8s-up`, port-forwards
  `svc/valet-api` on a random local port, runs the same scenario (sessions
  become Sandbox CRs + pods), then tears down the port-forward. It leaves the
  helm release installed (matching `make k8s-down` semantics being a separate,
  deliberate step). **Every kubectl/helm invocation pins
  `--context rancher-desktop`** — the ambient context on this machine can be a
  production cluster and must never be touched.

## Secrets file

`.env.e2e.example` (committed):

```
# ── Tier: agent (arms orchestrator-smoke, session-smoke, integration-agent,
#            cli real-turn tests, fullstack-*) ────────────────────────────
ANTHROPIC_API_KEY=

# ── Tier: optional providers ──────────────────────────────────────────────
OPENAI_API_KEY=

# ── Tier: telegram (live outbound delivery) ───────────────────────────────
TELEGRAM_TEST_BOT_TOKEN=
TELEGRAM_TEST_CHAT_ID=

# ── Tier: github-live (real GitHub App) ───────────────────────────────────
VALET_GITHUB_LIVE_TEST=
VALET_GITHUB_LIVE_APP_ID=
VALET_GITHUB_LIVE_APP_PRIVATE_KEY_PEM=

# ── Tier: k8s full stack (also needs rancher-desktop kubectl context) ─────
VALET_E2E_K8S=
```

## Scorecard

Human output: one line per step — `✓ passed (12.3s)`, `✗ failed`, or
`⊘ skipped — set ANTHROPIC_API_KEY` — followed by totals and the exit code
rationale. Failed steps replay their captured output above the scorecard.

`--json` output: `{ steps: [{ name, status: "passed"|"failed"|"skipped",
durationMs, skipReason? }], passed, failed, skipped, exitCode }`.

## Error handling

- A step timing out counts as failed (timeout noted in the scorecard).
- Probe failures downgrade steps to skipped with the probe named (e.g.
  `⊘ skipped — Docker daemon not reachable`), never crash the runner.
- Ctrl-C kills the current child process group and prints the partial
  scorecard.
- The runner refuses to start if `.env.e2e` exists but is unreadable/harbors
  parse errors, rather than silently running a weaker tier.

## Known blind spots (no tests exist to wrap)

Subsystems with zero automated coverage today — candidates for new test code in
later iterations, recorded here so the scorecard's green doesn't overstate:

- Sandbox tunnels (`plugin-sandbox-tunnels`) and personas
  (`plugin-personas`) — no test files.
- better-auth OIDC/Keycloak — unit-tested config only; the live SSO path is
  manual via `make dev-keycloak`.
- The `valet mcp` server actually serving tools to an MCP client — only unit
  tests around the pieces.
- Web browser e2e — 60 jsdom component tests exist, zero browser-driven.
- Most content-only / thin plugin packages (`plugin-browser`, `plugin-notion`,
  `plugin-sentry`, `plugin-stripe`, …) — no test files.
- Worker (`packages/worker`) is frozen and excluded from root typecheck; if a
  change touches `shared`/`sdk`, `cd packages/worker && pnpm typecheck` is a
  manual follow-up (CLAUDE.md rule), not a scorecard row.

## Out of scope (v1)

Recorded so they don't get lost:

- Web (Playwright/browser) e2e — no browser coverage exists at all today.
- A `valet handoff` e2e scenario in the T9 suite.
- The T9 suite's self-documented gaps: real-auth login/logout, `gates resolve`
  round-trip, human-mode `send`.
- Inbound Telegram (manual-only today).
- Parallel step execution.
- CI wiring — this is a local-first tool; CI keeps its existing per-suite
  gating.
