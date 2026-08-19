# Harness Feedback Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the platform-agent pain points from the 2026-08-18 harness feedback: silent 256 KiB output truncation, blank tool-call turns in `thread_read`/`child_read`, no child liveness signal, no push-capability signal in the orchestrator persona, and the debug transcript's unlabeled lossy projection.

**Architecture:** Three independent PRs against `dev-v2`. PR 1 threads the existing sandbox `truncated` flag through `JobPoll` and the `bash` tool, and makes `renderEntries` render tool-call parts and attachments. PR 2 adds a `child_status` built-in (same reader-injection seam as `child_read`) plus persona prompt clarifications. PR 3 adds a fidelity note to the web debug transcript.

**Tech Stack:** TypeScript, vitest, TypeBox (engine tool schemas), Drizzle (api), pnpm workspace.

**Spec:** This plan implements fixes agreed in conversation from the harness feedback session; the subsystem specs it amends are `docs/specs/2026-05-02-portable-runtime-engine-design.md` and `docs/specs/2026-07-11-orchestrator-engine-design.md`.

## Global Constraints

- Base branch and PR target: `dev-v2` (main is frozen legacy).
- No `any`, no `as unknown as T`, no `@ts-ignore` (CLAUDE.md Type safety).
- Every user-facing message that reports a problem names the corrective action.
- Prose (comments, spec deltas, PR text) follows ASD-STE100 as adapted in CLAUDE.md.
- When you modify a subsystem, update its spec in `docs/specs/` in the same commit.
- Commit subjects ≤ 72 chars. No AI co-author trailers.
- Node 22 (`nvm use 22`) for all test runs.
- Vitest filters: `pnpm --filter @valet/engine test <filter>` — never put `--` before the filter.

## Non-goals (deferred, do not build)

- Incremental persistence of job output across API restarts (claim 2 deep fix).
- A delegated-push primitive or `initial_diff` child handoff (claims 5/6 deep fix).
- `truncated` reporting from the kubernetes job poller (file-based; needs its own design).
- `lastActivityAt` on the REST `/api/orchestrator/children` response (web UI concern, not the agent-facing gap).

---

# PR 1 — engine: mark truncated output; render tool-call parts

Branch: `fix/bash-output-truncation-markers` off `dev-v2`.

### Task 1: `JobPoll.truncated` + provider tracking

**Files:**
- Modify: `packages/engine/src/types.ts` (interface `JobPoll`, ~line 878)
- Modify: `packages/sandbox-docker/src/sandbox.ts` (`DockerJobState` ~line 24, `execJob` appendOutput ~line 586, `pollJob` ~line 659)
- Modify: `packages/sandbox-local/src/sandbox.ts` (`LocalJobState` ~line 21, `execJob` appendOutput ~line 150, `pollJob` ~line 185)
- Modify: `packages/engine/src/providers/sandbox/virtual.ts` (`execJob` ~line 148)
- Test: `packages/sandbox-local/test/job-mode.test.ts` (append one test)

**Interfaces:**
- Consumes: existing `ExecOpts.maxOutputBytes` cap (already enforced in all three providers).
- Produces: `JobPoll.truncated?: boolean` — set by a provider when the job's capped buffer dropped bytes. Task 2's poll loop reads it.

- [ ] **Step 1: Write the failing provider test**

Append to `packages/sandbox-local/test/job-mode.test.ts` (match its existing setup — it constructs a local sandbox; reuse the file's existing factory/helpers for sandbox creation and polling):

```ts
it("reports truncated on the poll once the capped buffer drops bytes", async () => {
  const handle = await sandbox.execJob("printf 'abcdefghij'", { maxOutputBytes: 4 });
  let poll = await sandbox.pollJob(handle.execId, 0);
  while (poll.status === "running") {
    await new Promise((r) => setTimeout(r, 25));
    poll = await sandbox.pollJob(handle.execId, poll.nextOffset);
  }
  expect(poll.status).toBe("done");
  expect(poll.truncated).toBe(true);
});
```

Adapt the sandbox variable name/setup to the file's existing `describe` block idiom (read the file first; it already has execJob/pollJob tests to copy from).

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @valet/sandbox-local test job-mode`
Expected: FAIL — `poll.truncated` is `undefined` (and a type error until Step 3 adds the field).

- [ ] **Step 3: Add the field to `JobPoll`**

In `packages/engine/src/types.ts`, inside `interface JobPoll`:

```ts
export interface JobPoll {
  status: "running" | "done" | "failed";
  exitCode?: number;
  output: string;
  nextOffset: number;
  /** True when the job's capped output buffer (maxOutputBytes) dropped
   * bytes. Optional: a provider that cannot detect the drop omits it. */
  truncated?: boolean;
}
```

- [ ] **Step 4: Track truncation in sandbox-local**

In `packages/sandbox-local/src/sandbox.ts`:

`LocalJobState` gains the field:

```ts
interface LocalJobState {
  status: "running" | "done" | "failed";
  exitCode?: number;
  output: string;
  truncated?: boolean;
  child: ChildProcess;
  /** Resolves once the child has actually exited (close/error fired). */
  closed: Promise<void>;
  evictTimer?: NodeJS.Timeout;
}
```

`appendOutput` in `execJob` records the drop:

```ts
const appendOutput = (chunk: string) => {
  if (limit && state.output.length >= limit) {
    state.truncated = true;
    return;
  }
  state.output += chunk;
  if (limit && state.output.length > limit) {
    state.output = state.output.slice(0, limit);
    state.truncated = true;
  }
};
```

`pollJob`, after `if (state.status === "done") result.exitCode = state.exitCode;`:

```ts
if (state.truncated) result.truncated = true;
```

- [ ] **Step 5: Run the provider test to verify it passes**

Run: `pnpm --filter @valet/sandbox-local test job-mode`
Expected: PASS (all tests in the file).

- [ ] **Step 6: Mirror in sandbox-docker**

In `packages/sandbox-docker/src/sandbox.ts` make the same three edits: `truncated?: boolean;` on `DockerJobState` (after `output`), `state.truncated = true;` at both cap points inside `appendOutput` (the early-return branch and the slice branch — the function takes `(chunk, isStderr)` there; only the shared cap logic changes), and `if (state.truncated) result.truncated = true;` in `pollJob` after the `exitCode` line.

- [ ] **Step 7: Mirror in the virtual sandbox**

In `packages/engine/src/providers/sandbox/virtual.ts`, `execJob` stores the sync result's flag so `pollJob`'s spread passes it through:

```ts
async execJob(command: string, opts?: ExecOpts): Promise<ExecJobHandle> {
  const execId = `job-${this.nextJobId++}`;
  const result = await this.exec(command, opts);
  const output = result.stdout + result.stderr;
  this.jobs.set(execId, {
    status: "done",
    exitCode: result.exitCode,
    output,
    nextOffset: output.length,
    ...(result.truncated ? { truncated: true } : {}),
  });
  return { execId };
}
```

If the `jobs` map's value type is narrower than `JobPoll`, widen it to include `truncated?: boolean`.

- [ ] **Step 8: Typecheck and run the touched suites**

Run: `pnpm typecheck && pnpm --filter @valet/sandbox-local test job-mode && pnpm --filter @valet/sandbox-docker test && pnpm --filter @valet/engine test`
Expected: PASS. (Docker suite needs the daemon; if a docker-dependent row flakes, re-run it in isolation before treating it as real.)

- [ ] **Step 9: Commit**

```bash
git add packages/engine/src/types.ts packages/sandbox-local packages/sandbox-docker packages/engine/src/providers/sandbox/virtual.ts
git commit -m "feat(sandbox): report job output truncation on JobPoll"
```

### Task 2: `bash` tool truncation markers

**Files:**
- Modify: `packages/engine/src/builtin-tools/index.ts` (`pollJobToCompletion` ~line 97, `bashTool.execute` sync path ~line 236)
- Test: Create `packages/engine/test/bash-truncation.test.ts`

**Interfaces:**
- Consumes: `ExecResult.truncated` (existing) and `JobPoll.truncated` (Task 1).
- Produces: exported `BASH_TRUNCATION_NOTE: string` appended to tool output; tests and future callers may assert on it.

- [ ] **Step 1: Write the failing tests**

Create `packages/engine/test/bash-truncation.test.ts`. Copy the `stubCredentials`/`makeCtx`/`FakeSandbox` idiom verbatim from `packages/engine/test/bash-job-mode.test.ts` (lines 21–66), then:

```ts
describe("bash tool: truncation markers", () => {
  it("appends the truncation note when sync exec reports truncated", async () => {
    const sandbox: FakeSandbox = {
      id: "sb-t1",
      exec: vi.fn(
        async (): Promise<ExecResult> => ({ stdout: "head-of-output", stderr: "", exitCode: 0, truncated: true }),
      ),
    };
    const result = await bashTool.execute({ command: "yes | head -c 1M" }, makeCtx(sandbox));
    expect(result.text).toContain("head-of-output");
    expect(result.text).toContain(BASH_TRUNCATION_NOTE.trim());
  });

  it("appends the truncation note when any job poll reports truncated", async () => {
    const polls: JobPoll[] = [
      { status: "running", output: "part1 ", nextOffset: 6, truncated: true },
      { status: "done", exitCode: 0, output: "part2", nextOffset: 11 },
    ];
    const sandbox: FakeSandbox = {
      id: "sb-t2",
      execJob: vi.fn(async (): Promise<ExecJobHandle> => ({ execId: "job-1" })),
      pollJob: vi.fn(async (): Promise<JobPoll> => polls.shift() ?? { status: "done", exitCode: 0, output: "", nextOffset: 11 }),
      cancelJob: vi.fn(async () => {}),
    };
    const result = await bashTool.execute({ command: "long", timeout: 61 }, makeCtx(sandbox));
    expect(result.text).toContain("part1 part2");
    expect(result.text).toContain(BASH_TRUNCATION_NOTE.trim());
  });

  it("does not add the note when nothing was truncated", async () => {
    const sandbox: FakeSandbox = {
      id: "sb-t3",
      exec: vi.fn(async (): Promise<ExecResult> => ({ stdout: "clean", stderr: "", exitCode: 0 })),
    };
    const result = await bashTool.execute({ command: "echo clean" }, makeCtx(sandbox));
    expect(result.text).toBe("clean");
  });
});
```

Import `BASH_TRUNCATION_NOTE` alongside `bashTool` from `../src/builtin-tools/index.js`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @valet/engine test bash-truncation`
Expected: FAIL — `BASH_TRUNCATION_NOTE` is not exported.

- [ ] **Step 3: Implement the markers**

In `packages/engine/src/builtin-tools/index.ts`, next to the other exported bash constants:

```ts
/**
 * Appended to bash output when the sandbox reports its output cap dropped
 * bytes. Truncation keeps the head and drops the tail, so the note names
 * the recovery moves (repo rule: an error message names the corrective
 * action).
 */
export const BASH_TRUNCATION_NOTE =
  "\n[output truncated: the sandbox capped this command's output and dropped the tail. " +
  "Narrow the output (grep, tail, --quiet) or redirect it to a file and read the file in slices.]";
```

Sync path (replace the two-line return at ~line 236):

```ts
    const result = await ctx.sandbox.exec(args.command, { signal: ctx.signal, timeout: timeoutMs });
    const exitNote = result.exitCode === 0 ? "" : `\n[exit ${result.exitCode}]`;
    const truncNote = result.truncated ? BASH_TRUNCATION_NOTE : "";
    return { text: `${result.stdout}${result.stderr}${truncNote}${exitNote}` };
```

Job path — in `pollJobToCompletion`, add `let truncated = false;` beside `let output = "";`, set it after each poll, and append the note on every exit path (timeout, done, failed):

```ts
    const poll = await pollJob(execId, offset);
    pollCount++;
    output += poll.output;
    offset = poll.nextOffset;
    if (poll.truncated) truncated = true;
```

```ts
    if (Date.now() >= deadline) {
      await bestEffortCancel(cancelJob, execId);
      const truncNote = truncated ? BASH_TRUNCATION_NOTE : "";
      return { text: `${output}${truncNote}\n[timed out after ${Math.round(timeoutMs / 1000)}s]` };
    }
```

```ts
    if (poll.status === "done") {
      const exitNote = poll.exitCode !== undefined && poll.exitCode !== 0 ? `\n[exit ${poll.exitCode}]` : "";
      const truncNote = truncated ? BASH_TRUNCATION_NOTE : "";
      return { text: `${output}${truncNote}${exitNote}` };
    }
    if (poll.status === "failed") {
      const truncNote = truncated ? BASH_TRUNCATION_NOTE : "";
      return { text: `${output}${truncNote}\n[job failed]` };
    }
```

Note the deadline check runs before the poll, so hoisting `truncNote` above the deadline branch computes it from the prior iteration's state — compute it inline per branch as shown.

- [ ] **Step 4: Run the engine suite**

Run: `pnpm --filter @valet/engine test`
Expected: PASS, including `bash-job-mode` and `long-exec-job-mode` (their fixtures never set `truncated`, so output is unchanged for them).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/builtin-tools/index.ts packages/engine/test/bash-truncation.test.ts
git commit -m "feat(engine): bash tool marks truncated output with a recovery note"
```

### Task 3: `renderEntries` renders tool-call parts and attachments

**Files:**
- Modify: `packages/engine/src/builtin-tools/index.ts` (`renderEntries` ~line 266)
- Test: Extend `packages/engine/test/child-read-tool.test.ts`

**Interfaces:**
- Consumes: `MessagePart` and `MessageEntry.attachments` from `../src/types.js` (already defined).
- Produces: exported `RENDERED_TOOL_RESULT_MAX_CHARS = 1_500`; rendered blocks of the form `[tool_call <name> — <status>]`.

- [ ] **Step 1: Write the failing tests**

In `packages/engine/test/child-read-tool.test.ts`, extend the `messageEntry` helper to accept extras, and add a describe block. Add `MessagePart` to the existing type-only import from `../src/types.js`.

```ts
function messageEntry(
  content: string,
  id = "e1",
  extras: { parts?: MessagePart[]; attachments?: Array<{ type: "image"; mimeType: string; name?: string }>; role?: "user" | "assistant" } = {},
): SessionEntry {
  return {
    id,
    sessionId: "child_abc",
    threadId: "th1",
    parentId: null,
    type: "message",
    role: extras.role ?? "assistant",
    content,
    createdAt: 1_700_000_000_000,
    ...(extras.parts ? { parts: extras.parts } : {}),
    ...(extras.attachments ? { attachments: extras.attachments } : {}),
  };
}
```

```ts
describe("childReadTool: parts and attachments rendering", () => {
  it("renders a completed tool call's name, status, and result text", async () => {
    const reader: ChildReader = async () => [
      messageEntry("", "e1", {
        parts: [{ type: "tool_call", callId: "c1", toolName: "bash", status: "completed", result: { text: "42 passed" } }],
      }),
    ];
    const result = await childReadTool.execute({ child_session_id: "child_abc" }, makeCtx(reader));
    expect(result.text).toContain("[tool_call bash — completed]");
    expect(result.text).toContain("42 passed");
  });

  it("marks an in-flight tool call instead of rendering a blank turn", async () => {
    const reader: ChildReader = async () => [
      messageEntry("", "e1", {
        parts: [{ type: "tool_call", callId: "c1", toolName: "bash", status: "running" }],
      }),
    ];
    const result = await childReadTool.execute({ child_session_id: "child_abc" }, makeCtx(reader));
    expect(result.text).toContain("[tool_call bash — running]");
    expect(result.text).toContain("in flight");
  });

  it("renders errored and elided calls distinctly", async () => {
    const reader: ChildReader = async () => [
      messageEntry("", "e1", {
        parts: [
          { type: "tool_call", callId: "c1", toolName: "bash", status: "error", error: "interrupted — result lost in restart" },
          { type: "tool_call", callId: "c2", toolName: "read", status: "completed", elided: true },
        ],
      }),
    ];
    const result = await childReadTool.execute({ child_session_id: "child_abc" }, makeCtx(reader));
    expect(result.text).toContain("error: interrupted — result lost in restart");
    expect(result.text).toContain("elided");
  });

  it("bounds one tool result and reports the overflow", async () => {
    const big = "y".repeat(RENDERED_TOOL_RESULT_MAX_CHARS + 500);
    const reader: ChildReader = async () => [
      messageEntry("", "e1", {
        parts: [{ type: "tool_call", callId: "c1", toolName: "bash", status: "completed", result: { text: big } }],
      }),
    ];
    const result = await childReadTool.execute({ child_session_id: "child_abc" }, makeCtx(reader));
    expect(result.text).toContain("[+500 more chars]");
  });

  it("marks user image attachments", async () => {
    const reader: ChildReader = async () => [
      messageEntry("look at this", "e1", {
        role: "user",
        attachments: [{ type: "image", mimeType: "image/png", name: "screenshot.png" }],
      }),
    ];
    const result = await childReadTool.execute({ child_session_id: "child_abc" }, makeCtx(reader));
    expect(result.text).toContain("[image attachment: screenshot.png (image/png)]");
  });
});
```

Import `RENDERED_TOOL_RESULT_MAX_CHARS` from `../src/builtin-tools/index.js`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @valet/engine test child-read-tool`
Expected: FAIL — `RENDERED_TOOL_RESULT_MAX_CHARS` not exported; rendered text lacks the markers.

- [ ] **Step 3: Implement rendering**

In `packages/engine/src/builtin-tools/index.ts`, add `MessagePart` to the type-only import from `../types.js`. Above `renderEntries`:

```ts
/**
 * Per-part ceiling on a rendered tool result in thread_read/child_read
 * output. The full result stays in the store; the reader gets a bounded
 * view so one verbose call cannot flood the caller's context.
 */
export const RENDERED_TOOL_RESULT_MAX_CHARS = 1_500;

/** Extract display text from a persisted tool result. Handles the engine's
 * own `{ text }` shape, bare strings, and anything else via JSON. */
function renderToolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const text = (result as Record<string, unknown>).text;
    if (typeof text === "string") return text;
  }
  try {
    return JSON.stringify(result) ?? "";
  } catch {
    return "<unserializable result>";
  }
}

/** Non-text message parts, rendered after the entry's content. Text parts
 * are already flattened into `content`; a turn that was only a tool call
 * has empty content, and before this rendering it read as a blank turn. */
function renderNonTextParts(parts: MessagePart[], lines: string[]): void {
  for (const p of parts) {
    if (p.type === "tool_call") {
      lines.push(`\n[tool_call ${p.toolName} — ${p.status}]`);
      if (p.status === "running") {
        lines.push("(no result recorded — the call was still in flight when this entry was read)");
      } else if (p.error) {
        lines.push(`error: ${p.error}`);
      } else if (p.elided) {
        lines.push("(result elided to reclaim context; the original output is no longer available)");
      } else if (p.result !== undefined) {
        const text = renderToolResultText(p.result);
        lines.push(
          text.length > RENDERED_TOOL_RESULT_MAX_CHARS
            ? `${text.slice(0, RENDERED_TOOL_RESULT_MAX_CHARS)} [+${text.length - RENDERED_TOOL_RESULT_MAX_CHARS} more chars]`
            : text,
        );
      }
    } else if (p.type === "attachment") {
      lines.push(`\n[attachment: ${p.attachment.type}]`);
    }
  }
}
```

In `renderEntries`, the `message` branch becomes:

```ts
    if (e.type === "message") {
      const author = e.author?.name ? ` (${e.author.name})` : "";
      lines.push(`\n## ${e.role}${author} @ ${new Date(e.createdAt).toISOString()}`);
      lines.push(e.content);
      for (const a of e.attachments ?? []) {
        lines.push(`[image attachment: ${a.name ?? "unnamed"} (${a.mimeType})]`);
      }
      if (e.parts) renderNonTextParts(e.parts, lines);
    }
```

If `p.attachment.type` does not typecheck against `ToolAttachment`, read the `ToolAttachment` definition in `types.ts` and use its discriminant field instead — do not cast.

- [ ] **Step 4: Run engine tests**

Run: `pnpm --filter @valet/engine test`
Expected: PASS (existing `child-read-tool` entries have no parts, so old assertions hold).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/builtin-tools/index.ts packages/engine/test/child-read-tool.test.ts
git commit -m "fix(engine): thread_read/child_read render tool calls and attachments"
```

### Task 4: spec amendment + plan doc

**Files:**
- Modify: `docs/specs/2026-05-02-portable-runtime-engine-design.md`
- Create: `docs/plans/2026-08-18-harness-feedback-fixes.md` (this file)

- [ ] **Step 1: Amend the engine spec**

Find the spec's job-mode/bash section (search for "decision 10" or "job mode") and its deviations/amendments area (or append a dated amendment at the end of the relevant section):

```markdown
### Amendment (2026-08-18): output truncation is visible to the agent

`JobPoll` carries `truncated?: boolean`. The docker, local, and virtual
sandboxes set it when the `maxOutputBytes` cap drops bytes; the kubernetes
job poller does not detect the drop yet and omits the field. The `bash`
built-in appends `BASH_TRUNCATION_NOTE` to its result when sync exec or any
poll reports truncation, so the model knows the tail was dropped and how to
recover (narrow the output, or write to a file and read slices).

`thread_read`/`child_read` rendering (`renderEntries`) now renders non-text
message parts: tool calls (name, status, bounded result text, error, elided
marker) and image attachments. Before this, a turn that was only a tool
call rendered as a heading with an empty body, which read as a blank turn.
```

- [ ] **Step 2: Commit spec + plan**

```bash
git add docs/specs/2026-05-02-portable-runtime-engine-design.md docs/plans/2026-08-18-harness-feedback-fixes.md
git commit -m "docs: spec amendment for truncation markers + entry rendering"
```

---

# PR 2 — orchestrator: `child_status` tool + delegation prompt clarifications

Branch: `feat/orchestrator-child-status` off `dev-v2` (independent of PR 1; the `builtin-tools/index.ts` edits are append-only and merge cleanly).

### Task 5: `ChildStatusReader` type + `child_status` built-in

**Files:**
- Modify: `packages/engine/src/types.ts` (after `ChildReader`, ~line 1956)
- Modify: `packages/engine/src/builtin-tools/index.ts` (new tool after `childSendTool`; register in `builtinTools`)
- Test: Create `packages/engine/test/child-status-tool.test.ts`

**Interfaces:**
- Produces: `ChildStatusReader` type; `childStatusTool` named `child_status` reading `ctx.config.childStatusReader`. Task 6 wires the api-side reader; Task 7 injects it via host options.

- [ ] **Step 1: Write the failing tests**

Create `packages/engine/test/child-status-tool.test.ts`, copying the `stubCredentials`/`makeCtx` idiom from `child-read-tool.test.ts` (parameterize `makeCtx` on `childStatusReader` instead of `childReader`):

```ts
describe("childStatusTool", () => {
  it("is registered in builtinTools", () => {
    expect(builtinTools.map((t) => t.name)).toContain("child_status");
  });

  it("says the session cannot check children when no reader is wired", async () => {
    const result = await childStatusTool.execute({ child_session_id: "child_abc" }, makeCtx());
    expect(result.text).toContain("[child_status_unavailable]");
  });

  it("answers not-found for a null reader result without confirming the id exists", async () => {
    const reader: ChildStatusReader = async () => null;
    const result = await childStatusTool.execute({ child_session_id: "child_other" }, makeCtx(reader));
    expect(result.text).toContain("[child_not_found]");
  });

  it("reports a running child with its last activity time", async () => {
    const lastActivityAt = Date.now() - 30_000;
    const reader: ChildStatusReader = async (req, ctx) => {
      expect(req.childSessionId).toBe("child_abc");
      expect(ctx.parentSessionId).toBe("orchestrator:u1");
      return { settled: false, lastActivityAt };
    };
    const result = await childStatusTool.execute({ child_session_id: "child_abc" }, makeCtx(reader));
    expect(result.text).toContain("running");
    expect(result.text).toContain(new Date(lastActivityAt).toISOString());
  });

  it("reports a settled child with no activity clock", async () => {
    const reader: ChildStatusReader = async () => ({ settled: true, lastActivityAt: null });
    const result = await childStatusTool.execute({ child_session_id: "child_abc" }, makeCtx(reader));
    expect(result.text).toContain("settled");
    expect(result.text).toContain("no queue activity recorded");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @valet/engine test child-status-tool`
Expected: FAIL — `childStatusTool` / `ChildStatusReader` do not exist.

- [ ] **Step 3: Add the type**

In `packages/engine/src/types.ts`, directly after the `ChildReader` type:

```ts
/**
 * Reports a child session's liveness on behalf of its parent — the
 * observability leg of the child toolset (`task` spawns, `child_read`
 * reads, `child_send` steers, `child_status` checks). `settled` mirrors
 * the host's watch row; `lastActivityAt` is the child's queue activity
 * clock (`SessionStore.latestActivityAt`), null when the child has no
 * queue items yet. A status read never wakes the child.
 *
 * Returns `null` when `childSessionId` is not a child of
 * `parentSessionId`, with the same "not yours" / "does not exist"
 * ambiguity as `ChildReader`.
 */
export type ChildStatusReader = (
  req: { childSessionId: string },
  ctx: { parentSessionId: string },
) => Promise<{ settled: boolean; lastActivityAt: number | null } | null>;
```

- [ ] **Step 4: Add the tool**

In `packages/engine/src/builtin-tools/index.ts`, add `ChildStatusReader` to the type import, then after `childSendTool`:

```ts
export const childStatusTool = defineTool({
  name: "child_status",
  description:
    "Check whether a child session is still making progress: settled or " +
    "running, plus its last queue activity time. Use it to decide between " +
    "waiting, steering with child_send, or reading the transcript with " +
    "child_read. A status check never wakes the child.",
  parameters: Type.Object({
    child_session_id: Type.String({
      description: "The child session to check, as returned by `task` or named in a child.settled signal.",
    }),
  }),
  execute: async (args, ctx) => {
    // Same `toolConfig` passthrough convention as `child_read`'s
    // childReader: `ctx.config` is verbatim `Record<string, unknown>`, so a
    // reader-shaped value is known only by convention.
    const rawReader = ctx.config?.childStatusReader;
    if (typeof rawReader !== "function") {
      return { text: "[child_status_unavailable] this session cannot check child sessions" };
    }
    const reader = rawReader as ChildStatusReader; // narrowed by typeof check above

    const status = await reader(
      { childSessionId: args.child_session_id },
      { parentSessionId: ctx.sessionId },
    );
    if (status === null) {
      return {
        text:
          `[child_not_found] "${args.child_session_id}" is not a child of this session. ` +
          `Use the child_session_id from a task result or a child.settled signal in this thread.`,
      };
    }
    const state = status.settled ? "settled" : "running";
    if (status.lastActivityAt === null) {
      return { text: `child ${args.child_session_id}: ${state}; no queue activity recorded yet.` };
    }
    const ageS = Math.max(0, Math.round((Date.now() - status.lastActivityAt) / 1000));
    const age = ageS < 120 ? `${ageS}s ago` : `${Math.round(ageS / 60)}m ago`;
    return {
      text:
        `child ${args.child_session_id}: ${state}; last queue activity ` +
        `${new Date(status.lastActivityAt).toISOString()} (${age}).`,
    };
  },
});
```

Register it in `builtinTools` after `childSendTool`.

- [ ] **Step 5: Run engine tests, commit**

Run: `pnpm --filter @valet/engine test`
Expected: PASS.

```bash
git add packages/engine/src/types.ts packages/engine/src/builtin-tools/index.ts packages/engine/test/child-status-tool.test.ts
git commit -m "feat(engine): child_status built-in reports child liveness"
```

### Task 6: api-side `buildChildStatusReader`

**Files:**
- Modify: `packages/api/src/orchestrator/children.ts` (after `buildChildReader`, ~line 817)
- Test: extend the existing children test file (locate with `ls packages/api/src/orchestrator/*.test.ts`; if `children.test.ts` exists follow its harness, otherwise cover via the engine-level test from Task 5 plus the integration typecheck — do not invent a new DB harness for this)

**Interfaces:**
- Consumes: `ChildrenDeps` (existing: `db`, `engineStore`, …), `childWatches`/`agentSessions` Drizzle tables (already imported in the file), `deps.engineStore.latestActivityAt`.
- Produces: `buildChildStatusReader(deps: ChildrenDeps): ChildStatusReader` — Task 7 wires it.

- [ ] **Step 1: Implement the reader**

In `packages/api/src/orchestrator/children.ts`, import `ChildStatusReader` from `@valet/engine` beside `ChildReader`, then after `buildChildReader`:

```ts
/**
 * Builds the `ChildStatusReader` injected into every orchestrator's
 * `toolConfig.childStatusReader` — the backend of the engine's
 * `child_status` built-in. Authority is the same `child_watches` edge as
 * `buildChildReader`. The activity clock reads the engine store directly:
 * a status check must never wake the child (no sandbox token, no
 * reconcile, no engine rows for a deleted child).
 */
export function buildChildStatusReader(deps: ChildrenDeps): ChildStatusReader {
  return async (req, ctx) => {
    const rows = await deps.db
      .select({ settled: childWatches.settled })
      .from(childWatches)
      .where(
        and(
          eq(childWatches.childSessionId, req.childSessionId),
          eq(childWatches.parentSessionId, ctx.parentSessionId),
        ),
      )
      .limit(1);
    // No row means the caller does not own this child, or it does not
    // exist. Both answer `null`: telling them apart would confirm that
    // somebody else's session id is real.
    if (rows.length === 0) return null;

    const childRows = await deps.db
      .select({ status: agentSessions.status })
      .from(agentSessions)
      .where(eq(agentSessions.id, req.childSessionId))
      .limit(1);
    const child = childRows[0];
    // A deleted child answers the same null as a missing one.
    if (!child || child.status === "deleted") return null;

    const lastActivityAt = await deps.engineStore.latestActivityAt(req.childSessionId);
    return { settled: rows[0].settled, lastActivityAt };
  };
}
```

If `rows[0].settled` is typed nullable by Drizzle, coerce with `rows[0].settled === true` (no cast).

- [ ] **Step 2: Typecheck and existing api tests**

Run: `pnpm typecheck && pnpm --filter @valet/api test orchestrator`
Expected: PASS. If a `children.test.ts` harness exists with a fake `ChildrenDeps`, add one test: reader returns null for an unowned child and `{settled, lastActivityAt}` for an owned one, mirroring the file's existing `buildChildReader` tests.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/orchestrator/children.ts
git commit -m "feat(api): child status reader over the watch edge"
```

### Task 7: host + provider wiring

**Files:**
- Modify: `packages/api/src/engine/host.ts` (options interface ~line 152; orchestrator `toolConfig` ~line 1473)
- Modify: `packages/api/src/providers/node.ts` (refs ~line 340; options ~line 372; fill ~line 402)

**Interfaces:**
- Consumes: `ChildStatusReader` (Task 5), `buildChildStatusReader` (Task 6).
- Produces: orchestrator sessions get `toolConfig.childStatusReader`; child sessions do not (same asymmetry as `childReader`).

- [ ] **Step 1: Host options + injection**

In `packages/api/src/engine/host.ts`, add `ChildStatusReader` to the `@valet/engine` type import. In the options interface, after `childReader`:

```ts
  /**
   * Injected into every orchestrator session's `toolConfig.childStatusReader`,
   * the backend of the `child_status` built-in. Same authority note as
   * `childReader`: a session that can spawn children is exactly the
   * session that may check on them.
   */
  childStatusReader?: ChildStatusReader;
```

In the orchestrator `toolConfig` block (~line 1476, beside the other three):

```ts
        ...(this.opts.childStatusReader ? { childStatusReader: this.opts.childStatusReader } : {}),
```

- [ ] **Step 2: Provider wiring**

In `packages/api/src/providers/node.ts`: add `ChildStatusReader` to the engine type imports and `buildChildStatusReader` to the children.ts import. Beside the other refs (~line 340):

```ts
  let statusRef: ChildStatusReader | undefined;
```

In the host options beside `childReader` (~line 372):

```ts
    childStatusReader: (req, ctx) => {
      if (!statusRef) throw new Error("childStatusReader invoked before provider wiring completed");
      return statusRef(req, ctx);
    },
```

After `readerRef = buildChildReader(childrenDeps);` (~line 402):

```ts
  statusRef = buildChildStatusReader(childrenDeps);
```

- [ ] **Step 3: Typecheck, api tests, commit**

Run: `pnpm typecheck && pnpm --filter @valet/api test`
Expected: PASS (see memory note: `model-resolution`/`llm-providers` fail if `ANTHROPIC_API_KEY` is exported in the shell — unset it or treat those rows via `make e2e`).

```bash
git add packages/api/src/engine/host.ts packages/api/src/providers/node.ts
git commit -m "feat(api): wire child_status reader into orchestrator sessions"
```

### Task 8: persona updates + spec amendment

**Files:**
- Modify: `packages/api/src/orchestrator/persona.ts` (`DELEGATION_RULES`)
- Modify: `packages/api/src/orchestrator/persona.test.ts`
- Modify: `docs/specs/2026-07-11-orchestrator-engine-design.md`

- [ ] **Step 1: Write the failing test**

In `persona.test.ts`, add to the existing describe:

```ts
  it("names the push boundary and the child_status check", () => {
    const persona = flat(orchestratorPersona({ type: "user", id: "u1" }));
    expect(persona).toContain("no git or GitHub credentials");
    expect(persona).toContain("child_status");
  });
```

Run: `pnpm --filter @valet/api test persona` — expected: FAIL.

- [ ] **Step 2: Edit `DELEGATION_RULES`**

Replace the intro paragraph's last sentence and rule 3:

```ts
const DELEGATION_RULES = `## Delegation

Your own sandbox is for small ad hoc work: reading a codebase, running a quick check, answering
a question from what you find. Anything bigger — code edits, branches and PRs, multi-step builds,
long-running jobs — goes to a child session through the task tool (when it is available). Do not
make repo edits in your own sandbox; spawn a child with a real dev environment and report its
result back. Your sandbox has no git or GitHub credentials by design, so git push fails here —
delegate pushes, branches, and PRs to a child session.

1. **Brief the child completely.** A child starts with none of your context. Give it the goal,
   the repo, the constraints, and what "done" means.
2. **One child per independent task.** Give independent tasks their own parallel children; keep
   dependent steps in one child, in order.
3. **Check before you intervene.** child_status shows whether a child is settled or running and
   when its queue last moved — use it to decide between waiting and steering. child_read shows a
   child's transcript; child_send delivers follow-ups — queued behind its current work by
   default, or superseding that work with interrupt: true when the child is heading the wrong
   direction. child_send also re-opens a settled child; either way its next result arrives as a
   child.settled signal.
4. **Verify before you report.** Check the child's result against the brief before you tell
   anyone the work is done.
```

Keep the `## Models` section unchanged. Note the existing test asserting `"Steer instead of redoing."` — if one exists, update it to the new rule-3 heading `"Check before you intervene."`.

- [ ] **Step 3: Spec amendment**

In `docs/specs/2026-07-11-orchestrator-engine-design.md`, find the child-toolset section (search "child_read") and add:

```markdown
### Amendment (2026-08-18): child_status

`child_status(child_session_id)` is the observability leg of the child
toolset. It answers settled/running plus the child's last queue activity
time (`SessionStore.latestActivityAt`) over the same `child_watches`
authority edge as `child_read`, and never wakes the child. It exists so a
parent can tell a working child from a wedged one without reading the full
transcript or asking an external system (e.g. GitHub) whether the branch
moved. The persona's delegation rules now also state the push boundary
explicitly: the orchestrator sandbox has no git/GitHub credentials by
design; pushes are delegated to children.
```

- [ ] **Step 4: Run api tests, commit**

Run: `pnpm --filter @valet/api test persona && pnpm typecheck`
Expected: PASS.

```bash
git add packages/api/src/orchestrator/persona.ts packages/api/src/orchestrator/persona.test.ts docs/specs/2026-07-11-orchestrator-engine-design.md
git commit -m "feat(api): persona names the push boundary and child_status"
```

---

# PR 3 — web: debug transcript names its lossy projection

Branch: `fix/web-transcript-fidelity-note` off `dev-v2`.

### Task 9: fidelity note in `buildTranscript`

**Files:**
- Modify: `packages/web/src/components/session/transcript.ts` (header array ~line 117, appendix blurb ~line 154)
- Test: extend `packages/web/src/components/session/transcript.test.ts`

- [ ] **Step 1: Write the failing test**

Follow the file's existing `baseCtx`-style helper (read the top of the test file first):

```ts
  it("names the wire-projection fidelity limit in the header", () => {
    const out = buildTranscript(baseCtx());
    expect(out).toContain("wire projection");
    expect(out).toContain("user image attachments");
  });
```

Run: `pnpm --filter @valet/web test transcript`
Expected: FAIL.

- [ ] **Step 2: Implement**

In the `header` array, after the `env.userAgent` line and before the closing `HEADER_RULE`:

```ts
    ``,
    `FIDELITY: built from the wire projection the UI renders. Engine-side`,
    `fields that do not ship on the wire are absent here — user image`,
    `attachments, signal envelopes, and attachment parts. Absence in this`,
    `transcript does not prove absence in the engine store; inspect`,
    `engine_entries for ground truth.`,
```

In the appendix blurb, change the first line to:

```ts
    `Machine-readable snapshot of the same wire-projected messages the UI`,
    `rendered (same fidelity limits as the timeline above) — includes every`,
    `tool-call arg/result verbatim, bounded to the same per-value truncation.`,
    `Paste this into a debugger to replay the state the UI saw.`,
```

- [ ] **Step 3: Run web tests, commit**

Run: `pnpm --filter @valet/web test transcript`
Expected: PASS (existing header/appendix assertions must still pass; adjust none unless they pin the old blurb verbatim).

```bash
git add packages/web/src/components/session/transcript.ts packages/web/src/components/session/transcript.test.ts
git commit -m "fix(web): transcript header names its wire-projection fidelity"
```

---

# Validation & shipping (all PRs)

- [ ] Per branch: `pnpm typecheck` + the touched package suites (listed per task).
- [ ] Full validation: create a local integration branch merging all three PR branches, run `make e2e` there, and get a clean scorecard (`make e2e 2>&1 | tee /tmp/e2e.log`, never piped through tail/head/grep). Name any red row's unrelated cause explicitly.
- [ ] Push each branch (SSH remote; notify for YubiKey with `say` before each push) and open PRs with `gh pr create --base dev-v2`, one per branch, describing the feedback item each fixes and the validation run.
