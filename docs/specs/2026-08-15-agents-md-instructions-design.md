# AGENTS.md repo instructions — design

Date: 2026-08-15
Status: proposed
Scope: `@valet/engine` (prompt assembly), `packages/api` (workspace read seam)

## Problem

Valet clones a repository into the sandbox but never reads the repository's
agent instructions. A repo that ships an `AGENTS.md` (https://agents.md/) —
build commands, code style, test instructions, commit conventions — gets none
of that context into the model. The agent rediscovers it by trial and error,
or violates it.

This spec adds first-class support for the AGENTS.md format.

## The AGENTS.md format (external spec)

AGENTS.md is "a README for agents": standard Markdown, no required fields, no
frontmatter. The format's normative behavior, quoted from https://agents.md/:

1. Location: the repository root, with nested instances permissible in
   monorepo subprojects.
2. Precedence: "The closest AGENTS.md to the edited file wins; explicit user
   chat prompts override everything."
3. Monorepos: "Agents automatically read the nearest file in the directory
   tree, so the closest one takes precedence and every subproject can ship
   tailored instructions."
4. Expected agent behavior: parse the instructions, run the programmatic
   checks the file names, and attempt to fix failures before completing tasks.

Minimum conformance for Valet: load the root file into the model's context,
honor nested-file precedence, and keep user prompts authoritative over file
content.

## Decisions

### 1. Read on every attachment `ready` transition, not in a prep step

The host reads AGENTS.md from the sandbox each time the sandbox attachment
transitions to `ready` — the same lifecycle the workspace-skills command
registry already uses (`refreshCommandRegistry()`, driven by `onSessionReady`
in `packages/api/src/engine/hibernation-hooks.ts`).

Why not a prep step (`packages/api/src/engine/prep-steps.ts`, the start-ref
pattern): prep steps run only on the cold `doProvision` path. A session object
rebuilt against a warm sandbox (host eviction), or a hibernation wake, never
re-runs them — the instructions would silently vanish for the rest of the
session. The `ready` transition fires in all three cases (cold boot, wake,
rebuild), needs no persistence or migration, and picks up mid-session edits to
the file at natural boundaries.

The content lives in memory on the `Session` for the current attachment
epoch. Nothing is persisted; a stale copy cannot outlive the sandbox state it
was read from.

### 2. One exec discovers and reads all AGENTS.md files

A single `sandbox.exec` per refresh:

- `find` every `AGENTS.md` under each repo binding's `targetDir`, excluding
  `.git` and `node_modules`, capped at 25 files.
- Dump the primary binding's root `AGENTS.md` content (the same
  one-exec-dumps-everything pattern as the workspace-skills scan in
  `packages/api/src/engine/command-providers.ts`).

A missing file is not an error: the session simply carries no repo
instructions. Read failures are logged and degrade to "no instructions" —
never fail the turn.

### 3. Inline the root file; list nested files with a precedence instruction

The injected fragment has three parts:

1. A short preamble: "The repository provides AGENTS.md instructions for
   coding agents. Follow them. Explicit user instructions in the conversation
   override them."
2. The primary binding's root `AGENTS.md` content, verbatim.
3. When nested `AGENTS.md` files exist, a list of their paths with the spec's
   precedence rule: "Before you edit files under these directories, read the
   nearest AGENTS.md; the closest one to the edited file wins."

This satisfies the nested-file behavior without static resolution: the engine
cannot know at prompt-assembly time which files a turn will touch, so it
inlines what is unconditionally relevant (the root) and directs the model to
its `read` tool for the rest. Secondary repo bindings get the same treatment
as nested files: their root `AGENTS.md` paths appear in the list, not inline.

The user-prompt-precedence sentence in the preamble is what makes rule 2 of
the external spec hold; the system prompt must not let file content outrank
the conversation.

### 4. Injection is a per-turn system-prompt overlay in the engine

The base system prompt is assembled once at `Thread` construction
(`buildBaseSystemPrompt`, `packages/engine/src/thread.ts`), before any clone
has run — so AGENTS.md cannot ride the static `systemContext` array. Instead
the thread applies the fragment per turn, the same append/restore idiom as
`applyRoleForTurn` and `applyColdHintForTurn`.

Composition order per turn:

```
base → systemContext → repo instructions → role overlay → cold hint
```

The repo-instructions overlay is applied first (before the role overlay) and
restored last, so the existing overlays nest unchanged around it. A turn that
starts before the first `ready` transition simply runs without the fragment —
the same graceful degradation as the cold-sandbox hint.

Concurrency contract: `Session` stores the provider result as one immutable
`RepoInstructions | null` reference, and `refreshRepoInstructions()` replaces
that reference in a single assignment after the provider resolves — it never
mutates the stored object. The overlay reads the reference exactly once, at
turn start, when it builds and appends the fragment; the appended string is a
turn-local copy. A refresh that lands mid-turn (e.g. a hibernation-wake
`ready` transition racing an in-flight turn) therefore cannot change the
prompt a running turn already carries. Either the turn read the old reference
or the new one — both are complete, coherent snapshots — and the new value
takes effect on the next turn's overlay. Implementations MUST NOT re-read the
stored value after the turn-start snapshot.

### 5. Host seam mirrors `workspaceSkillsProvider`

`CreateSessionOptions` gains an optional provider:

```ts
repoInstructionsProvider?: () => Promise<RepoInstructions | null>;

interface RepoInstructions {
  /** Root AGENTS.md content of the primary binding, already size-capped. */
  content: string;
  /** Workspace-relative paths of other AGENTS.md files (nested + secondary bindings). */
  nestedPaths: string[];
}
```

Absent provider === no behavior change (every existing session, and every
test, is untouched). The api wires it only when the session has a prepared
workspace (`hasPrep`, the same gate as `workspaceSkillsProvider` in
`EngineHost.buildCommandOptions`) — an orchestrator or repo-less session
never execs a scan. `Session.refreshRepoInstructions()` calls the provider
and stores the result; the host invokes it from the same `onSessionReady`
hook that refreshes the command registry.

The engine owns the preamble and fragment formatting; the host owns discovery
and reading. This keeps the engine free of workspace-layout knowledge
(`/workspace`, binding target dirs), which lives in the api today.

### 6. Size cap

The inlined root content is capped at 24 KB (~6k tokens). Beyond the cap the
host truncates at the limit and appends a marker line:
`[truncated — read /workspace/AGENTS.md for the full file]`. The cap protects
the context budget of every turn in the session; the marker keeps the full
content reachable through the `read` tool.

### 7. CLAUDE.md fallback

When the primary binding root has no `AGENTS.md` but has a `CLAUDE.md`, the
host reads `CLAUDE.md` instead, with the same preamble, cap, and precedence
rules. This is a Valet extension, not part of the AGENTS.md spec — many
repositories carry only a `CLAUDE.md`, and the files serve the identical
purpose. `AGENTS.md` wins when both exist. Nested discovery looks for
`AGENTS.md` only; nested `CLAUDE.md` conventions vary too much across tools
to promise precedence behavior for them.

## What this does NOT do

- No static nested-file resolution. The engine does not map edited files to
  their nearest AGENTS.md; the model does, via the listed paths (decision 3).
- No persistence. Instructions are re-read per `ready` transition and held in
  memory (decision 1).
- No config-file execution. The external spec mentions tools that read
  companion config files (`.aider.conf.yml` etc.); Valet does not.
- No UI surface. The fragment is visible in the system prompt like role
  overlays are today; a future inspector affordance is out of scope.

## Testing

- Engine unit test: overlay composition order and restore nesting with role +
  cold hint + repo instructions all active in one turn; a turn with no
  provider and a turn where the provider returns null.
- Engine unit test: a `refreshRepoInstructions()` that resolves mid-turn does
  not change the in-flight turn's system prompt; the next turn carries the new
  content (the turn-start snapshot contract, decision 4).
- Api unit test: the scan exec output parses into `RepoInstructions` — root
  content, nested paths, cap + truncation marker, CLAUDE.md fallback,
  missing-file → null.
- Api integration test: a session against a fixture repo containing a root
  `AGENTS.md` and one nested file; assert the turn's system prompt contains
  the root content and the nested path list after the attachment is ready.
- Regression: `pnpm --filter @valet/engine test happy-path` and the api
  integration suite stay green with no provider wired.
