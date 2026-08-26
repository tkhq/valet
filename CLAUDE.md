# CLAUDE.md — Valet Development Guide

Do NOT add "Co-Authored-by" trailers mentioning AI models in commits, PRs, or comments.

## What this is

Valet is a hosted background coding agent platform. The current (v2) stack: `packages/api` (Hono on Node) hosts `@valet/engine` (portable agent loop over pi-agent-core); sessions run in sandboxes via pluggable providers (docker in dev, kubernetes in the helm deploy, local/virtual in tests); state lives in Postgres (`store-postgres` — embedded PGlite in dev); `packages/web` is the client. Per-user orchestrators are themselves full agent sessions.

The legacy stack (`packages/worker`/`client`/`runner`, `backend/`, Cloudflare + Modal) is frozen for the existing prod deploy and slated for deletion — don't build on it. Worker deploys pin commit `35b398e5`; `packages/worker` is excluded from root `pnpm typecheck` (check it in isolation if ever needed).

## The dev loop

```bash
corepack enable         # once per machine — provisions the pnpm pinned in package.json
                        #   (packageManager). No pnpm? `npm install -g pnpm` also works.
pnpm install
make dev-local          # api :8788 + web :5173 — needs ANTHROPIC_API_KEY + Docker
                        # VALET_LOCAL_AUTH=1 stub auth; embedded PGlite in ~/.valet/pg
```

### Start the local stack cleanly (one stack at a time)

The stack assumes ports 8788 (api) and 5173 (web) are free and that no other process owns `~/.valet/pg`. PGlite allows exactly one owner. A second api does not fail cleanly: it can lose the port race but keep running and hold the database.

1. Check the ports: `lsof -nP -iTCP:8788 -iTCP:5173 -sTCP:LISTEN`.
2. If a listener exists, find its checkout: `lsof -p <pid> | grep cwd`. A stack from another worktree serves stale code, so your changes do not appear in the UI.
3. If the old stack is stale, kill its listeners.
4. Confirm nothing still holds the database: `lsof +D ~/.valet/pg` must return nothing. An orphaned api process here makes the next api crash at startup.
5. Run `make dev-local`.
6. Confirm health: `curl -sf localhost:8788/api/health`. Startup is fast — if health is not ok within ~5 seconds, do not wait or poll. Read the log for one of the symptoms below.

Symptom → cause:

- Vite proxy `ECONNREFUSED /api/...` → the api is down (crashed, or it lost the port race to another stack).
- PGlite WASM `Aborted()` stack trace at api startup → another process owns `~/.valet/pg` (step 4).
- The UI does not show your changes → :5173 is served from a different checkout (step 2).

`make e2e` isolates its own state (scratch `VALET_DATA_DIR`, random ports 18790+), so it can run beside the dev stack — but Docker-heavy suites can flake from daemon contention while the dev stack's sandboxes run. If a Docker row goes red during concurrent work, re-run it in isolation before you treat it as real: `make e2e E2E_ARGS="--only <suite-id>"`.

While iterating:

```bash
pnpm typecheck                                  # all packages (worker excluded)
pnpm --filter @valet/<pkg> test [<filter>]      # targeted suites (NO "--" before the filter
                        #   - vitest drops args after "--" and runs the FULL suite)
make smoke-orchestrator                         # fastest agent-loop-alive check (real Anthropic, no Docker)
```

**Before calling any change finished, run `make e2e` and get a clean scorecard.** It loads `.env.e2e`, probes your daemons/creds, and runs every suite it can — this is THE validation, not an optional extra. Pre-existing environmental failures (dead keys, missing creds) are the only acceptable red rows, and you must be able to name why each one is unrelated to your change.

Capture the FULL `make e2e` output — never pipe it through `tail`, `head`, or `grep`. The scorecard is small, and a truncated capture drops the failing rows, which forces a full re-run just to see what failed. If you need the output later, use `make e2e 2>&1 | tee /tmp/e2e.log`.

```bash
make e2e                          # full scorecard
make e2e E2E_ARGS="--doctor"      # environment readiness (fresh machine)
make e2e E2E_ARGS="--only cli,typecheck --json"
make e2e-clean                    # sweep state leaked by crashed runs
```

Commit per discrete task, subjects ≤72 chars. When you modify a subsystem, update its spec in `docs/specs/` in the same commit.

## Writing (ASD-STE100)

All prose in this repo is technical writing: specs, READMEs, runbooks, error messages, PR text, code comments, UI copy. Write it to ASD-STE100 Simplified Technical English, adapted as follows.

Use strict STE for text that tells a reader what to do — procedures, runbooks, error messages, warnings:

- Put one instruction in each sentence. Keep instructions at 20 words or fewer. Keep descriptions at 25 words or fewer.
- Put a condition before the action it controls ("If the build fails, delete the cache", not the reverse).
- Use a numbered list for a sequence of steps.

Use STE-flavored prose for everything else — READMEs, specs, PR descriptions, release notes. Prefer short sentences, but vary length when it improves flow. In both modes:

- Use one name for one thing. Do not alternate between synonyms for the same component.
- Use short common words: "use" not "utilize", "start" not "commence", "show" not "demonstrate".
- Use active voice with a named actor. Use a verb for an action: "analyze the log", not "perform an analysis of the log". Keep passive voice only when the actor is unknown or irrelevant.
- Remove empty intensifiers ("seamless", "robust", "powerful"), fake transitions, and padded summaries. Every sentence must add information or direct an action.
- Keep caveats, warnings, and limitations. Never cut substance to make text shorter.
- Keep necessary technical terms. Define an unfamiliar term at first use.

Two repo-specific rules:

- **Every user-facing error message names the corrective action when one exists.** "Missing GitHub access token. Connect the GitHub integration in Settings." is the model. A bare fact ("expected an array response") is incomplete when the user can act.
- **Terminology:** "workspace" is overloaded — `SessionData.workspace` is a display label, `/workspace` is the in-sandbox path, workspace prep is the clone subsystem, and in web UI copy a workspace is the nav switcher's scope: personal or a team (`docs/specs/2026-08-17-team-workspace-ui-design.md`). Say which one you mean. UI copy reserves "workspace" for the switcher scope and calls the in-sandbox path the "working directory". Spell the session start reference "start-ref" in prose and `startRef` in code.

`make e2e E2E_ARGS="--only docs-lint"` runs the STE lint (`scripts/docs/docs_lint.py`) over the maintained docs with per-file thresholds; CI runs the same script as a blocking check on every PR. The `ste-plain-writing` skill has the full ruleset and a linter (`python3 scripts/ste_lint.py <file>` from the skill directory). The linter is diagnostic, not certification — code blocks and deliberate style choices produce false positives.

CI also lints every PR description (`scripts/docs/pr_description_lint.py`, the "PR lint" workflow). Hard rules: not empty, no em/en dashes, no marketing words, no filler hedges, 300 words max (code blocks excluded). Fix the description and the check re-runs on edit.

This section governs new and edited prose. Do not rewrite existing documents wholesale for style alone. Apply the rules to the text you touch.

## Locked architecture decisions

1. **The engine is portable** — `@valet/engine` owns the loop, sessions, threads, queue, gates, persistence contracts. Nothing in it imports Hono or knows HTTP.
2. **Pluggable providers** — `SessionStore` and `SandboxProvider` swap behind engine contracts with shared conformance suites.
3. **REST is authoritative for thread history** — `GET /api/sessions/:id/messages`. The WS `init` event is metadata-only; never add messages back to it.
4. **Plugins self-describe** — one `ValetPlugin` manifest per `packages/plugin-*`, exported from `./plugin`; `make generate-registries` regenerates `packages/api/src/plugins/registry.gen.ts` from `plugin.yaml` (`v2: true`).
5. **Orchestrators are full agent sessions** — well-known id `orchestrator:{userId}`, spawning children through the same engine APIs.
6. **Auth is better-auth** — email/password + optional OIDC; `VALET_LOCAL_AUTH=1` is the dev stub (see `docs/specs/2026-07-14-auth-v2-design.md`).

## Rules learned the hard way

### Tool-call persistence round trip

We've broken tool-call rendering on reload three times; the root cause is always shape drift between what the engine writes, the wire ships, and the frontend renders. When touching any hop, verify all four end to end:

1. Engine writes: `Thread.handleAgentEvent` (`packages/engine/src/thread.ts`). Any part mutation after `message_end` MUST be re-persisted via `updateEntry` or the DB row sticks pre-mutation.
2. Wire ships: `engineToWireParts` (`packages/api/src/engine/bridge.ts`). Treat tool `result` as `unknown` — pi-agent-core's shape ≠ the engine's own `ToolResult`.
3. REST reads: `entryToMessage` (`packages/api/src/routes/messages.ts`). If REST drops `parts`, the UI looks fine live and breaks on reload.
4. Frontend extracts: `resultText` (`packages/web/src/components/session/tool-renderers/types.ts`) must handle `{ text }`, pi-agent-core's `{ content: [{ type: "text", text }] }`, and bare `string`.

Regression suites (run before claiming done): `pnpm --filter @valet/engine test happy-path`, `pnpm --filter @valet/engine test in-memory-store`, `pnpm --filter @valet/store-postgres test`, and the api integration suite. If you change the result shape, assert the actual TEXT is reachable — `expect(result).toBeDefined()` is the exact bug we keep shipping.

"(empty output)" in the UI = shape mismatch, not lost data. Inspect `engine_entries.parts` directly: `psql` when `DATABASE_URL` is set; for dev PGlite, stop the api first (it owns `~/.valet/pg`), then from `packages/api` use plain `node --input-type=module` (NOT `tsx -e` — its eval mode rejects top-level await) with `@electric-sql/pglite` to query the data dir.

### Pre-1.0: edit migrations in place

Edit `packages/store-postgres/migrations/pg/0000_engine.sql` / `packages/api/migrations/pg/0000_app.sql` directly — do NOT add numbered migrations. App tables also update the Drizzle schema (`packages/api/src/schema/index.ts`); engine tables are raw SQL — update the row interfaces + `rawTo*Row` mappers in `packages/store-postgres/src/helpers.ts` (bigint ms columns funnel through `toNum`). After editing, `rm -rf ~/.valet/pg` is MANDATORY — the migration tracker skips an already-applied `0000` and there is no backfill path. This rule flips to numbered migrations at 1.0.

### Node & workspace traps

- Tests failing with `WebSocket is not defined` = the Node-20-vs-22 trap, not a regression. Re-verify under Node 22 (`nvm use 22`).
- Any package importing `ws` must declare BOTH `@types/ws` AND `@types/node` in its own devDependencies, or pnpm may resolve the wrong Node types from an ancestor `node_modules`.
- A new workspace dep edge can silently FORK a peer-dep'd "singleton" (e.g. `pi-ai`'s provider registry) into two copies. Symptom: a no-network test goes live, or module-level state stops being shared. Check `pnpm why <pkg>` for duplicate versions; fix by pinning via `overrides` in `pnpm-workspace.yaml` (see the `zod` pin). Do NOT use package.json's `pnpm.overrides` — pnpm 11 ignores that field and drops the pin silently.

### Sandbox gotchas

- The default dev sandbox image has no ttyd/code-server/gateway; point `VALET_SANDBOX_IMAGE` at an image built from `docker/Dockerfile.sandbox-k8s` to exercise the Terminal/VS Code tabs on the docker backend. On the k8s backend, `VALET_SANDBOX_IMAGE` must be registry-hosted (pushed to the bundled registry / NodePort pull host) because base bakes use it as their FROM ref via BuildKit — see `docs/specs/2026-08-02-sandbox-reconcile-design.md` Deviations.
- The engine no longer uses a `prepareSandbox` closure. Sandbox prep is declarative: an injected `SpecProvider` returns ordered `PrepStep[]`; `attachment.reconcile` converges them at each run-start window. The old `prebuild_configs`/`prebuilds` tables are replaced by `image_sources` + `bakes`. See `docs/specs/2026-08-02-sandbox-reconcile-design.md`.
- The in-sandbox gateway enforces `sid === VALET_SESSION_ID` from JWT claims — one session's JWT is rejected in another session's sandbox.
- `VALET_SANDBOX_IDLE_MINUTES` (default 30) only matters on the kubernetes backend; hibernation is a no-op elsewhere.
- **An api restart revokes running sandboxes' tokens without telling them**: on providers without a creds mount, cache rebuilds mint a fresh `VALET_SANDBOX_TOKEN` and revoke the old one, but nothing pushes the new value into a still-running sandbox — in-sandbox consumers (git-credential helper, `valet-gh`) 403 until the sandbox is recreated. The `credsMount`-capable providers (kubernetes Secret volume; docker host-dir bind mount) close this gap via the rotate sweep. See the GitHub integration design's Deviations section.

### Kubernetes context safety (binding)

The ambient `kubectl` context on this machine may point at a PRODUCTION GKE cluster. Every `make k8s-*` target pins `--context rancher-desktop` (`--kube-context` for helm). Never run bare `kubectl`/`helm` against this workflow — use the make targets or add the context flag yourself. `VALET_SANDBOX_BACKEND=kubernetes` is how the chart switches sandboxes to CRs; `make dev-local` stays on docker.

## Commands

```bash
make dev-local           # the v2 dev stack (see Dev loop above)
make e2e / e2e-clean     # canonical validation
make smoke-orchestrator  # agent loop alive (no Docker)
make smoke-session       # full session round-trip (Docker)
make generate-registries # regen plugin registry from plugin.yaml manifests
pnpm typecheck / pnpm test

# Kubernetes (local k3s / Rancher Desktop) — runbook: deploy/README.md
make k8s-sandbox-install # vendored agent-sandbox CRD/controller (run first)
make k8s-build / k8s-up / k8s-logs / k8s-down
```

Legacy-stack commands (worker/Modal/D1 deploys) live in the Makefile and `scripts/deploy.sh`; don't extend them.

## Structure & conventions

```
packages/
  api/              # Hono API: routes in src/routes/, engine wiring in src/engine/,
                    #   app schema in src/schema/, CLI in src/cli/ (pure run* fns)
  web/              # Vite + React 19 + TanStack Router/Query + Tailwind + Radix
                    #   routes in src/routes/, tool renderers are a registry
  engine/           # @valet/engine — the portable loop
  workflow/         # workflow DAG interpreter
  store-postgres/   # SessionStore (PGlite dev/test, node-postgres prod)
  sandbox-docker|kubernetes|local|gateway/
  shared/           # shared types (add cross-package entities here FIRST)
  sdk/              # integration/channel contracts, MCP client, UI components
  plugin-*/         # one package per integration/skill
  client|worker|runner/ + backend/   # FROZEN legacy
deploy/             # helm chart + vendored agent-sandbox controller
docs/specs/         # dated YYYY-MM-DD-*-design.md = v2 (current, maintain these);
                    #   undated = legacy-stack specs (accurate for frozen code only)
docs/plans/         # implementation plans
```

- Web tool renderers (`packages/web/src/components/session/tool-renderers/`) are a registry — new renderer file + list it before the fallback in `index.ts`.
- Optimistic UI messages must carry the active `threadId` (null + fallback matching leaked bubbles across threads).
- Superpowers design specs → `docs/specs/YYYY-MM-DD-<topic>-design.md`; plans → `docs/plans/YYYY-MM-DD-<topic>.md`.

### Type safety

1. No `any` — use real types, or `Record<string, unknown>` + narrowing.
2. No `as unknown as T` double-casts, ever. In tests, build the full shape.
3. Minimize `as` — prefer narrowing; legitimate uses (discriminated-union narrowing, bad third-party types) get a comment.
4. No `@ts-ignore`/`@ts-expect-error` — fix the type error.
5. Fix what you touch: leave every edited file cleaner than found.
6. If a test needs `(obj as any).privateMethod`, extract an exported pure function and test that instead.

### Adding a plugin (v2)

`packages/plugin-<name>/` with `plugin.yaml` (`v2: true`; `enabled: false` to park it) + `package.json` (`"valet": { "plugin": "./dist/plugin.js" }`, `./plugin` export, `@valet/engine` dep, sibling-matching scripts) + `tsconfig.json` referencing workspace deps. `src/plugin.ts` default-exports the `ValetPlugin` manifest — actions via `ActionPlugin`/`mcpActionPlugin`, skills/roles via `loadSkillFromMarkdown`/`loadRoleFromMarkdown`. Add to root `tsconfig.json` references and `packages/api/package.json` deps, then `make generate-registries` + `pnpm typecheck`.
