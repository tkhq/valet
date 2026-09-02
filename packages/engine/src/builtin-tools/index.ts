import { Type } from "typebox";
import type { TSchema } from "typebox";
import { storedToolResultText } from "../compaction.js";
import { isDecisionGateExpired } from "../decision-gate.js";
import type {
  ChildReader,
  ChildSender,
  ChildSpawner,
  ChildStatusReader,
  ExecJobHandle,
  JobPoll,
  MessagePart,
  MessageQuery,
  SessionEntry,
  SpawnChildRequest,
  ToolContext,
  ToolDef,
  ToolResult,
} from "../types.js";

/**
 * Bash job-mode constants (spec decision 10, verbatim values):
 *   - JOB_MODE_THRESHOLD_MS: timeoutMs above this triggers job mode when the
 *     sandbox supports it.
 *   - JOB_POLL_INTERVAL_MS: steady-state poll cadence once the warm-up ramp
 *     (JOB_POLL_WARMUP_MS) is exhausted.
 *   - BASH_DEFAULT_TIMEOUT_S: default `timeout` param value, in seconds.
 */
export const JOB_MODE_THRESHOLD_MS = 60_000;
export const JOB_POLL_INTERVAL_MS = 2_000;
export const BASH_DEFAULT_TIMEOUT_S = 120;

/**
 * Poll-wait warm-up ramp (spec decision 10, amended at final review): the
 * first poll is always immediate, then successive waits climb this ramp
 * before settling into the JOB_POLL_INTERVAL_MS steady state. With
 * BASH_DEFAULT_TIMEOUT_S (120s) above JOB_MODE_THRESHOLD_MS, default bash
 * always takes job mode — a flat 2s interval would put a ~2s floor on every
 * short command's latency. The ramp keeps that floor close to zero for
 * commands that finish in one of the first few polls.
 */
export const JOB_POLL_WARMUP_MS = [100, 250, 500, 1000];

/**
 * Appended to bash output when the sandbox reports its output cap dropped
 * bytes. The cap keeps the head and the tail and omits the middle (an
 * in-band `[... N bytes omitted ...]` marker shows where); the note names
 * the recovery moves (repo rule: an error message names the corrective
 * action).
 */
export const BASH_TRUNCATION_NOTE =
  "\n[output truncated: the sandbox capped this command's output — head and tail kept, middle omitted. " +
  "Narrow the output (grep, tail, --quiet) or redirect it to a file and read the file in slices.]";

function isJobUnsupported(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("[job_unsupported]");
}

/** setTimeout that resolves early (never rejects) on abort, so the poll
 * loop's top-of-iteration signal check fires promptly instead of waiting
 * out the full interval. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res) => {
    if (signal?.aborted) {
      res();
      return;
    }
    let onAbort: (() => void) | undefined;
    const t = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      res();
    }, ms);
    const unrefable = t as { unref?: () => void };
    if (typeof unrefable.unref === "function") unrefable.unref();
    if (signal) {
      onAbort = () => {
        clearTimeout(t);
        res();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function abortErrorFrom(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error("aborted");
}

/**
 * Best-effort job cancellation: the sandbox may already be gone
 * (SandboxUnavailableError) or the exec superseded (SandboxSupersededError)
 * by the time we try to cancel it. Either way, cancellation failing must
 * not mask the abort error / timeout result we're about to surface — swallow
 * it and move on.
 */
async function bestEffortCancel(cancelJob: (execId: string) => Promise<void>, execId: string): Promise<void> {
  try {
    await cancelJob(execId);
  } catch {
    // Cancellation is best-effort; the caller's abort/timeout result takes
    // precedence over any error the sandbox raises while cancelling.
  }
}

/**
 * Poll a job-mode exec to completion, accumulating output across polls
 * (spec decision 10). Deadline exceeded or `ctx.signal` abort both cancel
 * the job first; a poll rejection (sandbox degradation) propagates
 * untouched so the structured error reaches the model.
 */
async function pollJobToCompletion(
  ctx: ToolContext,
  pollJob: (execId: string, offset: number) => Promise<JobPoll>,
  cancelJob: (execId: string) => Promise<void>,
  execId: string,
  timeoutMs: number,
): Promise<ToolResult> {
  const deadline = Date.now() + timeoutMs;
  let offset = 0;
  let output = "";
  let pollCount = 0;
  let truncated = false;

  for (;;) {
    if (ctx.signal.aborted) {
      await bestEffortCancel(cancelJob, execId);
      throw abortErrorFrom(ctx.signal);
    }
    if (Date.now() >= deadline) {
      await bestEffortCancel(cancelJob, execId);
      const truncNote = truncated ? BASH_TRUNCATION_NOTE : "";
      return { text: `${output}${truncNote}\n[timed out after ${Math.round(timeoutMs / 1000)}s]` };
    }

    const poll = await pollJob(execId, offset);
    pollCount++;
    output += poll.output;
    offset = poll.nextOffset;
    if (poll.truncated) truncated = true;

    if (poll.status === "done") {
      const exitNote = poll.exitCode !== undefined && poll.exitCode !== 0 ? `\n[exit ${poll.exitCode}]` : "";
      const truncNote = truncated ? BASH_TRUNCATION_NOTE : "";
      return { text: `${output}${truncNote}${exitNote}` };
    }
    if (poll.status === "failed") {
      const truncNote = truncated ? BASH_TRUNCATION_NOTE : "";
      return { text: `${output}${truncNote}\n[job failed]` };
    }

    // Warm-up ramp: first poll is immediate (no sleep before it, above),
    // successive waits climb JOB_POLL_WARMUP_MS before settling into the
    // JOB_POLL_INTERVAL_MS steady state.
    const waitMs = JOB_POLL_WARMUP_MS[pollCount - 1] ?? JOB_POLL_INTERVAL_MS;
    await sleep(waitMs, ctx.signal);
  }
}

/**
 * Helper that preserves the schema's static type through the ToolDef so
 * `args` in `execute` is typed precisely instead of `unknown`.
 */
export function defineTool<T extends TSchema>(def: ToolDef<T>): ToolDef<T> {
  return def;
}

/**
 * FNV-1a content hash for the read-before-write gate. Equality checking
 * only — deliberately not node:crypto, which must stay out of the engine's
 * browser-safe barrel.
 */
export function hashFileContent(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36) + ":" + text.length.toString(36);
}

/**
 * Read-before-write staleness gate (TKAI-318, from Claude Code's
 * readFileState). Returns corrective text when the mutation must not
 * proceed, undefined when it may. Content-hash comparison catches bash-side
 * and human edits that timestamps cannot. Inert when the host wires no
 * `fileReads` (tests, minimal hosts).
 */
function staleWriteGate(
  ctx: ToolContext,
  path: string,
  currentContent: string | undefined,
): string | undefined {
  if (!ctx.fileReads) return undefined;
  if (currentContent === undefined) return undefined; // new file — nothing to protect
  const known = ctx.fileReads.get(path);
  if (known === undefined) {
    return `${path} exists but has not been read this session. Read it before writing to it.`;
  }
  if (known !== hashFileContent(currentContent)) {
    return `${path} changed since you read it (another process or person edited it). Read it again before writing to it.`;
  }
  return undefined;
}

export const readTool = defineTool({
  name: "read",
  description: "Read the contents of a file from the sandbox.",
  parameters: Type.Object({ path: Type.String() }),
  concurrencySafe: true,
  execute: async (args, ctx) => {
    const text = await ctx.sandbox.readFile(args.path);
    ctx.fileReads?.record(args.path, hashFileContent(text));
    return { text };
  },
});

export const writeTool = defineTool({
  name: "write",
  description: "Write contents to a file in the sandbox (creates or overwrites).",
  parameters: Type.Object({ path: Type.String(), content: Type.String() }),
  execute: async (args, ctx) => {
    let existing: string | undefined;
    try {
      existing = await ctx.sandbox.readFile(args.path);
    } catch {
      // Unreadable or absent — treat as a create; the gate has nothing to protect.
    }
    const stale = staleWriteGate(ctx, args.path, existing);
    if (stale) return { text: stale, ok: false };
    await ctx.sandbox.writeFile(args.path, args.content);
    ctx.fileReads?.record(args.path, hashFileContent(args.content));
    return { text: `wrote ${args.path}` };
  },
});

export const editTool = defineTool({
  name: "edit",
  description: "Replace exact text occurrences in a file.",
  parameters: Type.Object({
    path: Type.String(),
    oldString: Type.String(),
    newString: Type.String(),
  }),
  execute: async (args, ctx) => {
    const before = await ctx.sandbox.readFile(args.path);
    const stale = staleWriteGate(ctx, args.path, before);
    if (stale) return { text: stale, ok: false };
    if (!before.includes(args.oldString)) {
      return { text: `no match for old_string in ${args.path}` };
    }
    const after = before.split(args.oldString).join(args.newString);
    await ctx.sandbox.writeFile(args.path, after);
    ctx.fileReads?.record(args.path, hashFileContent(after));
    return { text: `edited ${args.path}` };
  },
});

export const bashTool = defineTool({
  name: "bash",
  description:
    "Execute a shell command in the sandbox. `timeout` (seconds, default " +
    `${BASH_DEFAULT_TIMEOUT_S}, max 3600) bounds how long the command may ` +
    "run; commands with an effective timeout beyond 60s automatically run " +
    "in job mode (poll-based, non-blocking on the transport) when the " +
    "sandbox supports it.",
  parameters: Type.Object({
    command: Type.String(),
    timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })),
  }),
  execute: async (args, ctx) => {
    const timeoutMs = (args.timeout ?? BASH_DEFAULT_TIMEOUT_S) * 1000;

    // Mode selection (spec decision 10). NOTE: `ctx.sandbox` is normally a
    // PolicySandbox, whose execJob/pollJob/cancelJob are ALWAYS defined
    // (they throw a `[job_unsupported]` error internally when the raw
    // sandbox lacks the capability) — so `typeof ... === "function"` can't
    // be used to detect support. Instead: past the threshold, try job mode;
    // if execJob itself rejects with `[job_unsupported]`, fall back to sync
    // exec. Once execJob has succeeded (a job exists), never fall back —
    // the poll loop's errors propagate untouched.
    //
    // IMPORTANT: bind these off `ctx.sandbox` rather than destructuring bare
    // references. `ctx.sandbox` is a real `PolicySandbox` class instance in
    // production whose methods read `this.dispatch(...)` internally — a bare
    // destructure (`const { execJob } = ctx.sandbox`) strips that binding and
    // every job-mode call throws `Cannot read properties of undefined
    // (reading 'dispatch')`. Every unit test in this area stubs `ctx.sandbox`
    // as a plain object literal (methods with no `this` dependency), which is
    // why this went undetected until an end-to-end test exercised a real
    // PolicySandbox.
    const execJob = ctx.sandbox.execJob?.bind(ctx.sandbox);
    const pollJob = ctx.sandbox.pollJob?.bind(ctx.sandbox);
    const cancelJob = ctx.sandbox.cancelJob?.bind(ctx.sandbox);
    if (timeoutMs > JOB_MODE_THRESHOLD_MS && execJob && pollJob && cancelJob) {
      let handle: ExecJobHandle | undefined;
      try {
        handle = await execJob(args.command, { signal: ctx.signal });
      } catch (err) {
        if (!isJobUnsupported(err)) throw err;
        // Underlying sandbox doesn't support job mode — fall through to sync exec.
      }
      if (handle) {
        return pollJobToCompletion(ctx, pollJob, cancelJob, handle.execId, timeoutMs);
      }
    }

    const result = await ctx.sandbox.exec(args.command, { signal: ctx.signal, timeout: timeoutMs });
    const exitNote = result.exitCode === 0 ? "" : `\n[exit ${result.exitCode}]`;
    const truncNote = result.truncated ? BASH_TRUNCATION_NOTE : "";
    return { text: `${result.stdout}${result.stderr}${truncNote}${exitNote}` };
  },
});

export const threadReadTool = defineTool({
  name: "thread_read",
  concurrencySafe: true,
  description:
    "Read recent messages from another thread in this session. Useful for cross-thread context (e.g. an orchestrator pulling notes from a worker thread, or a thread checking what a sibling has done).",
  parameters: Type.Object({
    key: Type.String({ description: "Thread key to read from (e.g. 'web:default', 'task:research')." }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    includeCompacted: Type.Optional(Type.Boolean()),
  }),
  execute: async (args, ctx) => {
    const opts: MessageQuery = {
      limit: args.limit ?? 30,
      includeCompacted: args.includeCompacted ?? true,
    };
    const entries = await ctx.threadRead(args.key, opts);
    if (entries.length === 0) return { text: `(thread "${args.key}" has no messages)` };
    return { text: renderEntries(`thread:${args.key}`, entries) };
  },
});

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
      } else if (p.elided && storedToolResultText(p) === undefined) {
        // Only rows pruned before elision preserved the stored text lose the
        // output; elided parts with preserved text render normally below.
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

/**
 * Renders session entries as markdown. Shared by `thread_read` and
 * `child_read` so one reader cannot drift from the other.
 */
function renderEntries(heading: string, entries: SessionEntry[]): string {
  const lines: string[] = [`# ${heading}`];
  for (const e of entries) {
    if (e.type === "message") {
      const author = e.author?.name ? ` (${e.author.name})` : "";
      lines.push(`\n## ${e.role}${author} @ ${new Date(e.createdAt).toISOString()}`);
      lines.push(e.content);
      for (const a of e.attachments ?? []) {
        lines.push(`[image attachment: ${a.name ?? "unnamed"} (${a.mimeType})]`);
      }
      if (e.parts) renderNonTextParts(e.parts, lines);
    } else if (e.type === "compaction") {
      lines.push(`\n## [compaction summary]`);
      lines.push(e.summary);
    } else if (e.type === "decision_gate") {
      lines.push(`\n## [decision gate: ${e.gate.type} — ${e.gate.status}] ${e.gate.title}`);
      if (e.gate.body) lines.push(e.gate.body);
    } else if (e.type === "branch_summary") {
      lines.push(`\n## [branch summary]`);
      lines.push(e.summary);
    }
  }
  return lines.join("\n");
}

/**
 * Byte ceiling on one `child_read` result. Matches the api's
 * `CHILD_RESULT_MAX_CHARS` on the settled signal: the recovery path must
 * not re-admit the flood the signal ceiling exists to prevent.
 */
export const CHILD_READ_MAX_CHARS = 16_000;

export const childReadTool = defineTool({
  name: "child_read",
  concurrencySafe: true,
  description:
    "Read the messages of a child session this session spawned. A " +
    "`child.settled` signal carries only a bounded copy of the child's " +
    "result, so call this when the signal says it was truncated, or when " +
    "you need the child's working detail rather than its conclusion.",
  parameters: Type.Object({
    child_session_id: Type.String({ description: "The child session to read, as named in the child.settled signal." }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  }),
  execute: async (args, ctx) => {
    // Same `toolConfig` passthrough convention as `task`'s childSpawner:
    // `ctx.config` is verbatim `Record<string, unknown>`, so a
    // reader-shaped value is known only by convention.
    const rawReader = ctx.config?.childReader;
    if (typeof rawReader !== "function") {
      return { text: "[child_read_unavailable] this session cannot read child sessions" };
    }
    const reader = rawReader as ChildReader; // narrowed by typeof check above

    const entries = await reader(
      { childSessionId: args.child_session_id, limit: args.limit },
      { parentSessionId: ctx.sessionId },
    );
    if (entries === null) {
      return {
        text:
          `[child_not_found] "${args.child_session_id}" is not a child of this session. ` +
          `Use the child_session_id from a child.settled signal in this thread.`,
      };
    }
    if (entries.length === 0) return { text: `(child ${args.child_session_id} has no messages)` };
    const rendered = renderEntries(`child:${args.child_session_id}`, entries);
    // The store's limit counts entries, not bytes — one oversized entry
    // (the exact case the settled-signal ceiling truncates) would flood
    // the parent's context through the recovery path. Keep the most
    // recent tail; the head is older transcript.
    if (rendered.length > CHILD_READ_MAX_CHARS) {
      const dropped = rendered.length - CHILD_READ_MAX_CHARS;
      return {
        text:
          `[Truncated: this is the most recent ${CHILD_READ_MAX_CHARS} characters; ` +
          `${dropped} older characters were dropped. No \`limit\` value recovers ` +
          `them — \`limit\` only picks how many recent entries are fetched.]\n\n` +
          rendered.slice(-CHILD_READ_MAX_CHARS),
      };
    }
    return { text: rendered };
  },
});

export const childSendTool = defineTool({
  name: "child_send",
  description:
    "Send a message to a child session this session spawned — steer it " +
    "mid-run or follow up after it settled. By default the message queues " +
    "behind the child's current work; set `interrupt: true` to supersede " +
    "that work (use it when the child is heading the wrong direction). " +
    "Either way the settlement watch re-arms: the child's next result " +
    "arrives as a fresh `child.settled` signal on the thread that spawned " +
    "the child.",
  parameters: Type.Object({
    child_session_id: Type.String({
      description: "The child session to message, as returned by `task` or named in a child.settled signal.",
    }),
    message: Type.String({ minLength: 1, description: "The message to deliver to the child." }),
    interrupt: Type.Optional(
      Type.Boolean({
        description: "Supersede the child's in-flight work instead of queueing behind it. Default false.",
      }),
    ),
  }),
  execute: async (args, ctx) => {
    // Same `toolConfig` passthrough convention as `task`'s childSpawner:
    // `ctx.config` is verbatim `Record<string, unknown>`, so a
    // sender-shaped value is known only by convention.
    const rawSender = ctx.config?.childSender;
    if (typeof rawSender !== "function") {
      return { text: "[child_send_unavailable] this session cannot message child sessions" };
    }
    const sender = rawSender as ChildSender; // narrowed by typeof check above

    const result = await sender(
      {
        childSessionId: args.child_session_id,
        message: args.message,
        ...(args.interrupt !== undefined ? { interrupt: args.interrupt } : {}),
      },
      { parentSessionId: ctx.sessionId, parentThreadId: ctx.threadId, actorUserId: ctx.userId },
    );
    if (result === null) {
      return {
        text:
          `[child_not_found] "${args.child_session_id}" is not a child of this session. ` +
          `Use the child_session_id from a task result or a child.settled signal in this thread.`,
      };
    }
    const mode = args.interrupt
      ? "superseding its in-flight work"
      : "queued behind its current work";
    return {
      text:
        `sent to child ${args.child_session_id} (submission ${result.queueItemId}, ${mode}). ` +
        `Its next result will arrive as a child.settled signal on the thread that spawned it.`,
    };
  },
});

export const childStatusTool = defineTool({
  name: "child_status",
  concurrencySafe: true,
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

export const listThreadsTool = defineTool({
  name: "list_threads",
  concurrencySafe: true,
  description:
    "List sibling threads in this session, including paused ones. Use this " +
    "to discover thread keys before calling `thread_read`. Returns key, " +
    "status, model override (if any), and a short summary when available.",
  parameters: Type.Object({}),
  execute: async (_args, ctx) => {
    const threads = await ctx.listThreads();
    if (threads.length === 0) return { text: "(no threads)" };
    const lines: string[] = [`# threads (${threads.length})`];
    for (const t of threads) {
      const isSelf = t.id === ctx.threadId ? " (this thread)" : "";
      const model = t.model ? ` [model:${t.model}]` : "";
      const updated = new Date(t.updatedAt).toISOString();
      lines.push(`- \`${t.key}\` — ${t.status}${model}${isSelf} (updated ${updated})`);
      if (t.summary) lines.push(`    ${t.summary}`);
    }
    return { text: lines.join("\n") };
  },
});

export const switchModelTool = defineTool({
  name: "switch_model",
  description:
    "Switch the model used for subsequent LLM calls in *this thread*. " +
    "Useful when a turn needs a stronger reasoning model or a faster/cheaper " +
    "one. The change takes effect on the next LLM call — the in-flight tool " +
    "call finishes against the old model. Scope is always thread-local; " +
    "changing the session default is a user-facing setting and not exposed " +
    "to the agent.",
  parameters: Type.Object({
    model: Type.String({
      description:
        "Target model id, e.g. 'claude-haiku-4-5' or 'anthropic/claude-opus-4-7'.",
    }),
  }),
  execute: async (args, ctx) => {
    try {
      const { fromModel, toModel } = await ctx.setModel({ model: args.model });
      if (fromModel === toModel) {
        return { text: `model unchanged (${toModel})` };
      }
      return { text: `switched thread model: ${fromModel} → ${toModel}` };
    } catch (err) {
      return {
        text:
          err instanceof Error
            ? `switch_model failed: ${err.message}`
            : "switch_model failed",
      };
    }
  },
});

export const askApprovalTool = defineTool({
  name: "ask_approval",
  description:
    "Ask the user for an explicit approval before proceeding with an action. " +
    "Blocks until the user approves or denies (or the gate expires). Use for " +
    "irreversible or sensitive steps the user should sign off on.",
  parameters: Type.Object({
    title: Type.String({ description: "Short question, e.g. 'Delete the staging database?'" }),
    body: Type.Optional(Type.String({ description: "Details the user needs to decide." })),
  }),
  execute: async (args, ctx) => {
    let resolution;
    try {
      resolution = await ctx.requestDecision({
        type: "approval",
        title: args.title,
        body: args.body,
        resumeKey: `ask_approval:${args.title}`,
      });
    } catch (err) {
      // Expiry is terminal for the turn — return guidance instead of a raw
      // error result, which the model reads as retryable.
      if (isDecisionGateExpired(err)) {
        return {
          text:
            `approval request expired: "${args.title}". Nobody answered before the ` +
            "deadline. Do not ask again in this turn. Tell the user the action did " +
            "not run; they can ask again in a new message.",
        };
      }
      throw err;
    }
    return {
      text:
        resolution.actionId === "approve"
          ? `approved: ${args.title}`
          : `denied: ${args.title}. This denial is final for the current turn — do not ask again. Tell the user what was denied.`,
    };
  },
});

export const taskTool = defineTool({
  name: "task",
  description:
    "Spawn a child session to work on a task in the background (fire-and-" +
    "forget — this call does not wait for the child to finish). The " +
    "parent thread receives a `child.settled` signal with the child's " +
    "result once it completes. Unavailable inside child sessions " +
    "(depth-limited to one level).",
  parameters: Type.Object({
    prompt: Type.String({ minLength: 1, description: "The task for the child session to perform." }),
    title: Type.Optional(Type.String()),
    repo: Type.Optional(Type.String({ description: "Clone URL or org/repo; interpretation is host policy." })),
    branch: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    profile: Type.Optional(
      Type.Union([Type.Literal("headless"), Type.Literal("full")], {
        description:
          'Sandbox profile for the child (default "headless"). "full" ships the interactive services (terminal, code-server).',
      }),
    ),
    docker: Type.Optional(
      Type.Boolean({
        description: "Provision the child's sandbox with a rootless docker daemon (docker-in-sandbox).",
      }),
    ),
  }),
  execute: async (args, ctx) => {
    // ctx.config is `Record<string, unknown>` (verbatim toolConfig
    // passthrough, Phase 4 decision 7) — a spawner-shaped value is only
    // known by convention, hence the typeof guard before the single
    // sanctioned cast.
    const rawSpawner = ctx.config?.childSpawner;
    if (typeof rawSpawner !== "function") {
      return { text: "[task_unavailable] this session cannot spawn child sessions" };
    }
    const spawner = rawSpawner as ChildSpawner; // narrowed by typeof check above

    const req: SpawnChildRequest = {
      prompt: args.prompt,
      title: args.title,
      repo: args.repo,
      branch: args.branch,
      model: args.model,
      profile: args.profile,
      docker: args.docker,
    };
    const owner = ctx.owner ?? { type: "user", id: ctx.userId };
    const result = await spawner(req, {
      parentSessionId: ctx.sessionId,
      parentThreadId: ctx.threadId,
      actorUserId: ctx.userId,
      owner,
      // The spawning submission's channel origin rides to the watcher, so
      // the child.settled signal can inherit it (see ChildWatcher).
      ...(ctx.origin !== undefined ? { origin: ctx.origin } : {}),
    });
    return {
      text: `spawned child session ${result.childSessionId} (submission ${result.queueItemId}). Its result will arrive in this thread as a child.settled signal.`,
    };
  },
});

export const builtinTools: ToolDef[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  threadReadTool,
  listThreadsTool,
  switchModelTool,
  askApprovalTool,
  taskTool,
  childReadTool,
  childSendTool,
  childStatusTool,
];
