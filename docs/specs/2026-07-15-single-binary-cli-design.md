# Single Binary + CLI Design — the full product experience in one file

**Date:** 2026-07-15
**Status:** Implemented (Node bundle + self-contained native single-file binaries via Bun `compile` — see Deviations)
**Scope:** Packaging Valet as a self-contained per-platform binary (`valet serve` = the full product on embedded PGlite) that is simultaneously the CLI client for any instance, local or remote: scriptable session commands, an interactive `valet chat` TUI, instance/profile admin, and agent wiring against the instance's MCP HTTP endpoint. The MCP tool surface itself is a separate design; this spec wires clients to it.

## Context

The architecture is already single-process friendly, mostly by prior decisions:

- **No native modules** in the api dependency tree (better-sqlite3 died with the Postgres pass; `pg`, `@kubernetes/client-node`, better-auth, drizzle are pure JS). PGlite is WASM, not a `.node` addon.
- **PGlite is the embedded default** (`~/.valet/pg`, SIGKILL-durable, one-instance-per-process discipline established); `DATABASE_URL` flips to real Postgres unchanged.
- **The api serves the web app** (SPA fallback from the k8s pass) — one process is the whole product.
- **Plugins are statically bundled** (`registry.gen.ts` static imports — nothing dynamic to defeat a bundler).
- **`sandbox-local` exists** as a zero-dependency backend; docker is detectable at runtime.
- **API keys exist** (auth v2) as the remote credential; the **MCP OAuth server** walking skeleton exists as the agent-facing auth path.

What's missing: the api runs TypeScript at runtime via `tsx` (no bundle step exists), all assets load from disk paths, and there is no CLI of any kind.

## Decisions (locked)

1. **One binary, two personalities.** `valet serve` boots the full product; every other subcommand is a **client of an instance** selected by profile. The client talks to the instance **only through the public HTTP/WS API — no side-door into the engine even when the instance is local** (no shared PGlite handle, no in-process engine calls). This keeps local and remote byte-identical, avoids the PGlite two-process trap outright, and makes the CLI a permanent conformance consumer of the public API.

2. **Local serve defaults.** `valet serve` uses `~/.valet/` (PGlite data dir, config), serves web + api on `:8788`, defaults `VALET_SANDBOX_BACKEND` to **docker when a reachable daemon is detected, else `local`** (printed at boot; `--sandbox` overrides), and runs stub auth (`VALET_LOCAL_AUTH=1` semantics) unless `BETTER_AUTH_SECRET` is set — same knobs as today, packaged. `valet reset` wipes the data dir behind an explicit confirmation prompt (and refuses while a live `valet serve` owns the dir — PGlite single-owner rule).

3. **Bundle first, package second.** Step one (valuable regardless of packaging): esbuild-bundle `packages/api` into a single JS artifact, killing runtime `tsx`. Everything that reads the filesystem by module-relative path moves behind one **asset layer** with two loaders: disk (dev, unchanged) and embedded (binary). Embedded assets: web `dist/`, the two `0000` migration files, plugin content (skills/personas markdown), and PGlite's WASM + extension bundles (PGlite supports byte/bundler loading). The bundle runs under plain `node` — this also slims the container image as a side effect.

4. **Packaging: Bun `compile` behind an explicit spike gate; Node SEA as fallback.** Target is `bun build --compile` (single command, asset embedding, per-platform cross-compilation, ~90MB-class output; the repo already uses Bun in the runner). **Go/no-go criteria for the spike, in order:** (a) better-auth login round-trip (crypto/cookies) works under Bun; (b) `@hono/node-ws` websocket streaming works or has a clean Bun-native substitution behind the server-adapter seam; (c) **the PGlite kill-test suite passes against the compiled binary** — durability guarantees were pinned on Node and do not transfer on faith. Any hard failure → Node SEA (blob assets API + postject injection per platform); SEA changes packaging mechanics only, nothing in the CLI/server design. Platforms this pass: macOS arm64, Linux x64/arm64. Windows is a WSL note.

5. **Config file + profiles + auth.** One config file, `~/.valet/config.json` (`0600` perms), owns both personalities:
   - `serve`: local-instance defaults — `port`, `sandbox` backend override, `dataDir`, auth mode knobs. Precedence: CLI flags > env vars > config file > built-in defaults, so today's env-var contract keeps working and the file is optional.
   - `profiles`: named instances `{ url, apiKey }` plus a default-profile pointer. `valet login <url>` prompts for an API key (minted in the web UI — auth v2's existing surface), verifies via whoami, saves; `valet logout`, `valet instance list|use`. Selection precedence: `--instance` flag > `VALET_INSTANCE` env > default profile. A local `valet serve` registers an implicit `local` profile (stub-auth instances need no key).
   - `valet config get|set <key>` for scriptable edits; unknown keys warn, never fail the boot. Browser-assisted login flow is a non-goal this pass.

6. **Scriptable core (the agent-usable floor).** `valet sessions list|new|show`, `valet send "<prompt>" [--session <id>] [--thread <key>]` (default: the user's orchestrator, matching the Telegram/channel model) streaming the turn to stdout, `valet gates list|resolve <gateId> <option>`, `valet status` (instance health, sandbox backend, version). Global `--json` emits stable machine-readable output (NDJSON for streamed events, mirroring the wire event shapes — not a new schema). Meaningful exit codes: `0` turn completed, distinct codes for gate-pending, turn-error, auth failure, unreachable instance. Humans and agents get the same commands; `--json` is the only difference.

7. **`valet chat` (TUI).** Interactive conversation, orchestrator by default, `--session` to attach to any session. Streaming tokens, compact tool-call summaries (name + one-line status, not full transcripts), and decision gates rendered inline as selectable prompts — making the CLI the third consumer of the same gate-resolution path after web and (per its spec) Telegram. Reconnects ride the same WS resume semantics as the web client. Implementation keeps TUI deps out of the server path (lazy import) so `valet serve` pays nothing for it.

8. **Agent wiring: `valet mcp setup [claude-code|--print]`.** The CLI configures a local agent to talk to the **instance's MCP HTTP endpoint** directly — no stdio bridge process. For Claude Code: writes/invokes the appropriate `mcp add` config with the instance URL and provisions the credential (API key header, or the MCP OAuth flow once the tool surface pass fleshes it out); `--print` emits the config JSON for any other agent. The MCP **tool surface** (which Valet tools are exposed, their shapes) is the separate already-recorded design — this spec's contract is only: whatever the api serves at `/mcp`, the CLI can wire an agent to it in one command.

9. **Distribution + versioning.** CI builds per-platform binaries on tag (ghcr release assets / GitHub Releases; no auto-update — `valet status` shows client and server versions and warns on skew). Version skew policy: the CLI is a public-API client, so compatibility follows API stability, not lockstep releases; `--json` output shapes are append-only once shipped.

## Exit criteria (the dogfood)

On a clean machine with nothing installed (no node, no pnpm, no Docker): download one file → `./valet serve` → browser at `localhost:8788`, sign in, run a session end-to-end on the local sandbox backend. From a second terminal: `./valet chat` reaches the same orchestrator; `./valet send --json "write hello.txt"` scripts a full turn including resolving a decision gate via `valet gates resolve`. Against the live k3s deployment: `./valet login https://…` + `valet sessions list` + `valet send` drive a **remote** session from the same binary. `valet mcp setup claude-code` makes the instance's MCP endpoint callable from a local Claude Code session. Kill `valet serve` with SIGKILL mid-write; restart; data intact (the compiled-binary kill-test criterion, exercised live).

## Testing

- **Asset layer unit:** disk vs embedded loaders byte-identical for every asset class (web, migrations, plugin content, PGlite WASM).
- **CLI integration suite** against a spawned `valet serve` (PGlite, local sandbox, stub auth): every scriptable command in human and `--json` modes, exit-code matrix, profile precedence, login/logout against real-auth boot, gate resolve round-trip.
- **TUI smoke** via pty (spawn `valet chat`, scripted exchange, gate prompt selection).
- **Compiled-binary gates:** the PGlite kill-test suite re-run against the packaged binary (spike criterion c, kept as a permanent CI job); boot smoke per platform; better-auth login round-trip; WS streaming echo.
- **Bundle guard:** CI asserts the server artifact has no runtime `tsx`/module-relative fs reads outside the asset layer (grep-level guard, keeps the binary buildable).

## Non-goals

- Windows native binary (WSL documented instead).
- Auto-update / self-update.
- Shipping Docker or sandbox images inside the binary (docker backend uses the host daemon's normal pulls).
- The MCP tool surface itself (separate recorded design; this spec only wires clients to `/mcp`).
- Browser-assisted `valet login` (API-key paste this pass).
- A stdio MCP bridge (HTTP endpoint only, by decision).
- npm-installable CLI package (`npx valet`) — possible later repackaging of the same bundle, not this pass.

## Deviations & owed items (as implemented)

Implemented on branch `feat/single-binary-cli` (PR against `dev-v2`). Plan: `docs/plans/2026-07-17-single-binary-cli.md`; ledger: `.superpowers/sdd/progress-single-binary.md`. What shipped vs. the locked decisions:

**Packaging — native single-file binaries now ship (decision 4; the earlier deferral is reversed).** Two artifacts exist: the esbuild bundle (`packages/api/dist/valet-api.mjs`, run under Node 22 — kills runtime `tsx`, slims the image) AND self-contained per-platform binaries via `bun build --compile`. The T11 spike originally stopped at gate (b) — `@hono/node-ws`'s WS upgrade never fired under a compiled Bun binary — and recorded the bundle-only verdict. A follow-up (branch `feat/bun-native-binary`, plan `docs/plans/2026-07-18-native-binary-bun-compile.md`) took decision 4's own escape hatch and cleared all three gates on a compiled binary:
- **Gate (b) WebSocket — now PASS.** A server-runtime adapter seam (`packages/api/src/server-adapter*.ts`) picks `Bun.serve`+`hono/bun`'s `createBunWebSocket()` when `isBunRuntime()`, else the untouched `@hono/node-server`+`@hono/node-ws` path. The compiled binary does a real `101` upgrade + streamed frames. The Node path is byte-identical (the Bun adapter is dynamically imported only under Bun; `hono/bun` throws at import under Node, so it's never in the Node graph).
- **Gate (a) better-auth — PASS** (unchanged from the spike: scrypt + HMAC cookies work under Bun).
- **Gate (c) PGlite durability — now PASS.** Verified against the compiled binary: PGlite wasm/data extracted from the embedded archive, 500 rows written, `kill -9` mid-life, reopened on the same data dir → data intact.

**Embedding mechanism.** The esbuild `inline-assets` plugin already string-inlines `.md`/`.sql` (migrations + plugin skills) into the bundle. The remaining binary assets (PGlite wasm/data + the web SPA) are packed into one USTAR archive embedded via Bun `import … with { type: "file" }`, extracted at first run to a content-hash-keyed temp dir (extract-once, reused across restarts), with `VALET_ASSET_DIR` pointed at it — so the existing `assetBase()` seam resolves everything with **zero app-code change**. Residual: ~19 MB is extracted to a temp dir on first boot per binary build (reused thereafter); genuine in-memory (no temp dir) is a possible future refinement. Platforms shipped: macOS arm64, Linux x64, Linux arm64 (cross-compiled — assets are platform-agnostic); Windows = WSL (run the linux-x64 binary). CI (`.github/workflows/release-cli.yml`) compiles + smoke-tests them on tag.

**MCP wiring uses a documented placeholder token (decision on `/mcp`).** `valet mcp setup` emits/merges a Claude Code streamable-HTTP config for `<instance>/mcp`, but `/mcp` is guarded by better-auth **MCP OAuth (`Authorization: Bearer`)**, not the `x-api-key` the other routes use, and is only mounted when real auth is configured. The CLI cannot mint an MCP bearer token yet, so the command provisions the config shape + honestly documents the OAuth requirement (a `<MCP_OAUTH_TOKEN>` placeholder, or `--token` if the user already has one). The OAuth handshake is owed to the MCP-tool-surface pass.

**`login` is API-key paste only (matches non-goals).** Real-auth `vlt_` keys are minted via the web UI (better-auth `POST /api/auth/api-key/create`); the CLI verifies a pasted key via `GET /api/me` before persisting.

**One additive API surface change only.** `GET /api/health` gained `version` + `sandboxBackend` (append-only on `HealthResponse`); no engine/auth/wire change beyond that. `valet status` reports client↔server version skew off it.

**`valet serve` default backend flip.** `serve` auto-detects `docker` if a reachable daemon is found, else `local` (decision 2). The api Docker image's ENTRYPOINT is now `cli.ts serve`, so an *unconfigured* container auto-detects `local` (no in-container daemon) rather than the prior explicit default — real deployments (the k8s chart) always set `VALET_SANDBOX_BACKEND` explicitly, so they are unaffected.

**Owed test coverage (recorded, not silently dropped).** The CLI e2e suite (`packages/api/src/integration/cli.e2e.test.ts`, opt-in via `VALET_CLI_E2E=1`) covers status / session CRUD / exit-code matrix / keyless login-logout against a real spawned `valet serve`. Deferred: (1) real-auth login e2e (needs a logged-in better-auth session to mint a key); (2) the `gates resolve` round-trip and human-mode `send` (both need a real agent turn, gated on `ANTHROPIC_API_KEY`); (3) native-binary CI release (the `.github/workflows/release-cli.yml` workflow ships the Node bundle on tag; native binaries are owed with the compile decision above).
