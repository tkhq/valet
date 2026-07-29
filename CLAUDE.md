# CLAUDE.md — Valet Development Guide

NOTE: Do NOT add "Co-Authored-by" trailers mentioning AI models (e.g., Opus, Claude) in commit messages PRs, or comments.

## Working on this codebase

Read this section first. Everything below it is project context; this section is rules learned the hard way.

### Tool-call persistence is fragile — verify the round trip

We've broken tool-call rendering on reload three times in a row. Each break looked different on the surface but had the same root cause: the persisted state in `engine_entries` and the rendered state in the UI were out of sync. The class of bug is **persistence shape drift between (a) what the engine writes, (b) what the wire layer ships, and (c) what the frontend renders**.

When you touch any of these, verify the *full* round trip ends-to-end, not just one hop:

1. **Engine writes the entry**: `Thread.handleAgentEvent` in `packages/engine/src/thread.ts` is the canonical persistence path. `message_end` calls `appendEntries`; `tool_execution_end` mutates `part.status`/`part.result` and calls `updateEntry`. If a tool ever changes a part *after* `message_end`, that mutation must be re-persisted, or the DB row stays stuck on the pre-mutation state.
2. **Wire bridge ships the entry**: `packages/api/src/engine/bridge.ts` `engineToWireParts` maps `MessagePart` to the wire shape. The wire `tool_call` part carries `args`, `result`, `status`, `error`, `callId`. **Treat `result` as `unknown`** on both ends — engine stores whatever the tool / pi-agent-core emits, which is *not* always the same shape as the engine's own `ToolResult` (`{ text, attachments? }`).
3. **REST `/messages` reads the entry**: `packages/api/src/routes/messages.ts` `entryToMessage` uses `engineToWireParts`. WS `init` no longer carries messages — REST is authoritative for thread history. If REST drops `parts`, the UI will look fine live and break on reload.
4. **Frontend extracts displayable text**: `packages/web/src/components/session/tool-renderers/types.ts` `resultText` must handle every shape the engine might persist:
   - `{ text: string }` — engine's own `ToolResult` shape
   - `{ content: [{ type: "text", text: string }, …] }` — pi-agent-core's `AgentToolResult` shape (what gets persisted today via `tool_execution_end`)
   - bare `string` — defensive

### When you change tool plumbing, run these tests

These exist specifically to catch persistence-shape regressions. Run them before claiming the work is done:

```bash
# Engine-level: persisted entry has tool_call with status="completed" + actual result content
pnpm --filter @valet/engine test -- happy-path

# Store-contract: tool_call parts round-trip + updateEntry transitions running→completed
pnpm --filter @valet/engine test -- in-memory-store
pnpm --filter @valet/store-postgres test

# API integration: real Anthropic + Docker, then GET /messages must include readable result
ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @valet/api test -- src/integration
```

If you change the result shape engine-side, **add an assertion that `result.text` (or whatever the canonical access pattern is) contains the actual output** — `expect(result).toBeDefined()` is *not* sufficient. The bug we keep shipping has `result` defined but its text is unreachable.

### When tool calls render as "(empty output)" or "(empty file)"

That's almost certainly a shape mismatch, *not* a persistence-failure. The data is in `engine_entries`; the frontend can't dig it out. Inspect:

- Real Postgres (`DATABASE_URL` set): `psql "$DATABASE_URL" -c "select parts from engine_entries where role='assistant' order by id desc limit 1;"`
- Embedded PGlite (default dev, data dir `~/.valet/pg/`) — stop the dev API first (a live process owns the data dir), then run from `packages/api` (bare-specifier resolution). Note: plain `node --input-type=module`, NOT `tsx -e` — tsx's eval mode compiles to CJS and rejects top-level await:
  ```bash
  cd packages/api && node --input-type=module -e '
  import { PGlite } from "@electric-sql/pglite";
  const db = new PGlite(process.env.HOME + "/.valet/pg");
  const { rows } = await db.query(
    "select parts from engine_entries where role=$1 order by id desc limit 1",
    ["assistant"],
  );
  console.log(rows);
  await db.close();
  '
  ```
- Compare against what `resultText` extracts in `packages/web/src/components/session/tool-renderers/types.ts`

### Other persistence-adjacent gotchas

- **`updateEntry` is mandatory after any post-`message_end` mutation** (tool completion, decision-gate resolution, compaction). The store contract suite has a regression test for the running→completed transition; if you touch the engine's persistence path, run that suite.
- **The wire `init` event is metadata-only.** Don't add `messages` back to it. Thread history loads via `GET /api/sessions/:id/messages?threadId=…`. Adding messages to init re-introduces the bug where reconnecting on a non-default thread wipes that thread's state.
- **Optimistic UI messages must carry the active `threadId`.** Tagging them `null` and fall-back-matching in the filter caused user bubbles to leak across threads.
- **Tool renderers (`packages/web/src/components/session/tool-renderers/`) are a registry**. The fallback handles unknown plugin tools. Adding a hand-tuned renderer for a new tool means dropping a `ToolRenderer` into that directory and listing it before the fallback in `index.ts`. The shell, status semantics, scanner animation, and category color are inherited from `ToolShell`.

### Pre-1.0: edit migrations in place, don't add new ones

We are NOT in production. There is no real data to preserve. When you change an engine or app schema:

- **Edit `packages/store-postgres/migrations/pg/0000_engine.sql`** (and the corresponding `packages/api/migrations/pg/0000_app.sql` for app-side tables) directly to add the new columns. For app tables, update the matching Drizzle table in `packages/api/src/schema/index.ts`. The engine store has no Drizzle schema — it's raw SQL; update the row interfaces + `rawTo*Row` mappers in `packages/store-postgres/src/helpers.ts` instead (bigint ms columns MUST funnel through `toNum`, see the note there).
- **Do NOT add `0001_…sql`, `0002_…sql`, etc.** Each one becomes a separate `ALTER TABLE` migration that we'll have to maintain forever. Until the first release, the right move is one clean `0000` that reflects the current schema.
- After editing, blow away the local PGlite data dir (`rm -rf ~/.valet/pg`) and let it recreate on the next boot. The pg migration runners have NO backfill path (unlike the retired sqlite ones): an existing data dir whose tracker already lists `0000` will simply skip your edited file — the reset is mandatory, not a nicety.
- Once we ship 1.0 and have user data on disk, this rule flips: every schema change becomes a new numbered migration, no edits to past ones.

### Sandbox gateway (`packages/sandbox-gateway`) gotchas

- **Docker-backend gateway testing needs a `full`-capable image.** `make dev-local`'s default sandbox-docker image (plain `node:20-bookworm`) has no ttyd/code-server/gateway. Point `VALET_SANDBOX_IMAGE` at an image built from `docker/Dockerfile.sandbox-k8s` to exercise the Terminal/VS Code tabs against the docker backend.
- **`full`-profile sandboxes receive `VALET_SESSION_ID` and `VALET_SANDBOX_PROFILE` env vars**, in addition to the existing `VALET_SANDBOX_JWT_SECRET`. The gateway enforces `sid === VALET_SESSION_ID` from the JWT claims — a JWT valid for one session is rejected inside a different session's sandbox even with a correct signature.
- **Any new package that imports `ws` must declare BOTH `@types/ws` AND `@types/node`.** `@types/ws`'s own type-resolution chain walks up to `@types/node`; if the local `devDependencies` only has `@types/ws`, pnpm's workspace layout can resolve `@types/node` from an unrelated ancestor `node_modules` instead of the package's own, silently pulling in the wrong Node types. This recurred on this branch (`packages/sandbox-gateway`) even after the earlier `@types/ws`-only fix in `packages/api` — declare both explicitly in every `ws`-consuming package.
- **A test run "failing" with `WebSocket is not defined` is almost always the Node-20-vs-22 trap, not a real regression** — re-verify under Node 22 (`source ~/.nvm/nvm.sh && nvm use 22`) before trusting the failure.

### Sandbox hibernation gotchas

- **`VALET_SANDBOX_IDLE_MINUTES`** controls the host's idle-sweep hibernation window (default `30`, `0` disables). It only does anything on the `kubernetes` sandbox backend — `capabilities().hibernation` is `false` for docker/local/virtual, so the sweep is a no-op there regardless of this env var.

### An api restart revokes running sandboxes' tokens without telling them

`EngineHost.sessionFor`/`buildSession` mints a fresh `VALET_SANDBOX_TOKEN` and revokes the prior one on every cache-miss rebuild (`evictAll()` on api restart, `evictCache()` on orchestrator PATCH) — but the physical sandbox is still running and `SandboxProvider.restore()` is never called, so nothing pushes the new token in. Any in-sandbox consumer that reads `$VALET_SANDBOX_TOKEN` from process env (today: the git-credential helper, `valet-gh`) keeps using the stale, now-revoked value and 403s until the sandbox is recreated. Applies to any future in-sandbox api consumer, not just GitHub — see `docs/specs/2026-07-16-github-repo-integration-design.md`'s Deviations section for the full mechanism and candidate fixes (verify-don't-revoke vs. push-token-on-rebuild).

### pnpm workspace peer-dep splits: a new dep edge can silently fork a "singleton" package

Adding a workspace dependency edge between two packages that both depend on a peer-dep'd package (e.g. `pi-ai`, whose provider registry is meant to be one shared instance) can make pnpm's resolver install **two separate copies** of that package — one per differing peer range — instead of hoisting to a single instance. Symptom: code that assumes a singleton (a provider registry, a module-level cache) silently stops sharing state across the two copies, and anything gated on "did this really hit the network" (a faux-provider "no-network" test, an in-memory stub) goes live/breaks with no type error and no obvious stack trace pointing at the cause. Fixed here by pinning a shared version via root `pnpm.overrides` (e.g. the `zod` pin that keeps `pi-ai` a single instance across `packages/api` and `packages/engine`). If a test that should never hit the network suddenly does, or a "singleton" starts behaving like two, suspect a peer-dep split before anything else — check `pnpm why <pkg>` for duplicate resolved versions.

---

## What This Project Is

Valet is a hosted background coding agent platform. Users interact with an AI coding agent through a web UI or chat channels (Telegram today). The current (v2) stack is the `dev-v2` branch: `packages/api` (Hono on Node) drives `@valet/engine` (a portable agent loop over pi-agent-core), sessions run in isolated sandboxes via pluggable providers (`sandbox-docker` for dev, `sandbox-kubernetes` for the helm deploy, `sandbox-local`/virtual for tests), state lives in Postgres (`store-postgres`; embedded PGlite in dev), and `packages/web` is the client. A per-user orchestrator is itself a full agent session that spawns and manages child sessions. The architecture is modeled after Ramp's Inspect system.

The original stack — Cloudflare Worker + Durable Objects, Modal sandboxes, the OpenCode runner — is frozen (kept only for the existing prod deploy) and is slated for deletion; don't build on it.

## Project Structure

```
valet/
├── packages/
│   ├── api/                 # Greenfield Node-first API (Hono + node-server + node-ws)
│   │                        #   wired to @valet/engine + sandbox-docker + store-postgres
│   ├── web/                 # Greenfield client (Vite + React 19 + Tailwind 3 + Radix)
│   ├── client/              # LEGACY React SPA — kept for prod CF deploy, frozen
│   ├── worker/              # LEGACY Cloudflare Worker — kept for prod CF deploy, frozen
│   ├── engine/              # @valet/engine — portable agent loop (pi-agent-core)
│   ├── workflow/            # Workflow DAG interpreter (nodes, expressions, checkpoints)
│   ├── store-postgres/      # SessionStore impl over Postgres (PGlite dev/test, node-postgres prod)
│   ├── sandbox-docker/      # Sandbox provider over Docker (long-running container, bind mount)
│   ├── sandbox-kubernetes/  # Sandbox provider over agent-sandbox CRs (helm deploy)
│   ├── sandbox-local/       # Sandbox provider over the host fs/process
│   ├── sandbox-gateway/     # In-sandbox JWT gateway (terminal/VS Code tabs)
│   ├── shared/              # Shared TypeScript types & errors
│   ├── runner/              # Bun/TS runner for inside legacy sandboxes
│   ├── sdk/                 # Integration & channel SDK contracts, MCP client, UI components
│   ├── plugin-github/       # GitHub integration (actions: PRs, issues, webhooks)
│   ├── plugin-slack/        # Slack (actions + channel adapter)
│   ├── plugin-gmail/        # Gmail integration
│   ├── plugin-google-*/     # Google Calendar, Drive, Sheets integrations
│   ├── plugin-linear/       # Linear issue tracking
│   ├── plugin-notion/       # Notion integration
│   ├── plugin-stripe/       # Stripe integration
│   ├── plugin-cloudflare/   # Cloudflare API integration
│   ├── plugin-sentry/       # Sentry error tracking
│   ├── plugin-deepwiki/     # DeepWiki knowledge base
│   ├── plugin-telegram/     # Telegram (channel adapter)
│   ├── plugin-browser/      # Browser skill (content-only)
│   ├── plugin-workflows/    # Workflow skill (content-only)
│   ├── plugin-sandbox-tunnels/  # Tunnel skill (content-only)
│   └── plugin-*/            # …and more — one package per integration/skill
├── backend/                 # LEGACY Modal Python backend
├── deploy/                  # Helm chart + vendored agent-sandbox controller (k8s)
├── docker/                  # Sandbox container images (incl. Dockerfile.sandbox-k8s)
├── scripts/                 # e2e runner (scripts/e2e.ts), registry codegen, deploy
├── docs/
│   ├── specs/               # Subsystem specs (source of truth per domain)
│   └── plans/               # Implementation plans
├── Makefile                 # Dev, test, deploy commands
└── docker-compose.yml       # Local dev services (keycloak profile, legacy OpenCode)
```

## Tech Stack Quick Reference

| Layer | Tech | Key Files |
|-------|------|-----------|
| **API (new)** | Hono 4, @hono/node-server, @hono/node-ws, Drizzle (Postgres: PGlite dev/test, node-postgres prod), pi-ai | `packages/api/src/` |
| **Web (new)** | Vite 6, React 19, TanStack Router/Query, Tailwind 3, Radix UI, Zustand | `packages/web/src/` |
| Frontend (legacy) | React 19, Vite 6, TanStack Router/Query, Zustand, Tailwind, Radix UI | `packages/client/src/` |
| Worker (legacy) | Cloudflare Workers, Hono 4, D1 (SQLite via Drizzle ORM), R2, Durable Objects | `packages/worker/src/` |
| Engine | @mariozechner/pi-agent-core, TypeBox plugin schemas | `packages/engine/src/` |
| Sandbox-docker | dockerode, long-running container, bind-mounted workspace | `packages/sandbox-docker/src/` |
| Shared | TypeScript types, error classes, scope keys | `packages/shared/src/` |
| SDK | Integration contracts, channel contracts, MCP client/OAuth, UI components | `packages/sdk/src/` |
| Runner (legacy) | Bun, TypeScript, `@opencode-ai/sdk`, Hono gateway | `packages/runner/src/` |
| Backend (legacy) | Python 3.12, Modal SDK | `backend/` |
| Sandbox (legacy) | OpenCode serve, code-server, Xvfb+VNC, TTYD | `docker/` |

## Subsystem Specs

Detailed per-subsystem specifications live in `docs/specs/`. These are the source of truth for each domain's behavior, boundaries, data model, and contracts. When modifying a subsystem, update its spec in the same commit.

Two generations coexist there:

- **Dated `YYYY-MM-DD-<topic>-design.md` files are the v2 stack's designs** (auth v2, telegram channel, e2e runner, handoff CLI, …). These are current — trust and maintain them.
- **The undated specs below describe the LEGACY stack** (Durable Objects, Modal, Runner/OpenCode). They remain accurate for the frozen code but do NOT describe `packages/api`/`@valet/engine` — don't apply their contracts to v2 work.

| Spec (legacy stack) | Covers |
|------|--------|
| [`docs/specs/sessions.md`](docs/specs/sessions.md) | Session lifecycle, state machine, sandbox orchestration, prompt queue, message streaming, hibernation/restore, access control, multiplayer |
| [`docs/specs/sandbox-runtime.md`](docs/specs/sandbox-runtime.md) | Sandbox boot sequence, service ports, auth gateway, Runner process, OpenCode lifecycle, Runner↔DO WebSocket protocol, Modal backend |
| [`docs/specs/real-time.md`](docs/specs/real-time.md) | SessionAgentDO WebSocket handling, EventBusDO, event types, V2 streaming protocol, client reconnection, message deduplication |
| [`docs/specs/workflows.md`](docs/specs/workflows.md) | Workflow definitions, trigger types (webhook/schedule/manual), execution lifecycle, WorkflowExecutorDO, step engine, approval gates, proposals, version history |
| [`docs/specs/auth-access.md`](docs/specs/auth-access.md) | OAuth flows (GitHub/Google), token auth, admin middleware, org model (settings/invites/LLM keys), session access control, JWT issuance |
| [`docs/specs/orchestrator.md`](docs/specs/orchestrator.md) | Orchestrator identity, auto-restart, child session spawning, memory system (FTS), mailbox, channel routing, task board |
| [`docs/specs/integrations.md`](docs/specs/integrations.md) | Integration framework, GitHub (OAuth/webhooks/API proxy), Telegram bot, Gmail, Google Calendar, channel bindings, custom LLM providers, credential storage |
| [`docs/specs/sandbox-images.md`](docs/specs/sandbox-images.md) | Base image definition (Modal SDK), layer order, version pinning, cache busting, env var assembly, snapshot/restore, workspace volumes, Dockerfile drift |

Boundary rules are enforced: each spec declares what it does NOT cover. Don't add content to the wrong spec — create or update the correct one.

### Design Specs & Implementation Plans (Superpowers)

When using superpowers skills (brainstorming → writing-plans → executing-plans), design specs and implementation plans go in the existing project directories — NOT in a `docs/superpowers/` folder:

- **Design specs** → `docs/specs/YYYY-MM-DD-<topic>-design.md`
- **Implementation plans** → `docs/plans/YYYY-MM-DD-<topic>.md`

## Key Architectural Decisions (v2)

These are decided and locked in. Do not revisit:

1. **The engine is portable** — `@valet/engine` owns the agent loop (pi-agent-core), sessions, threads, queue, gates, and persistence contracts. `packages/api` hosts it; nothing in the engine imports Hono or knows about HTTP.
2. **Pluggable providers** — `SessionStore` (store-postgres: PGlite dev/test, node-postgres prod) and `SandboxProvider` (docker dev-default, kubernetes for the helm deploy, local/virtual for tests) are swappable behind engine contracts with shared conformance suites.
3. **REST is authoritative for thread history** — `GET /api/sessions/:id/messages` serves persisted entries; the WS `init` event is metadata-only. Never add messages back to init.
4. **Plugins self-describe** — each `packages/plugin-*` exports one `ValetPlugin` manifest from `./plugin`; `make generate-registries` scans `plugin.yaml` (`v2: true`) into `packages/api/src/plugins/registry.gen.ts`. No per-capability registries.
5. **Orchestrators are full agent sessions** — per-user (well-known session ID `orchestrator:{userId}`) with orchestrator role/tools, spawning child sessions through the same engine APIs.
6. **Auth is better-auth** — email/password + optional OIDC/social (Keycloak-ready); `VALET_LOCAL_AUTH=1` is the dev stub. See `docs/specs/2026-07-14-auth-v2-design.md`.

## Development Commands

```bash
# Install dependencies
pnpm install

# Greenfield agent-loop stack (Node API + new web client)
make dev-local          # @valet/api on :8788 + @valet/web on :5173
                        # Requires ANTHROPIC_API_KEY + Docker daemon.
                        # Open http://localhost:5173
                        # Setting BETTER_AUTH_SECRET enables real auth (email/password,
                        # optional OIDC/social via AUTH_* vars — see
                        # docs/specs/2026-07-14-auth-v2-design.md). Unset, VALET_LOCAL_AUTH=1
                        # keeps the stub behaving as before.
                        # Channel transports (e.g. Telegram) default to long-poll mode with no
                        # extra config. Setting VALET_PUBLIC_URL (or a public BETTER_AUTH_URL —
                        # not localhost/*.localdev) flips ChannelHost to webhook mode instead;
                        # see docs/specs/2026-07-15-telegram-channel-design.md decision 3.

# Legacy stack (Cloudflare Worker + old client)
make dev-worker         # Cloudflare Worker on :8787
make dev-opencode       # OpenCode container on :4096
cd packages/client && pnpm dev  # Legacy frontend on :5173 (conflicts with web!)

# Or all at once (legacy):
make dev-all

# Unified e2e scorecard — THE way to validate v2 changes. Loads .env.e2e
# (copy .env.e2e.example), probes Docker/k8s/creds, runs every suite it can,
# prints ✓/✗/⊘ per feature. See docs/specs/2026-07-25-e2e-runner-design.md.
make e2e                          # everything armed by your creds/daemons
make e2e E2E_ARGS="--doctor"      # environment readiness checklist (fresh machine/agent)
make e2e E2E_ARGS="--list"        # show steps + what each needs
make e2e E2E_ARGS="--only cli,typecheck --json"
make e2e-clean                    # sweep state leaked by crashed runs (idempotent)

# Quick smokes (also rows in make e2e)
make smoke-orchestrator  # fastest agent-loop-alive check (real Anthropic, no Docker)
make smoke-session       # full session round-trip (real Anthropic + Docker)

# Kubernetes (local k3s, Rancher Desktop) — full runbook: deploy/README.md
make k8s-sandbox-install # Install vendored agent-sandbox CRD/controller (idempotent, run first)
make k8s-build           # docker build valet-api:dev + valet-sandbox:dev (moby mode, ~15-20 min cold)
make k8s-up              # helm upgrade --install onto rancher-desktop, namespace valet
kubectl --context rancher-desktop -n valet port-forward svc/valet-api 8080:80  # or https://valet.localdev via /etc/hosts
make k8s-logs            # tail the api pod
make k8s-down            # helm uninstall (PVCs + Sandbox CRs survive by design — see deploy/README.md for a full reset)

# Typecheck
pnpm typecheck          # All packages except packages/worker (see note below)
cd packages/worker && pnpm typecheck  # Single package

# Tests
pnpm test               # Root vitest sweep (shared, sdk, api, web + scripts projects)
                        # make e2e is the canonical full validation — see above

# Code generation
make generate-registries # Regenerate packages/api/src/plugins/registry.gen.ts from plugin.yaml manifests

# Legacy stack only (D1 database, Cloudflare/Modal deploy)
make db-migrate          # D1 migrations (legacy worker)
make deploy              # Deploy worker + modal + client (legacy prod)
make deploy-migrate      # Apply D1 migrations to production only
```

**Kubernetes context safety (binding).** The developer machine's default/ambient `kubectl` context may point at a PRODUCTION cluster (verified — a GKE prod cluster). Every `make k8s-*` target and every command in `deploy/README.md` pins `--context rancher-desktop` (`--kube-context rancher-desktop` for `helm`) explicitly. Never run a bare `kubectl`/`helm` command against this workflow — go through the `make` targets or add the context flag yourself. `VALET_SANDBOX_BACKEND=kubernetes` is what the chart sets to switch the api off the `docker` default onto `packages/sandbox-kubernetes` (session sandboxes become `Sandbox` CRs + pods instead of local Docker containers); `make dev-local` stays on `docker`.

**`packages/worker` is excluded from root `pnpm typecheck`.** It's frozen (kept only for the legacy prod Cloudflare deploy) and was dropped from `tsconfig.json`'s project references as part of the plugin-system-v2 conversion, once the worker's own `src/integrations/packages.ts`/`src/channels/packages.ts` registries stopped being regenerated (plugins now self-declare v2 manifests consumed by `packages/api`, not the worker). Worker deploys pin the last commit before that conversion started: `35b398e5`. Run `cd packages/worker && pnpm typecheck` directly if you need to typecheck it in isolation — root `pnpm typecheck` passing is no longer evidence either way for the worker.

### Applying D1 Migrations to Production

`make deploy` includes the migration step, but if you need to apply migrations separately:

```bash
make deploy-migrate
```

All deploy targets (`deploy-worker`, `deploy-migrate`, `deploy-modal`, `deploy-client`) are thin wrappers around `scripts/deploy.sh` which auto-discovers config (D1 ID, Modal workspace URL, worker URL) from CLI tools when values aren't set in `.env.deploy`.

### Modal Backend Deployment

Modal deployment uses `uv` to manage the Python environment and must be run from the project root:

```bash
# Deploy Modal backend (from project root)
make deploy-modal
# Or directly: uv run --project backend modal deploy backend/app.py
```

**Path resolution gotchas:**

1. **`backend/app.py`** — Paths here are relative to the **current working directory** (project root), not the backend folder:
   ```python
   # Correct (relative to project root):
   .add_local_dir("docker", remote_path="/root/docker")
   .add_local_dir("packages/runner", remote_path="/root/packages/runner")

   # Wrong (would look for ../docker from project root):
   .add_local_dir("../docker", remote_path="/root/docker")
   ```

2. **`backend/images/base.py`** — Paths here are **remote paths** inside the Modal function container (where files were mounted by app.py):
   ```python
   # These reference /root/... which is where app.py mounted the local files
   .add_local_dir("/root/packages/runner", "/runner", copy=True)
   .add_local_file("/root/docker/start.sh", "/start.sh", copy=True)
   ```

**Forcing image rebuilds:**

The sandbox image is cached. To force a rebuild after changing `docker/start.sh` or `packages/runner/`:

1. Bump the version in `backend/images/base.py`:
   ```python
   "IMAGE_BUILD_VERSION": "2026-01-28-v7",  # increment this
   ```
2. Redeploy: `make deploy-modal`
3. Create a new session (existing sandboxes won't update)

## Code Conventions

### API (`packages/api`, Hono on Node)

- Routes in `packages/api/src/routes/<name>.ts`, mounted in `src/app.ts`; wire types in `src/wire/types.ts`
- Engine wiring in `src/engine/` (`EngineHost`, wire bridge); plugin registry generated at `src/plugins/registry.gen.ts`
- Drizzle schema for app tables in `src/schema/index.ts`; engine tables are raw SQL in `packages/store-postgres/migrations/`
- CLI (`valet`) in `src/cli/` — command modules export pure `run*` functions unit-tested with stub clients

### Web (`packages/web`)

- File-based routing via TanStack Router: `packages/web/src/routes/`
- Components at `packages/web/src/components/<feature>/`; session tool renderers are a registry (see gotchas above)
- TanStack Query + Zustand; Radix primitives; Tailwind 3

(The frozen legacy `packages/worker`/`packages/client`/`packages/runner`/`backend` keep their old internal conventions — don't extend them, they're slated for deletion.)

### Shared Types

- All shared types in `packages/shared/src/types/index.ts`
- Message part types in `packages/shared/src/types/message-parts.ts`
- Scope key utilities in `packages/shared/src/scope-key.ts`
- Errors in `packages/shared/src/errors.ts`
- When adding a new entity shared across packages, add types here first

### SDK

- Integration contracts in `packages/sdk/src/integrations/` — defines the shape action packages must implement (actions, triggers, provider)
- Channel contracts in `packages/sdk/src/channels/` — defines `ChannelTransport` interface for channel packages
- MCP client and OAuth helpers in `packages/sdk/src/mcp/` — `client.ts`, `oauth.ts`, `action-source.ts`
- UI components in `packages/sdk/src/ui/` — shared channel badges, icons
- Metadata helpers in `packages/sdk/src/meta.ts`
- Exports: `@valet/sdk` (main), `@valet/sdk/channels`, `@valet/sdk/integrations`, `@valet/sdk/meta`, `@valet/sdk/ui`

### Plugin Packages (`packages/plugin-*`)

Each plugin lives in `packages/plugin-<name>/` with a `plugin.yaml` manifest and (for code plugins) a single `ValetPlugin` manifest exported from `./plugin`. Content-only plugins ship just `plugin.yaml` + skill/persona markdown. The full recipe is under "Adding a new plugin (v2)" below; `make generate-registries` regenerates `packages/api/src/plugins/registry.gen.ts`.

### Type Safety

This codebase has accumulated `any`, `unknown`, and type assertions (`as`) as shortcuts to silence the compiler. These hide real bugs and make refactoring dangerous. Follow these rules:

1. **No `any`.** Use the real type. If the shape is truly dynamic, use `Record<string, unknown>` and narrow with runtime checks. If a function is generic, use a type parameter. `any` disables the type checker for everything it touches.

2. **No `as unknown as T` double-casts.** This is always wrong — it means the types disagree and you're lying to the compiler instead of fixing the disagreement. In tests, provide the required fields for the interface instead of double-casting a partial object.

3. **Minimize `as` assertions.** An `as` means "I know better than the compiler." Usually you don't. If a function returns `string | undefined` and you write `as string`, you've hidden a potential bug. Prefer narrowing (`if`, `??`, type guards) over assertions. Legitimate uses: narrowing a discriminated union after a check, or bridging a third-party lib with bad types — add a comment explaining why.

4. **No `@ts-ignore` or `@ts-expect-error`.** Fix the type error. If it's a third-party type bug, add a minimal `as` with a comment linking to the upstream issue.

5. **Fix what you touch.** When editing a file that has `any`, unnecessary assertions, or double-casts, clean them up as part of your change. You don't need to fix the whole codebase — just leave every file you touch better than you found it.

6. **Extract pure functions to avoid testing private members.** If a test needs `(obj as any).privateMethod(...)`, extract the logic into an exported pure function. Test the pure function directly (no mocks, no casts), and have the private method call it. Don't create wrapper types or helpers to smuggle access to private members.

### Git Conventions

- Commit upon completion of each discrete task; keep subjects ≤72 chars.

## Common Patterns

### Adding a new plugin (v2)

Plugins are self-describing: a package exports a single `ValetPlugin` manifest (`{ name, version, actions?, triggers?, skills?, roles?, credentials?, description? }`, see `@valet/engine`'s `ValetPlugin` type) from `./plugin`, and `packages/api` bundles it. The worker's per-capability registries (`src/integrations/packages.ts`, `src/channels/packages.ts`, `src/plugins/content-registry.ts`) are retired — do not add new plugins there.

1. Create directory: `packages/plugin-<name>/`
2. Add `plugin.yaml` with name, version, description, icon, and `v2: true` (set `enabled: false` too if the manifest should exist but not ship yet — see `packages/plugin-telegram/plugin.yaml`)
3. Add `package.json`:
   - `"valet": { "plugin": "./dist/plugin.js" }` marker
   - `"exports"` with a `"./plugin"` entry pointing at `dist/plugin.js`/`dist/plugin.d.ts`
   - `@valet/engine` workspace dependency (plus `@valet/sdk`, `@valet/shared`, etc. as needed)
   - `build`/`typecheck`/`test` scripts matching a sibling plugin package
4. Add `tsconfig.json` extending the root config, referencing `../engine` (and any other workspace deps)
5. Implement `src/plugin.ts` default-exporting the `ValetPlugin` manifest:
   - Actions/triggers: build via `ActionPlugin`/`TriggerDef` (see `packages/plugin-github/src/plugin.ts`) or `mcpActionPlugin` (see `packages/plugin-deepwiki/src/plugin.ts`) for MCP-backed services
   - Skills: `loadSkillFromMarkdown(content, "plugin")` per `skills/*.md` file
   - Roles/personas: `loadRoleFromMarkdown(content, "plugin")` per role definition file
6. Add reference to root `tsconfig.json`'s `references` array (skip `packages/worker/tsconfig.json` — it's frozen and excluded from root typecheck)
7. Add dependency in `packages/api/package.json`: `"@valet/plugin-<name>": "workspace:*"`
8. Run `make generate-registries` — scans `packages/plugin-*/plugin.yaml` for `v2: true` (skipping `enabled: false`) and regenerates `packages/api/src/plugins/registry.gen.ts`
9. Run `pnpm typecheck` to verify

### Adding a web route

1. Create route file at `packages/web/src/routes/<path>.tsx` (TanStack Router regenerates the route tree on dev restart)
2. Add navigation in `packages/web/src/components/layout/` if it needs a sidebar entry
