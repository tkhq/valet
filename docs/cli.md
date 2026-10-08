# The `valet` CLI

Valet ships as a single self-contained binary. Bun compiles it with the
web client and migrations embedded. The binary is both the server and its
client: `valet serve` boots the whole product, and the other subcommands
talk to any running instance — the one you just started or a remote
deployment. Source lives in `packages/api/src/cli/`.

`valet-secrets` is a different command. It runs inside a session sandbox, not
on your machine, and it resolves 1Password references into one command's
environment. See [Secrets with 1Password](./onepassword-secrets.md).

```
valet <command> [options]

Commands:
  serve       Boot the Valet server (the full product)
  sessions    List and inspect sessions on an instance
  send        Send a prompt to a session
  upload      Upload files to a session sandbox
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

## Agent onboarding

To connect a local coding agent (Claude Code, Codex, Cursor) to Valet, give it one instruction:

```text
Read https://<your-valet>/agent-setup.md and follow it.
```

Every Valet instance serves `/agent-setup.md` and `/agent-skill.md` without login. Each page fills in that instance's public URL (`VALET_PUBLIC_URL`, else a public `BETTER_AUTH_URL`, else the request origin). The setup page tells the agent to install the CLI, run `valet login` (the person approves it in the browser), connect MCP with `valet mcp setup`, install the `valet` skill from `/agent-skill.md`, and check the result. The agent never handles a secret: the CLI receives its token directly from the instance. The page sources are `packages/api/src/onboarding/agent-setup.md` and `valet-skill.md`.

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
valet login https://valet.example.com --name prod   # shows a code to enter in a browser
valet instance list          # show profiles + default
valet instance use prod      # make one the default
valet logout prod            # remove it
```

`login` shows a code such as `BCDF-GHJK` and opens `<instance>/cli/device`.
Type the code on that page and choose Allow. The browser can be on any
computer, so this also works over SSH. `--no-browser` only prints the page
URL. The CLI receives a CLI token, not an API key. The token refreshes
itself while you use the CLI, and signs out after 30 days without use.
Disconnect a CLI in Settings > Agent access, or with `valet logout`, which
also signs it out on the server. A new `login` signs out the one it
replaces.

`--no-wait` prints the code and exits. The CLI saves the waiting sign-in,
and the next `valet login` for the same profile resumes it. If the person
already chose Allow, it finishes at once. An agent uses this when its
commands cannot run for minutes. Other ways to log in:

- `--api-key vlt_...` uses a key you already have, for scripts and CI.
- `--api-key -` reads a key from a hidden prompt or stdin.
- An instance with stub auth (`VALET_LOCAL_AUTH=1`) needs no key.

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

`serve` claims an exclusive `serve.lock` pidfile in the data dir, so two
servers can never share one PGlite instance. If the lock's pid is still
running, a second `serve` refuses to start. A stale or malformed lock is
reclaimed automatically.

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

### `valet upload <session-id> <path...>`

Upload one or more files to a session's sandbox at `/workspace/uploads/`.
Each file is uploaded as a separate request. On success, returns the
attachment ref for each file. With `--message`, sends a follow-up message
with the refs spliced into its attachments and streams the reply.

**Examples:**

```bash
# Upload a single file
valet upload sess_abc report.pdf

# Upload multiple files
valet upload sess_abc data.zip README.md

# Upload with custom destination
valet upload sess_abc report.pdf --dest /workspace/uploads/custom.pdf

# Disable extraction (default: auto-extract zips, auto-transcribe PDFs)
valet upload sess_abc archive.zip --extract=false

# Upload and follow with a message
valet upload sess_abc report.pdf --message "summarize the findings"

# Overwrite if the destination file exists
valet upload sess_abc file.txt --overwrite
```

**Flags:**

| Flag                      | Notes                                                                   |
|---------------------------|-------------------------------------------------------------------------|
| `--dest <path>`           | Target path inside the sandbox. Only valid with a single file.          |
| `--extract auto\|true\|false` | Default `auto`. Controls zip extraction and PDF transcription.      |
| `--overwrite`             | Allow overwriting an existing file at the destination.                  |
| `--message "…"`           | After upload succeeds, send a follow-up message with the refs.          |

**Exit codes:** `0` on success, `1` on upload failure or network error, `3` if
the follow-up message blocks on a decision gate (same as `valet send`).

### `valet chat`

Interactive REPL over the same streaming path. `--session` and `--thread`
are optional and default to the orchestrator. Decision gates render as
numbered options that you pick inline, and the turn resumes on the same
stream. Leave with `/exit` or Ctrl-D.

### `valet gates list` / `valet gates resolve <gateId> <option>`

Inspect and resolve pending decision gates (approvals, questions,
credential requests) without an interactive session. These commands
default to the orchestrator session. `--session <id>` overrides.

A `valet login` CLI token is an agent credential. It can answer a question,
but it cannot approve a request or change a policy, because the onboarding
has a coding agent run `valet login`. Approve in the browser. To approve from
a terminal, create a key in Settings > API keys and log in with
`valet login <url> --api-key -`.

### `valet status`

Instance health plus client/server version skew. Skew is a warning
(stderr in human mode, a `skew` boolean in `--json`), not a failure.

### `valet mcp setup [claude-code|codex|cursor] [--project] [--print] [--token <bearer>] [--name <n>]`

Wire a local agent to the instance's `/mcp` endpoint, for every project:

- `claude-code` (default) runs `claude mcp add --transport http --scope user`.
  `--project` writes the project's `.mcp.json` instead.
- `codex` writes the server into `$CODEX_HOME/config.toml` (default
  `~/.codex`). Then run `codex mcp login <name>` in a terminal.
- `cursor` merges the server into `~/.cursor/mcp.json`.

`--print` emits the config JSON to stdout for any other agent, and writes
nothing.

The `/mcp` endpoint uses OAuth, not the `x-api-key` the other commands use.
It is mounted only when the instance runs real auth. The entry carries only
the endpoint URL. The agent signs in through the instance's OAuth flow, and
the person approves the app on Valet's consent page. In Claude Code, restart
it, run `/mcp`, and choose Authenticate. Disconnect an app in Settings > Agent
access. With `--token <bearer>`, the command writes `./.mcp.json` with an
`Authorization` header for a client that cannot run OAuth, with owner-only
permissions (`0600`).

The MCP tools let a local agent delegate work and follow it. See
[MCP agent tools](./specs/2026-10-07-mcp-agent-tools-design.md).

### `valet tools search|describe|call`

Use the integrations Valet brokers (GitHub, Slack, Linear, Google, and the MCP servers your organization connects) from a shell or an agent harness. Valet keeps the credentials. The organization's tool policies apply.

```bash
valet tools search "create issue" --service github
valet tools describe github.create_issue --params '{"owner":"tkhq","repo":"valet","title":"Bug"}'
valet tools call github.create_issue --params '{"owner":"tkhq","repo":"valet","title":"Bug"}'
valet tools call linear.create_issue --params-file issue.json --idempotency-key retry-1
```

`--workspace <team-id>` uses a team's credentials and policies. `--params-file -` reads the params from stdin. A repeated `--idempotency-key` returns the first result instead of running the tool again. `call` exits `0` when the tool completes, `3` when a policy requires approval (the tool did not run) or an earlier call with the same key is still running, and `4` when it fails. A failed call is not stored, so a retry with the same key runs again. MCP clients get the same tools as `search_tools`, `describe_tool`, and `call_tool`.

### `valet reset [--yes]`

Wipe the local runtime state under the data dir: PGlite, blobs, and the
serve lock. **`config.json` is preserved**, so your saved profiles
survive. The command refuses while a live `valet serve` owns the dir, and
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
