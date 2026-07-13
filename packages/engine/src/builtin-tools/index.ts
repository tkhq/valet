import { Type } from "typebox";
import type { TSchema } from "typebox";
import type { ExecJobHandle, JobPoll, MessageQuery, ToolContext, ToolDef, ToolResult } from "../types.js";

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

  for (;;) {
    if (ctx.signal.aborted) {
      await bestEffortCancel(cancelJob, execId);
      throw abortErrorFrom(ctx.signal);
    }
    if (Date.now() >= deadline) {
      await bestEffortCancel(cancelJob, execId);
      return { text: `${output}\n[timed out after ${Math.round(timeoutMs / 1000)}s]` };
    }

    const poll = await pollJob(execId, offset);
    pollCount++;
    output += poll.output;
    offset = poll.nextOffset;

    if (poll.status === "done") {
      const exitNote = poll.exitCode !== undefined && poll.exitCode !== 0 ? `\n[exit ${poll.exitCode}]` : "";
      return { text: `${output}${exitNote}` };
    }
    if (poll.status === "failed") {
      return { text: `${output}\n[job failed]` };
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

export const readTool = defineTool({
  name: "read",
  description: "Read the contents of a file from the sandbox.",
  parameters: Type.Object({ path: Type.String() }),
  execute: async (args, ctx) => {
    const text = await ctx.sandbox.readFile(args.path);
    return { text };
  },
});

export const writeTool = defineTool({
  name: "write",
  description: "Write contents to a file in the sandbox (creates or overwrites).",
  parameters: Type.Object({ path: Type.String(), content: Type.String() }),
  execute: async (args, ctx) => {
    await ctx.sandbox.writeFile(args.path, args.content);
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
    if (!before.includes(args.oldString)) {
      return { text: `no match for old_string in ${args.path}` };
    }
    const after = before.split(args.oldString).join(args.newString);
    await ctx.sandbox.writeFile(args.path, after);
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
    return { text: `${result.stdout}${result.stderr}${exitNote}` };
  },
});

export const threadReadTool = defineTool({
  name: "thread_read",
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
    const lines: string[] = [`# thread:${args.key}`];
    for (const e of entries) {
      if (e.type === "message") {
        const author = e.author?.name ? ` (${e.author.name})` : "";
        lines.push(`\n## ${e.role}${author} @ ${new Date(e.createdAt).toISOString()}`);
        lines.push(e.content);
      } else if (e.type === "compaction") {
        lines.push(`\n## [compaction summary]`);
        lines.push(e.summary);
      } else if (e.type === "decision_gate") {
        lines.push(
          `\n## [decision gate: ${e.gate.type} — ${e.gate.status}] ${e.gate.title}`,
        );
        if (e.gate.body) lines.push(e.gate.body);
      } else if (e.type === "branch_summary") {
        lines.push(`\n## [branch summary]`);
        lines.push(e.summary);
      }
    }
    return { text: lines.join("\n") };
  },
});

export const listThreadsTool = defineTool({
  name: "list_threads",
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
    const resolution = await ctx.requestDecision({
      type: "approval",
      title: args.title,
      body: args.body,
      resumeKey: `ask_approval:${args.title}`,
    });
    return {
      text:
        resolution.actionId === "approve"
          ? `approved: ${args.title}`
          : `denied: ${args.title}`,
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
];
