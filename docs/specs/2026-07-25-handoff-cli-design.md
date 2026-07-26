# `valet handoff` — CLI design

**Date:** 2026-07-25
**Status:** Approved design, not yet implemented

## Purpose

Let a local coding agent (Claude Code, Codex, or any tool that can shell out) hand
its current work off to Valet. The user says "hand off to Valet"; the agent writes a
handoff document to a file and runs `valet handoff <file>`. The doc lands as a
message in the user's orchestrator session (default) or a chosen/new session.

Key framing decisions:

- **The calling agent authors the handoff doc itself.** It has the conversation in
  its head; a self-written brief (task, state, decisions, next steps) is higher
  signal than any transcript dump. The CLI does **not** parse Claude Code / Codex
  session JSON — that was considered and dropped (undocumented, churning formats;
  the agent can paste excerpts into the doc if it wants them).
- **The doc is a file, not a CLI argument string**, so long, multi-line, markdown-heavy
  briefs (specs, file lists, code blocks) don't fight shell quoting.
- **The orchestrator is the front door.** It receives the handoff and decides
  whether to act directly or spawn a child session — routing intelligence lives
  valet-side, matching the Jarvis model. Overrides exist for targeting an existing
  or fresh session.

## Command surface

```
valet handoff <file>              # send doc to orchestrator (default)
valet handoff --file <file>       # equivalent explicit form
cat doc.md | valet handoff -      # stdin
  --session <id>                  # target an existing session instead
  --new-session                   # create a fresh session and send there
  --repo <owner/name>             # repo for --new-session (default: inferred from cwd git remote)
  --title <text>                  # title for --new-session (default: first "# " heading of the doc)
  --wait                          # stream until the target's first response, then exit
  --json                          # machine-readable receipt (for the calling agent)
```

- `--session` and `--new-session` are mutually exclusive.
- The doc content is sent verbatim as the message text, prefixed with a one-line
  provenance header the CLI adds: `[Handoff from <agent> on <host>:<cwd>]`.
- Default output is a human receipt: target session id + web URL. `--json` emits
  `{ sessionId, threadId, messageId, url }` so the calling agent can relay a link
  to its user. With `--wait`, the target's first assistant response is printed
  before exit (guarded by a ~120s timeout so the CLI can never hang the caller
  indefinitely).

## Implementation shape

A new command module following the existing CLI pattern — no API/server changes:

- `packages/api/src/cli/commands/handoff.ts` (+ colocated `handoff.test.ts`),
  registered in the subcommand table in `packages/api/src/cli.ts`.
- Reuses `cli/resolve.ts` (instance resolution), `cli/config.ts` (api key),
  `InstanceClient` (`cli/client.ts`, sends `x-api-key`), and `cli/stream.ts`
  for `--wait` — the same plumbing `valet send` uses.

Alternatives considered and rejected:

- **Extend `valet send` with `--file`** — buries a verb agents will be explicitly
  told about, and leaves no room for handoff-specific behavior (`--new-session`,
  receipt format).
- **Server-side `POST /api/handoff` endpoint** — only justified if the server did
  something special with handoffs (tagging, attachments). It doesn't, for v1.

## Flow

1. Resolve instance + auth exactly as `send` does.
2. Read the doc (positional path, `--file`, or `-` for stdin). Empty input is an
   error, not an empty message.
3. Resolve the target:
   - default → `POST /api/orchestrator` (ensure-if-absent) → its `sessionId`;
   - `--session <id>` → use as-is (API 404 surfaces as a clean error);
   - `--new-session` → infer repo from `git remote get-url origin` unless
     `--repo` given, title from the doc's first `# ` heading unless `--title`,
     then `POST /api/sessions`. Note the local cwd path is meaningless on the
     valet server, which is why the workspace is repo-shaped; if there is no git
     remote and no `--repo`, fail with a clear message.
4. `POST /api/sessions/:id/messages` with the provenance header + doc content.
5. Print the receipt (or `--json`). With `--wait`, attach via the existing stream
   infra until the first assistant message completes, print it, exit.

## Error handling

All failures exit nonzero with a one-line actionable message:

- not logged in / no instance configured → point at `valet login`
- unreadable or empty doc file
- `--new-session` with no inferable repo → say to pass `--repo`
- `--session` + `--new-session` together → mutually exclusive
- API errors passed through with status

No partial states to clean up — if `--new-session` creation succeeds but the
message post fails, print the created session id so the handoff can be retried
with `--session <id>`.

## Testing

Colocated `handoff.test.ts` following the existing command-test pattern (mocked
`InstanceClient`), covering:

- default orchestrator path (ensure + post)
- `--session <id>` targeting
- `--new-session`: repo inference from git remote, `--repo` override, title
  inference from first heading, no-remote error
- stdin (`-`) input
- empty-input error
- `--session`/`--new-session` mutual-exclusion error
- `--json` receipt shape

`--wait` is tested at whatever level `send`'s streaming behavior is already
tested.

## Out of scope (v1)

- Parsing Claude Code / Codex session transcripts (dropped, see Purpose).
- File attachments beyond the doc itself — a real attachment/upload API is the
  right long-term answer if agents need to ship extra files; for now anything
  extra gets inlined into the doc or referenced via a pushed git branch.
- Any server-side handoff awareness (tagging, dedicated endpoint).
