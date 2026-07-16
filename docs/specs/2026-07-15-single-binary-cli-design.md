# Single Binary + CLI Design — the full product experience in one file

**Date:** 2026-07-15
**Status:** Draft
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
