# `valet handoff` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `valet handoff <file>` CLI command that sends an agent-authored handoff doc to the orchestrator (default), an existing session (`--session`), or a fresh session (`--new-session`), per `docs/specs/2026-07-25-handoff-cli-design.md`.

**Architecture:** New command module `packages/api/src/cli/commands/handoff.ts` following the `send.ts` pattern exactly: a thin `run` shell (parse flags → `resolveInstance` → `InstanceClient`) delegating to pure, exported functions tested with stub clients. `--wait` reuses `consumeSend` exported from `send.ts`.

**Tech Stack:** TypeScript ESM, vitest, existing CLI infra (`InstanceClient`, `parseGlobalFlags`, `streamSession`, `ExitCode`).

## Global Constraints

- No `any`, no `as unknown as`, no `@ts-ignore` (CLAUDE.md Type Safety rules).
- Tests colocated: `packages/api/src/cli/commands/handoff.test.ts`, stub-client pattern from `send.test.ts`.
- Node 22 for test runs (`source ~/.nvm/nvm.sh && nvm use 22` if needed).
- Run: `pnpm --filter @valet/api test -- src/cli/commands/handoff` and `pnpm --filter @valet/api typecheck`.
- Commit after each task; terse commit messages, no AI co-author trailers.

## Facts pinned from the codebase (verified)

- `CommandModule` = `{ run(args, ctx): Promise<number> }` (`cli/types.ts`).
- `parseGlobalFlags` (`cli/output.ts`) → `{ json, rest, flags }`; `--key value` and `--key=value` both work; bare `--flag` → `true`.
- `InstanceClient` has `ensureOrchestrator()`, `createSession(body)`, `sendPrompt(id, body)`.
- `CreateSessionRequest` = `{ workspace: string; title?; initialPrompt?; profile?; repos?; repo?: RepoBinding }`; `RepoBinding` = `{ host?; fullName; cloneUrl; ref?; auth? }`.
- Web convention for repo sessions: `workspace = "/workspace/" + repoBaseName(fullName)`, `profile: "full"` (`packages/web/src/components/new-session-dialog.tsx:17,76,92`).
- Web session URL: `<instance url>/sessions/<id>`.
- `SendPromptResponse` = `{ messageId, threadId }`.
- `consumeSend(deps: SendDeps, ctx)` is exported from `send.ts`; only uses `deps.stream/url/apiKey` + ctx `{ sessionId, messageId, threadId, json }`.
- Exit codes: `OK=0, Usage=2, GatePending=3, TurnError=4` (`cli/exit.ts`).

---

### Task 1: Pure helpers + core `runHandoff` (no `--wait`)

**Files:**
- Create: `packages/api/src/cli/commands/handoff.ts`
- Test: `packages/api/src/cli/commands/handoff.test.ts`

**Interfaces (Produces):**

```ts
export interface HandoffClient {
  ensureOrchestrator(): Promise<EnsureOrchestratorResponse>;
  createSession(body: CreateSessionRequest): Promise<CreateSessionResponse>;
  sendPrompt(id: string, body: SendPromptRequest): Promise<SendPromptResponse>;
}
export interface HandoffDeps {
  client: HandoffClient;
  stream: StreamFn;               // re-exported type from send.js
  url: string;
  apiKey?: string;
  readStdin(): Promise<string>;   // injectable for tests
  readFile(path: string): string; // injectable for tests (wraps readFileSync)
  gitRemoteUrl(): string | undefined; // `git remote get-url origin`, undefined on failure
  env: { host: string; cwd: string };
}
export function parseGitRemote(remote: string): RepoBinding | undefined;
export function inferTitle(doc: string): string | undefined;   // first "# " heading text
export function provenanceHeader(env: { host: string; cwd: string }): string;
  // → "[Handoff from <host>:<cwd>]"
export async function resolveDoc(deps, flags): Promise<string | undefined>;
export async function runHandoff(deps: HandoffDeps, flags: ParsedFlags): Promise<number>;
export async function run(args: string[], ctx: CliContext): Promise<number>;
```

`parseGitRemote` handles `git@github.com:owner/name.git`, `https://github.com/owner/name.git`, `https://github.com/owner/name` → `{ fullName: "owner/name", cloneUrl: "https://github.com/owner/name.git" }`; returns `undefined` for anything it can't parse.

Behavior in `runHandoff`:
1. Doc source: positional `flags.rest[0]`, or `--file`, `-` = stdin. Missing → Usage error; empty/whitespace-only content → Usage error; unreadable file → Usage error with the fs message.
2. `--session` + `--new-session` together → Usage error.
3. Target: `--session <id>` → as-is; `--new-session` → repo from `--repo owner/name` (build binding directly) else `parseGitRemote(deps.gitRemoteUrl())`, error if neither; title from `--title` else `inferTitle(doc)`; `createSession({ workspace: "/workspace/" + baseName, title, profile: "full", repo })`; default → `ensureOrchestrator()`.
4. `sendPrompt(sessionId, { text: header + "\n\n" + doc })`.
5. Receipt: human → `handed off to <sessionId>\n<url>/sessions/<sessionId>`; `--json` → `printJson({ sessionId, threadId, messageId, url })`.
6. If `--new-session` creation succeeded but `sendPrompt` threw: print the created session id to stderr (`retry with: valet handoff --session <id> <file>`) then rethrow.

**Steps:**

- [ ] **Step 1:** Write `handoff.test.ts` covering: default orchestrator path (ensure called, prompt text = header + doc); `--session s1` (no ensure); `--new-session` with `--repo o/n` (createSession body incl. workspace/profile/repo/title-from-heading); `--new-session` git-remote inference (ssh + https forms via `parseGitRemote` unit cases); no-remote error; stdin (`-`); empty-doc error; missing-doc usage error; `--session`+`--new-session` mutual-exclusion error; `--json` receipt shape; sendPrompt-failure-after-create prints retry hint. Use the `send.test.ts` stub pattern (stdout/stderr spies, stub `HandoffClient`).
- [ ] **Step 2:** Run `pnpm --filter @valet/api test -- src/cli/commands/handoff` — expect FAIL (module missing).
- [ ] **Step 3:** Implement `handoff.ts` per the interface block above. `--wait` flag parsed but for now behaves as no-wait (Task 2 wires it).
- [ ] **Step 4:** Re-run tests — expect PASS. Run `pnpm --filter @valet/api typecheck`.
- [ ] **Step 5:** Commit: `feat(cli): valet handoff — core command`

### Task 2: `--wait` via `consumeSend`

**Files:**
- Modify: `packages/api/src/cli/commands/handoff.ts`
- Test: `packages/api/src/cli/commands/handoff.test.ts`

**Interfaces:** Consumes `consumeSend`, `SendDeps`, `StreamFn` from `./send.js`. Adds a 120s timeout: `Promise.race([consumeSend(...), timeout])`; on timeout print `valet handoff: timed out waiting for a response (handoff was delivered)` and return `ExitCode.OK` (the handoff itself succeeded — waiting is best-effort).

**Steps:**

- [ ] **Step 1:** Add tests: `--wait` with a scripted stream ending in `submission.settled(completed)` → exit OK and deltas rendered; settled `failed` → `ExitCode.TurnError`; receipt still printed before streaming.
- [ ] **Step 2:** Run tests — expect FAIL.
- [ ] **Step 3:** Implement: after the receipt, when `flags.flags.wait === true`, build `SendDeps` from `HandoffDeps` and race `consumeSend` against the timer (timer `unref()`d).
- [ ] **Step 4:** Run tests + typecheck — expect PASS.
- [ ] **Step 5:** Commit: `feat(cli): valet handoff --wait`

### Task 3: Register in dispatcher + usage

**Files:**
- Modify: `packages/api/src/cli.ts` (COMMANDS table + USAGE text)

**Steps:**

- [ ] **Step 1:** Add `handoff: () => import("./cli/commands/handoff.js")` and a USAGE line: `handoff     Hand off work from a local agent to Valet`.
- [ ] **Step 2:** Run full CLI test dir: `pnpm --filter @valet/api test -- src/cli` and typecheck — expect PASS.
- [ ] **Step 3:** Commit: `feat(cli): register handoff command`

### Task 4: Spec touch-up

**Files:**
- Modify: `docs/specs/2026-07-25-handoff-cli-design.md` (Status → Implemented; record deviations: provenance header omits agent name, `--wait` timeout exits OK, repo sessions use `/workspace/<name>` + `profile: "full"`).

**Steps:**

- [ ] **Step 1:** Edit spec, commit: `docs(specs): handoff — implemented + deviations`
