# Implementation Plan — Single Binary + CLI (spec #5)

**Spec:** `docs/specs/2026-07-15-single-binary-cli-design.md` (Decisions locked; non-goals real)
**Branch:** `feat/single-binary-cli` (worktree, cut from `dev-v2`)
**Ledger:** `.superpowers/sdd/progress-single-binary.md`

## Strategy & phasing

The spec is explicit that value ships incrementally: **the esbuild bundle is valuable standalone** and lands FIRST; Bun-compile is gated behind a 3-part spike whose legitimate outcome may be "bundle-only this pass / Node SEA fallback." We therefore phase:

- **Phase A — Bundle (kills `tsx`, slims container).** Uniform asset-read seam + esbuild build + inline-assets plugin + bundle guard. Runs under plain `node`.
- **Phase B — CLI floor (the agent-usable core).** Config/profiles, HTTP/WS client, `valet serve`, scriptable commands (`sessions`/`send`/`gates`/`status`), profile admin (`login`/`logout`/`instance`/`config`/`reset`), `valet mcp setup`, `valet chat` TUI, CLI integration suite.
- **Phase C — Packaging spike + distribution.** Bun `compile` 3-part go/no-go; embedded-binary asset delivery on pass, else documented fallback; CI release workflow (may be surfaced as owed).

### Key architectural decisions for this plan

1. **The CLI talks to the instance ONLY through the public HTTP/WS API** (spec decision 1). No in-process engine access, no shared PGlite handle — even for a local `valet serve`. The client library is a pure HTTP/WS consumer of `@valet/api/wire` types.
2. **One binary, `valet <subcommand>` dispatcher.** New entry `packages/api/src/cli.ts`. `serve` dynamically imports the server boot (`./main` refactored to an exported `startServer()`); every other subcommand dynamically imports its command module. **TUI/prompt deps are lazy-imported inside their command modules** so `valet serve` pays nothing for them (spec decision 7).
3. **Uniform asset seam.** Every module-relative asset read becomes `readFileSync(new URL(<relative>, import.meta.url), <enc>)` (text) or the `Uint8Array` form (bytes). One esbuild `inline-assets` plugin rewrites these `.md`/`.sql` reads into inlined constants at bundle time. This is simultaneously the "embedded loader"; the "disk loader" is dev-mode `tsx` (unchanged `import.meta.url` disk reads). The two-loaders-byte-identical test compares inlined bytes vs on-disk bytes per asset class.
4. **Migration loaders drop `readdirSync`.** Pre-1.0 there is exactly one `0000` file each (CLAUDE.md rule: edit 0000 in place, never add 0001). Replace the directory scan with explicit single-file reads of the known `0000_engine.sql` / `0000_app.sql` via the uniform seam, preserving the `--> statement-breakpoint` split + tracker-table behavior.
5. **Large/binary assets (web `dist/`, PGlite `pglite.wasm`/`pglite.data`/`initdb.wasm`) are NOT inlined in Phase A.** They are copied into `packages/api/dist/assets/{web,pglite}/` by the build and resolved at runtime from a base dir (`VALET_ASSET_DIR` ?? dir of the bundle). Embedding these into the executable is Phase C's concern (Bun `--asset` / SEA blob), behind the spike.
6. **No engine changes.** This spec needs none. If a task appears to require an engine or auth-surface change, STOP and surface it (per coordinator brief). One small **api** addition is expected and allowed: a `version` field on `GET /api/health` (or a `GET /api/version`) so `valet status` can report client/server versions + skew (spec decisions 6 & 9). This is a routes/wire change, not engine/auth.

## Global constraints (apply to EVERY task)

- **Node 22 for all test/build runs:** `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null` first. Node 20 fails WS tests with `WebSocket is not defined` — do not misdiagnose. (Host default here is Node 20.)
- **API suite:** only the 2 known `messages.abort.test.ts` failures are allowed. Everything else must pass.
- **PGlite:** one instance per process. Never open a second PGlite in-process; the kill-test/durability evidence is pinned on that discipline. Tests share one instance.
- **Types:** no `any`, no `as unknown as`, no `@ts-ignore`/`@ts-expect-error`. Narrow properly. Reuse `@valet/api/wire` types on the client — do not invent parallel shapes.
- **Commits:** no Co-Authored-By trailers. Terse subjects (≤72 chars) + few bullets. Commit per task on green.
- **Schema:** pre-1.0 — edit `0000` files in place if ever needed (this spec should need none).
- **Typecheck:** root `pnpm typecheck` excludes `packages/web`; if web touched, run its typecheck separately. Run under Node 22.
- **Docker/k8s suites** may flake under host contention (sibling worktree active) — rerun isolated before believing a failure. Do NOT touch the k8s cluster; this spec does not need it. If any cluster command were ever run, pin `--context rancher-desktop`.
- **TDD:** write the failing test first, watch it fail, implement, watch it pass. `expect(x).toBeDefined()` is insufficient for content assertions — assert actual bytes/text/exit-codes.

## Conventions the client library must honor (from seam analysis)

- **Auth:** real instances → `x-api-key: vlt_…` header on every HTTP request AND on the WS upgrade GET. Local stub (`VALET_LOCAL_AUTH=1`) → no credential needed. whoami/verify = `GET /api/me` (200 = valid + identity). Key prefix `vlt_`; keys minted via better-auth `POST /api/auth/api-key/create` (web UI surface).
- **Send:** default target = user orchestrator. `POST /api/orchestrator` (ensure-if-absent) → `{ sessionId }`, then `POST /api/sessions/:id/messages` body `{ text, threadId? }` → 202 `{ messageId, threadId }` where `messageId` correlates with the `submission.settled` WS event's `queueItemId`.
- **History:** `GET /api/sessions/:id/messages?threadId=…` is authoritative (WS `init` carries no messages).
- **WS:** `GET /api/sessions/:id/ws[?fromOffset=N]`; durable frames carry `offset`; reconnect with the last `offset`. Event union in `packages/api/src/wire/types.ts` (`WireEvent`): `text_delta`, `message_start/update/end`, `tool_start/tool_end`, `status`, `turn_end`, `decision_gate`, `decision_gate_resolved`, `submission.settled`, `error`, etc.
- **Gates:** `GET /api/sessions/:id/decisions` (pending), `POST …/decisions/:gateId/resolve` body `{ actionId? , value? }`.
- **Exit codes (spec decision 6):** `0` turn completed; distinct non-zero for gate-pending, turn-error, auth failure, unreachable instance. Define an `ExitCode` enum in the CLI and use consistently.

---

## Tasks

### T1 — Uniform asset-read seam (no behavior change)
**Goal:** collapse every module-relative asset read to one rewritable pattern; kill the migration `readdirSync`. Dev (`tsx`) behavior identical.
**Files:**
- `packages/store-postgres/src/migrate.ts`: replace `readdirSync(migrationsDir)` + loop with explicit read of `0000_engine.sql` via `readFileSync(new URL("../migrations/pg/0000_engine.sql", import.meta.url), "utf8")`. Keep breakpoint split, tracker `__valet_engine_migrations`, `assertSchemaVersion`. Preserve idempotency (skip if already tracked).
- `packages/api/src/lib/drizzle.ts`: same for `0000_app.sql` (`../../migrations/pg/0000_app.sql`), tracker `__valet_app_migrations`.
- 9 plugin `src/plugin.ts` files already use the target pattern — no change, but confirm the exact form is uniform (`readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")` — normalize to `readFileSync(new URL(rel, import.meta.url), "utf8")` if trivial; leave `fileURLToPath` form if risk).
**TDD:**
- store-postgres migrate test still green (`pnpm --filter @valet/store-postgres test`).
- api migration path exercised by existing api suite.
- New unit `packages/store-postgres/test/migrate-explicit.test.ts`: asserts the explicit reader yields the same statement count / applies cleanly to a fresh shared PGlite.
**Verify:** `pnpm --filter @valet/store-postgres test`, `nvm use 22 && pnpm --filter @valet/api test` (2 abort failures allowed). Fresh `rm -rf ~/.valet/pg` not needed (test PGlite is isolated temp dirs).

### T2 — esbuild bundle + inline-assets plugin + bundle guard
**Goal:** `packages/api` → one JS artifact under plain `node`, `tsx` gone from runtime path; `.md`/`.sql` inlined; web+pglite copied to `dist/assets/`.
**Files (new):**
- `packages/api/build.mjs`: esbuild — entry `src/cli.ts` (created in T3; for T2 target `src/main.ts` and re-point in T3), `bundle:true`, `platform:"node"`, `format:"esm"`, `target:"node22"`, `outfile:"dist/valet-api.mjs"`, `banner` for esm `__dirname`/`require` shims as needed, `external: []` (bundle workspace deps from source). Plugin `inlineAssetsPlugin` (new `packages/api/build/inline-assets.mjs`): `onLoad` for `\.(md|sql)$` → `{ loader: "text" }` is insufficient (reads are `readFileSync(new URL(...))`); instead an `onResolve`/`onLoad` transform that detects the `readFileSync(new URL(<lit>, import.meta.url), ...)` call sites is brittle. **Chosen mechanism:** add an esbuild `text`/`binary` loader by converting the seam to `import`-able assets is invasive across 9 plugins; INSTEAD ship a resolver that, in bundle mode, maps `import.meta.url` asset reads by copying the referenced `.md`/`.sql` next to the bundle under a stable `assets/` tree AND overriding the read base. **Decision (record in code comment):** Phase A keeps `.md`/`.sql` as **on-disk sibling assets** too (copied into `dist/assets/plugins/**` and `dist/assets/migrations/**`), with the runtime read base switched from per-module `import.meta.url` to a single `assetBase()` when `VALET_BUNDLED=1`. True string-inlining is deferred to Phase C (the binary), where sibling files aren't possible. This keeps T2 tractable and still "kills tsx + slims image."
  - Implement `packages/api/src/assets/base.ts`: `export function assetBase(): string` → `VALET_ASSET_DIR ?? dirname(fileURLToPath(import.meta.url))`-derived; helpers `webDistPath()`, `migrationsDir(pkg)`, `pluginSkillPath(...)`. In dev (unbundled) these resolve to source-tree paths (identical to today); under the bundle they resolve to `dist/assets/**`.
  - Refactor the T1 seams + `static-web.ts` mount + plugin markdown reads to go through `assetBase()` helpers **only when bundled**; dev path unchanged.
- `packages/api/build/copy-assets.mjs`: copies `packages/web/dist` → `dist/assets/web`, pglite `pglite.wasm|pglite.data|initdb.wasm` from `node_modules/@electric-sql/pglite/dist` → `dist/assets/pglite`, the two `0000_*.sql` → `dist/assets/migrations/{engine,app}`, and each plugin `skills/*.md` → `dist/assets/plugins/<name>/`.
- PGlite wasm base: pass `PGlite`'s emscripten `wasmModule`/`fsBundle` or set the module's asset base; simplest reliable path is to run the bundle with cwd-independent `VALET_ASSET_DIR` and copy pglite dist beside it, using PGlite's documented `{ wasmModule, fsBundle }` options if `import.meta.url` resolution fails from the bundle. Implementer verifies PGlite actually boots from the bundle (boot smoke below) and adjusts.
- `package.json` (api): add `esbuild` devDep; scripts `build:bundle` (= `node build.mjs`), `build:assets` (= copy-assets). Keep `start`/`dev` on tsx for dev.
- CI/bundle guard test `packages/api/src/bundle-guard.test.ts`: greps built `dist/valet-api.mjs` asserting no literal `tsx` runtime import and no `readdirSync(` of a migrations dir; asserts `dist/assets/{web,pglite,migrations}` exist after build.
**TDD:** asset byte-identity unit `packages/api/src/assets/asset-parity.test.ts`: for each class (migration sql, plugin md, web index.html, pglite.wasm) assert `readFileSync(sourcePath)` bytes === `readFileSync(dist/assets/...)` bytes after `build:assets`.
**Verify:** `nvm use 22 && pnpm --filter @valet/web build && pnpm --filter @valet/api run build:assets && pnpm --filter @valet/api run build:bundle` then `VALET_BUNDLED=1 ANTHROPIC_API_KEY=… node packages/api/dist/valet-api.mjs` boots, migrations run, `/api/health` responds, a plugin skill loads. `rm -rf ~/.valet/pg` before boot smoke.

### T3 — CLI scaffold + config/profiles
**Goal:** `valet` dispatcher; `~/.valet/config.json` (0600) with `serve` + `profiles`; precedence resolver.
**Files (new, under `packages/api/src/cli/`):**
- `packages/api/src/cli.ts`: shebang-free entry; parse `argv[2]` subcommand; dispatch table with **dynamic imports** (`serve` → `./main` `startServer()`; others → `./cli/commands/<name>.js`). Unknown → usage + exit 2. `--help`/`--version` top-level.
- `packages/api/src/cli/config.ts`: `ValetConfig` type `{ serve?: {port?, sandbox?, dataDir?, authMode?}, profiles?: Record<string,{url,apiKey?}>, defaultProfile?: string }`; `loadConfig()` (missing file → `{}`, unknown keys warn not fail), `saveConfig()` (writes `0600`, creates `~/.valet` `0700`), `configPath()`.
- `packages/api/src/cli/resolve.ts`: `resolveServeOption(key, {flags, env, config})` implementing precedence CLI>env>config>default; `resolveInstance({flags, env, config})` → profile `{url, apiKey?}` via `--instance` > `VALET_INSTANCE` > `defaultProfile`.
- `packages/api/src/cli/exit.ts`: `ExitCode` enum (`OK=0, GATE_PENDING, TURN_ERROR, AUTH_FAILURE, UNREACHABLE, USAGE=2`).
- `packages/api/src/cli/output.ts`: `--json` detection; `printJson`/`printHuman`; NDJSON emitter for streams.
**TDD:** `packages/api/src/cli/config.test.ts` (load/save round-trip, 0600 perms via `stat`, unknown-key warning), `resolve.test.ts` (full precedence matrix incl. instance selection).
**Interfaces exported for later tasks:** `ValetConfig`, `loadConfig/saveConfig/configPath`, `resolveInstance`, `resolveServeOption`, `ExitCode`, output helpers.

### T4 — HTTP/WS client library (`InstanceClient`)
**Goal:** pure public-API client used by all client subcommands.
**Files (new):**
- `packages/api/src/cli/client.ts`: `class InstanceClient { constructor({url, apiKey?}) }`. HTTP methods (typed via `@valet/api/wire`): `health()`, `me()`, `ensureOrchestrator()`, `listSessions()`, `getSession(id)`, `createSession(body)`, `listMessages(id, {threadId?, cursor?})`, `sendPrompt(id, {text, threadId?})`, `listThreads(id)`, `listDecisions(id)`, `resolveDecision(id, gateId, {actionId?, value?})`. All set `x-api-key` when `apiKey` present. Error mapping: network fail → throw `UnreachableError`; 401 → `AuthError`; non-2xx → `ApiError` with status+body. These map to `ExitCode`s at the command layer.
- `packages/api/src/cli/stream.ts`: `streamSession(client, sessionId, {fromOffset?}): AsyncIterable<WireEvent>` over `ws` (npm `ws`), sets `x-api-key` header on upgrade, tracks last `offset` for resume, yields parsed `WireEvent`s, closes on `turn_end`/`submission.settled` or caller break; ping/pong handled.
**TDD:** unit with a stub Hono server (or nock-style fetch mock) for header presence + error→exit mapping; the real round-trip is covered by the T9 integration suite (spawned `valet serve`). Keep unit fast/offline.
**No `any`:** reuse wire types; where WS frames are `unknown` off the wire, parse via a narrow type guard on `type`.

### T5 — `valet serve` command
**Goal:** boot the full product with packaged defaults; sandbox auto-detect; implicit `local` profile.
**Files:**
- Refactor `packages/api/src/main.ts`: extract body into `export async function startServer(opts?): Promise<{ close(): Promise<void>, port, backend }>`; keep the top-level module-as-script behavior only for back-compat (or move the script shim to `cli serve`). Keep graceful shutdown.
- `packages/api/src/cli/commands/serve.ts`: resolves port/sandbox/dataDir/auth via T3 precedence; **sandbox default = docker if reachable daemon detected, else local** (reuse/extend existing docker detection; print chosen backend at boot per spec decision 2); sets env for `startServer`; registers/updates an implicit `local` profile in config (`{ url: http://localhost:<port> }`, no key for stub auth); prints web URL. `--sandbox`, `--port` flags override.
**TDD:** `serve.test.ts` — backend selection (mock docker-detect true/false), implicit-profile write, precedence honored. Full boot exercised in T9.
**Verify:** `nvm use 22 && node packages/api/dist/valet-api.mjs serve` (after T2 build) boots, prints backend, serves `/api/health`.

### T6 — Scriptable commands + version endpoint
**Goal:** `valet sessions list|new|show`, `valet send`, `valet gates list|resolve`, `valet status`; `--json`; exit codes.
**Files:**
- `packages/api/src/routes/*` (small api add): extend `GET /api/health` response with `version` (baked from `packages/api/package.json` version via a generated constant or `process.env.npm_package_version` fallback → a `VALET_VERSION` const in `src/version.ts`). Update `wire/types.ts` `HealthResponse` accordingly (append-only). This is the only api surface change.
- `packages/api/src/cli/commands/sessions.ts`: `list` (table / json of `SessionSummary[]`), `new` (`--workspace` required abs path, `--title`, `--profile`), `show <id>`.
- `packages/api/src/cli/commands/send.ts`: default target = `ensureOrchestrator()`; `--session`/`--thread` overrides; `sendPrompt` then `streamSession` from the returned point; human mode prints tokens + compact tool lines; `--json` emits NDJSON of wire events; ends on `submission.settled`, mapping outcome→exit code (`completed`→0, `failed`→TURN_ERROR); if a `decision_gate` arrives and turn blocks → exit `GATE_PENDING`.
- `packages/api/src/cli/commands/gates.ts`: `list` (`listDecisions`), `resolve <gateId> <option>` (`resolveDecision`; `<option>` = actionId, or `--value` for question gates).
- `packages/api/src/cli/commands/status.ts`: `health()` + baked client version → prints instance health, sandbox backend (from a status/health field or `getSession`-independent — expose backend on health? add `sandboxBackend` to health response too), client vs server version + skew warning.
**TDD:** command unit tests with a stubbed `InstanceClient` asserting exit codes + json shape; version endpoint tested in api suite. Round-trip in T9.

### T7 — Profile admin + reset
**Goal:** `valet login/logout`, `valet instance list|use`, `valet config get|set`, `valet reset`.
**Files:**
- `packages/api/src/cli/commands/login.ts`: `valet login <url>` prompts for API key (lazy-import a tiny prompt; hidden input), verifies via `client.me()`, saves profile + sets default. `logout.ts` removes profile.
- `packages/api/src/cli/commands/instance.ts`: `list` (profiles + which is default/selected), `use <name>` (sets defaultProfile).
- `packages/api/src/cli/commands/config.ts`: `get <key>` / `set <key> <val>` on the `serve` block (dot-path); unknown key warns.
- `packages/api/src/cli/commands/reset.ts`: confirmation prompt (`--yes` to skip); **refuses while a live `valet serve` owns the data dir** — detect via PGlite lock file presence in `~/.valet/pg` (or a `serve.lock` pidfile written by serve). Wipes `dataDir` on confirm.
- `serve.ts` (from T5): write/remove a `serve.lock` pidfile so `reset` can detect ownership.
**TDD:** `login.test.ts` (verify-then-save, bad key → AUTH_FAILURE, no write), `reset.test.ts` (refusal when lock present; wipe when absent; `--yes` bypass), `instance/config` unit.

### T8 — `valet chat` TUI
**Goal:** interactive orchestrator (default) / `--session`; streaming tokens; compact tool summaries; inline selectable decision gates; WS resume.
**Files:**
- `packages/api/src/cli/commands/chat.ts`: **lazy-import** all TUI deps here (keep out of serve path). Minimal readline/ANSI TUI (avoid heavy deps; a small dependency like `@clack/prompts` or plain `readline` — implementer picks, keep bundle lean and typed). Loop: read line → `sendPrompt` → `streamSession` render (tokens inline, tool_start/tool_end as one-line `⚙ toolName · status`), on `decision_gate` render options and read a selection → `resolveDecision`, continue. Reconnect on WS drop with last `offset`.
**TDD:** pty smoke `packages/api/src/cli/commands/chat.pty.test.ts` — spawn `valet chat` against a spawned stub/real serve, script an exchange, assert a streamed reply and a gate-prompt selection round-trip. (Node `node-pty` or child_process with a pseudo-tty; if pty proves flaky in CI, gate behind an env and keep a non-pty unit for the render functions — extract pure render fns to test directly.)

### T9 — CLI integration suite (spawned `valet serve`)
**Goal:** end-to-end against a real spawned serve (PGlite, local sandbox, stub auth).
**Files:**
- `packages/api/src/cli/integration/cli.integration.test.ts`: spawn `node dist/valet-api.mjs serve` (or `src/cli.ts` via tsx for speed) with `VALET_LOCAL_AUTH=1`, a temp `VALET_DATA_DIR`, `VALET_SANDBOX_BACKEND=local`, `ANTHROPIC_API_KEY` (skip w/ clear message if absent). Cover: `sessions list/new/show`, `send` human+`--json`, exit-code matrix, `gates list` + `resolve` round-trip (drive a gate via local sandbox / a deterministic tool), profile precedence, `status` version/skew, `login/logout` against a **real-auth** boot (separate serve with `BETTER_AUTH_SECRET`, mint a key via better-auth, login, whoami).
- Ensure one PGlite per spawned process; each test serve gets its own temp data dir; tear down (kill + wait) between real-auth vs stub sub-suites.
**Verify:** `nvm use 22 && ANTHROPIC_API_KEY=… pnpm --filter @valet/api test -- src/cli/integration`.

### T10 — `valet mcp setup [claude-code|--print]`
**Goal:** wire a local agent to the instance's `/mcp` endpoint in one command.
**Files:**
- `packages/api/src/cli/commands/mcp.ts`: `setup claude-code` writes/invokes the Claude Code MCP config (`claude mcp add`-style JSON, streamable-HTTP transport) pointing at `<instanceUrl>/mcp` with the credential (API-key header for now; note the `/mcp` endpoint currently expects Bearer OAuth per seam analysis — record this deviation and provision what auth v2 supports today, leaving the OAuth flow to the MCP-tool-surface pass). `--print` emits the config JSON to stdout for any agent. Resolve instance via T3.
**TDD:** `mcp.test.ts` — `--print` emits valid JSON with the right URL + auth header shape; `claude-code` writes to a temp config path (injected) not the real user config.
**Note/possible blocker:** if wiring Claude Code cleanly requires the OAuth handshake (Bearer, not x-api-key) and auth v2 can't mint an MCP token yet, `setup claude-code` may only be able to emit `--print` config + a documented manual step. Surface this rather than over-building.

### T11 — Bun `compile` spike (3-part gate) — Phase C
**Goal:** execute spec decision 4's go/no-go **in order**; record verdict; do NOT force compile.
**Steps (record each in `docs/plans/…` follow-up or ledger + a short `docs/specs` deviation note):**
- Build with `bun build --compile` targeting the T2 bundle entry, embedding assets (`--asset`/embedded fs) for web/pglite/migrations/plugin-md.
- (a) better-auth login round-trip (crypto/cookies) under Bun.
- (b) `@hono/node-ws` WS streaming under Bun, or a clean Bun-native substitution behind the `serve`/`injectWebSocket` seam (only `main.ts` couples to it).
- (c) **PGlite kill-test/durability** (`packages/store-postgres/experiments/durability-spike.ts` adapted) against the compiled binary.
- Any hard failure (in order) → **stop, record verdict = Node SEA fallback or bundle-only**; SEA changes packaging mechanics only. Platforms this pass: macOS arm64, Linux x64/arm64; Windows = WSL note.
**Deliverable:** verdict + evidence in ledger and spec Deviations. If pass, land the compile script + embedded-asset delivery for the binary; if not, land the documented fallback and leave compile as owed.

### T12 — CI distribution + versioning (Phase C, may be owed)
**Goal:** per-platform binaries on tag; `valet status` skew warning already in T6.
**Files:** `.github/workflows/release-cli.yml` — on tag build bundle (+ compile if T11 passed) for macOS arm64, Linux x64/arm64; attach to GitHub Release. No auto-update. `--json` shapes append-only.
**Note:** if time-constrained, deliver the bundle build in CI and surface native-binary release as owed.

---

## Test commands (per constraints)

```bash
source ~/.nvm/nvm.sh && nvm use 22 >/dev/null
pnpm --filter @valet/store-postgres test
pnpm --filter @valet/api test                 # 2 messages.abort failures allowed
ANTHROPIC_API_KEY=… pnpm --filter @valet/api test -- src/cli/integration
pnpm typecheck                                 # excludes packages/web
pnpm --filter @valet/web build && pnpm --filter @valet/api run build:assets && pnpm --filter @valet/api run build:bundle
```

## Definition of done (arc)

All tasks pass per-task review (Critical/Important findings fixed + re-reviewed). Final whole-branch review = Ready. Spec Status → Implemented + Deviations section. Push `feat/single-binary-cli`; open PR against **`dev-v2`** (never `main`). Do not merge.
