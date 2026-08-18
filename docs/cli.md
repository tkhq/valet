# The `valet` CLI

Valet ships as a single self-contained binary. Bun compiles it with the
web client and migrations embedded. The binary is both the server and its
client: `valet serve` boots the whole product, and the other subcommands
talk to any running instance — the one you just started or a remote
deployment. Source lives in `packages/api/src/cli/`.

```
valet <command> [options]

Commands:
  serve       Boot the Valet server (the full product)
  sessions    List and inspect sessions on an instance
  send        Send a prompt to a session
  gates       List and resolve decision gates
  status      Show instance / session status
  login       Add or authenticate an instance profile
  logout      Remove an instance profile
  instance    Manage instance profiles
  config      View or edit CLI config
  chat        Interactive chat with a session
  mcp         MCP client operations
  reset       Reset local state

Global options:
  --json          Machine-readable JSON output (where supported)
  --instance <n>  Select an instance profile
  -h, --help      Show this help
  -V, --version   Show the CLI version
```

## Quick Start

```bash
valet serve            # boots API + web UI on :8788, embedded PGlite
# in another shell:
valet sessions new --workspace ~/code/myproject
valet send "run the tests" --session <id>
valet chat             # interactive REPL against your orchestrator
```

After `serve` starts listening, it writes an implicit `local` profile into
the CLI config. The client subcommands then work against the local
instance out of the box. No `login` is needed.

## Instances and Profiles

Client subcommands target a named **instance profile**: a
`{ url, apiKey? }` pair stored in `~/.valet/config.json`.

```bash
valet login https://valet.example.com --api-key vlt_... --name prod
valet instance list          # show profiles + default
valet instance use prod      # make one the default
valet logout prod            # remove it
```

`login` verifies the credential against the instance before it persists
the profile, then makes the new profile the default. A command resolves
its profile in this order: the `--instance <name>` flag, then the
`VALET_INSTANCE` env var, then `defaultProfile` in the config file.

That precedence rule is general. For every setting the CLI resolves (port,
data dir, sandbox backend, instance): **flag > environment variable >
config file > built-in default**. Empty-string values count as unset.

## Command Reference

### `valet serve`

Boots the full product with packaged defaults:

- **Port `8788`**. Change it with `--port`, `PORT`, or `config serve.port`.
- **Sandbox backend auto-detects**: `docker` when a reachable Docker
  daemon exists, else `local`. Override with
  `--sandbox docker|local|kubernetes`.
- **Auth defaults to the local stub** unless a real `BETTER_AUTH_SECRET`
  is configured. A fresh instance is therefore usable immediately, without
  an API key.
- **Storage** lives under the data dir (default `~/.valet`, override with
  `--data-dir` or `VALET_DATA_DIR`). The server boots embedded PGlite
  unless `serve.databaseUrl` or `DATABASE_URL` points at real Postgres.

Every server claims an exclusive `pg.lock` pidfile beside its PGlite data dir,
so two servers can never share one PGlite instance. If the lock's pid is still
running, a second server refuses to start, and the refusal names the process to
stop. A stale (dead-pid) or malformed lock is reclaimed automatically, so a
server stopped with `kill -9` does not block the next one. The lock is claimed
by the server boot, not by this command, so `make dev-local` and the bundled
binary are guarded the same way.

### `valet config get|set serve.<field> [value]`

View or edit the persisted `serve` block by dot-path. Settable fields:
`serve.port`, `serve.sandbox` (`docker|local|kubernetes`),
`serve.dataDir`, `serve.authMode` (`stub|real`), `serve.databaseUrl`.
Values are validated before the write. The config file is created `0600`.

### `valet sessions list|new|show <id>`

List sessions (an aligned table: id, status, title, workspace), create one
(`--workspace <path>`, optional `--title`,
`--profile headless|full`), or show one session's detail (status,
workspace, profile, message count, model).

### `valet send [words... | --text <prompt>]`

Send one prompt and stream the turn to completion: tokens inline, compact
tool-call lines, then exit. `send` targets `--session <id>` (and
optionally `--thread <id>`). Without a session, it targets your
orchestrator. If the turn stops on a decision gate, `send` prints the gate
with a `valet gates resolve …` hint and exits with code `3`. It never
blocks waiting for input.

### `valet chat`

Interactive REPL over the same streaming path. `--session` and `--thread`
are optional and default to the orchestrator. Decision gates render as
numbered options that you pick inline, and the turn resumes on the same
stream. Leave with `/exit` or Ctrl-D.

### `valet gates list` / `valet gates resolve <gateId> <option>`

Inspect and resolve pending decision gates (approvals, questions,
credential requests) without an interactive session. These commands
default to the orchestrator session. `--session <id>` overrides.

### `valet status`

Instance health plus client/server version skew. Skew is a warning
(stderr in human mode, a `skew` boolean in `--json`), not a failure.

### `valet mcp setup [claude-code] [--print] [--token <bearer>] [--name <n>]`

Wire a local agent to the instance's `/mcp` endpoint. For Claude Code, the
command merges a streamable-HTTP server entry into the project-local
`.mcp.json` and preserves everything else in the file. `--print` emits the
config JSON to stdout for any agent instead of writing.

The `/mcp` endpoint requires an OAuth **bearer token** from the instance's
MCP OAuth flow, not the `x-api-key` the other commands use. The endpoint
is mounted only when the instance runs real auth. Without `--token`, the
written config carries a `<MCP_OAUTH_TOKEN>` placeholder and the command
prints the caveat. With `--token`, the file is written with owner-only
permissions (`0600`).

### `valet reset [--yes]`

Wipe the local runtime state under the data dir: PGlite, blobs, and the
database lock. **`config.json` is preserved**, so your saved profiles
survive. The command refuses while a live server owns the dir, and
requires confirmation (interactive `y/N`, or `--yes` non-interactively).

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 2 | Usage error (bad arguments, refused operation) |
| 3 | Turn stopped on a pending decision gate (`send`) |
| 4 | Turn errored |
| 5 | Authentication failure |
| 6 | Instance unreachable |

## Scripting

`--json` switches supported commands to machine-readable output on stdout.
Warnings and caveats go to stderr, so pipes stay clean. Combined with the
exit codes above, this makes `send` usable in scripts: send a prompt,
branch on the exit code, parse the JSON.

## Getting the Binary

The fastest path is the install script. It detects your platform,
downloads the right binary, and installs it to `~/.local/bin`. Override
the directory with `VALET_INSTALL_DIR`. Pin a version with
`VALET_VERSION=v0.1.0`.

```bash
curl -fsSL https://raw.githubusercontent.com/tkhq/valet/dev-v2/scripts/install.sh | bash
```

Prebuilt binaries (macOS arm64/x64, Linux x64/arm64) are also on GitHub
Releases: versioned releases on `v*` tags, and a rolling `dev-v2-latest`
prerelease whose assets are replaced on every merge to `dev-v2`. The
prerelease download URLs
(`…/releases/download/dev-v2-latest/valet-<os>-<arch>`) are stable.
Download, `chmod +x`, run. Windows runs the linux-x64 binary under WSL.

**macOS Gatekeeper:** the binaries are ad-hoc signed, not notarized. A
*browser* download gets a quarantine flag, and macOS then shows a
misleading "binary is damaged and cannot be opened" dialog. Either clear
the flag with `xattr -d com.apple.quarantine ./valet-darwin-<arch>`, or
download via curl (the install script above, or `curl -LO`). A curl
download sets no quarantine flag and just runs.

Or build from source:

```bash
pnpm --filter @valet/api build:binary                       # host platform
pnpm --filter @valet/api build:binary --target bun-linux-x64  # cross-compile
```

This produces `dist/valet[-<os>-<arch>]`: a single file that embeds the
compiled server, the web client's static build, and migrations. During
development, the same CLI runs un-compiled via the package's dev entry
(`packages/api/src/cli.ts`).
