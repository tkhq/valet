# The `valet` CLI

Valet ships as a single self-contained binary (Bun-compiled, embedding the
web client and migrations) that is both the server and its client:
`valet serve` boots the whole product, and the other subcommands talk to any
running instance — the one you just started or a remote deployment. Source
lives in `packages/api/src/cli/`.

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

`serve` writes an implicit `local` profile into the CLI config after it
starts listening, so the client subcommands work against the local instance
out of the box — no `login` needed.

## Instances and Profiles

Client subcommands target a named **instance profile** — a `{ url, apiKey? }`
pair stored in `~/.valet/config.json`:

```bash
valet login https://valet.example.com --api-key vlt_... --name prod
valet instance list          # show profiles + default
valet instance use prod      # make one the default
valet logout prod            # remove it
```

`login` verifies the credential against the instance before persisting, and
makes the new profile the default. Which profile a command uses resolves in
order: `--instance <name>` flag > `VALET_INSTANCE` env > `defaultProfile`
in the config file.

That precedence rule is general: **flag > environment variable > config
file > built-in default** for every setting the CLI resolves (port, data
dir, sandbox backend, instance). Empty-string values count as unset.

## Command Reference

### `valet serve`

Boots the full product with packaged defaults:

- **Port `8788`** (`--port`, `PORT`, or `config serve.port` to change).
- **Sandbox backend auto-detects**: `docker` if a reachable Docker daemon is
  found, else `local`. Override with `--sandbox docker|local|kubernetes`.
- **Auth defaults to the local stub** unless a real `BETTER_AUTH_SECRET` is
  configured, so a fresh instance is immediately usable without an API key.
- **Storage** under the data dir (default `~/.valet`; `--data-dir` /
  `VALET_DATA_DIR`): embedded PGlite unless `serve.databaseUrl` /
  `DATABASE_URL` points at real Postgres.

`serve` claims an exclusive `serve.lock` pidfile in the data dir so two
servers can never share one PGlite instance. A live lock (its pid still
running) makes a second `serve` refuse; a stale or malformed lock is
reclaimed automatically.

### `valet config get|set serve.<field> [value]`

View or edit the persisted `serve` block by dot-path. Settable fields:
`serve.port`, `serve.sandbox` (`docker|local|kubernetes`), `serve.dataDir`,
`serve.authMode` (`stub|real`), `serve.databaseUrl`. Values are validated
before writing; the config file is created `0600`.

### `valet sessions list|new|show <id>`

List sessions (aligned table: id, status, title, workspace), create one
(`--workspace <path>`, optional `--title`, `--profile headless|full`), or
show one session's detail (status, workspace, profile, message count,
model).

### `valet send [words... | --text <prompt>]`

Send one prompt and stream the turn to completion: tokens inline, compact
tool-call lines, then exit. Targets `--session <id>` (and optionally
`--thread <id>`); without a session it targets your orchestrator. If the
turn stops on a decision gate, `send` prints the gate with a
`valet gates resolve …` hint and exits with code `3` — it never blocks
waiting for input.

### `valet chat`

Interactive REPL over the same streaming path (`--session` / `--thread`
optional; defaults to the orchestrator). Decision gates render as numbered
options you pick inline — the turn then resumes on the same stream. `/exit`
or Ctrl-D leaves.

### `valet gates list` / `valet gates resolve <gateId> <option>`

Inspect and resolve pending decision gates (approvals, questions,
credential requests) without an interactive session. Defaults to the
orchestrator session; `--session <id>` overrides.

### `valet status`

Instance health plus client/server version skew. Skew is a warning (stderr
in human mode, a `skew` boolean in `--json`), not a failure.

### `valet mcp setup [claude-code] [--print] [--token <bearer>] [--name <n>]`

Wire a local agent to the instance's `/mcp` endpoint. For Claude Code it
merges a streamable-HTTP server entry into the project-local `.mcp.json`
(preserving everything else in the file); `--print` emits the config JSON
to stdout for any agent instead of writing.

The `/mcp` endpoint requires an OAuth **bearer token** from the instance's
MCP OAuth flow — not the `x-api-key` the other commands use — and is only
mounted when the instance runs real auth. Without `--token`, the written
config carries a `<MCP_OAUTH_TOKEN>` placeholder and the command prints the
caveat. With `--token`, the file is written with owner-only permissions
(`0600`).

### `valet reset [--yes]`

Wipe the local runtime state under the data dir — PGlite, blobs, the serve
lock — while **preserving `config.json`** (your saved profiles survive).
Refuses while a live `valet serve` owns the dir, and requires confirmation
(interactive `y/N`, or `--yes` non-interactively).

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

`--json` switches supported commands to machine-readable output on stdout
(warnings and caveats go to stderr, so pipes stay clean). Combined with the
exit codes above, this makes `send` usable in scripts: send a prompt, branch
on exit code, parse the JSON.

## Building the Binary

```bash
pnpm --filter @valet/api build:binary                       # host platform
pnpm --filter @valet/api build:binary --target bun-linux-x64  # cross-compile
```

Produces `dist/valet[-<os>-<arch>]` — a single file embedding the compiled
server, the web client's static build, and migrations. During development
the same CLI runs un-compiled via the package's dev entry
(`packages/api/src/cli.ts`).
