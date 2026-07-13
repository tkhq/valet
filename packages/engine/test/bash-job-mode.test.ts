/**
 * `bash` builtin tool: timeout param + job-mode selection (spec decision 10).
 *
 * Drives the tool's execute() directly with a hand-built ToolContext over a
 * fake sandbox with spy-able job methods (see list-threads-tool.test.ts /
 * model-switching.test.ts for the stub-ctx idiom this file follows).
 *
 * Provider-level job-mode behavior (offset polling, cancel, unknown execId)
 * is covered by packages/sandbox-local/test/job-mode.test.ts — this file
 * only exercises the tool's mode-selection and poll-loop logic.
 */
import { describe, it, expect, vi } from "vitest";
import {
  bashTool,
  JOB_MODE_THRESHOLD_MS,
  JOB_POLL_INTERVAL_MS,
  BASH_DEFAULT_TIMEOUT_S,
} from "../src/builtin-tools/index.js";
import { SandboxSupersededError, SandboxUnavailableError } from "../src/errors.js";
import type {
  Credential,
  CredentialProvider,
  DecisionGateRequest,
  DecisionResolution,
  ExecJobHandle,
  ExecResult,
  JobPoll,
  MessageQuery,
  Sandbox,
  SessionEntry,
  ToolContext,
} from "../src/types.js";

type FakeSandbox = Partial<Sandbox> & { id: string };

const stubCredentials: CredentialProvider = {
  get: async (): Promise<Credential | null> => null,
  request: async (): Promise<Credential> => {
    throw new Error("not implemented in test stub");
  },
};

function makeCtx(sandbox: FakeSandbox, signal: AbortSignal = new AbortController().signal): ToolContext {
  return {
    userId: "u1",
    orgId: "o1",
    sessionId: "s1",
    threadId: "t1",
    credentials: stubCredentials,
    // FakeSandbox is intentionally partial — tests only stub the methods
    // they exercise (exec/execJob/pollJob/cancelJob).
    sandbox: sandbox as Sandbox,
    requestDecision: async (_gate: DecisionGateRequest): Promise<DecisionResolution> => {
      throw new Error("not implemented in test stub");
    },
    signal,
    threadRead: async (_key: string, _opts?: MessageQuery): Promise<SessionEntry[]> => [],
    listThreads: async () => [],
    setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
  };
}

async function execute(args: { command: string; timeout?: number }, ctx: ToolContext) {
  return bashTool.execute(args, ctx);
}

describe("bash tool: constants", () => {
  it("exports the spec decision-10 constants verbatim", () => {
    expect(JOB_MODE_THRESHOLD_MS).toBe(60_000);
    expect(JOB_POLL_INTERVAL_MS).toBe(2_000);
    expect(BASH_DEFAULT_TIMEOUT_S).toBe(120);
  });
});

describe("bash tool: mode selection", () => {
  it("timeout: 59 (<= 60s threshold) uses sync exec, never touches execJob", async () => {
    const sandbox: FakeSandbox = {
      id: "sb-1",
      exec: vi.fn(async (): Promise<ExecResult> => ({ stdout: "sync-out\n", stderr: "", exitCode: 0 })),
    };
    const ctx = makeCtx(sandbox);
    const result = await execute({ command: "echo hi", timeout: 59 }, ctx);
    expect(sandbox.exec).toHaveBeenCalledTimes(1);
    expect((result as { text: string }).text).toBe("sync-out\n");
  });

  it("timeout: 61 (> 60s threshold) selects job mode when the sandbox supports it", async () => {
    const sandbox: FakeSandbox = {
      id: "sb-2",
      exec: vi.fn(async (): Promise<ExecResult> => ({ stdout: "", stderr: "", exitCode: 0 })),
      execJob: vi.fn(async (): Promise<ExecJobHandle> => ({ execId: "job-1" })),
      pollJob: vi.fn(
        async (): Promise<JobPoll> => ({ status: "done", exitCode: 0, output: "job-out\n", nextOffset: 8 }),
      ),
      cancelJob: vi.fn(async () => {}),
    };
    const ctx = makeCtx(sandbox);
    const result = await execute({ command: "long-thing", timeout: 61 }, ctx);
    expect(sandbox.execJob).toHaveBeenCalledTimes(1);
    expect(sandbox.exec).not.toHaveBeenCalled();
    expect((result as { text: string }).text).toBe("job-out\n");
  });

  it("execJob rejecting with [job_unsupported] falls back to sync exec", async () => {
    const sandbox: FakeSandbox = {
      id: "sb-3",
      exec: vi.fn(async (): Promise<ExecResult> => ({ stdout: "sync-fallback\n", stderr: "", exitCode: 0 })),
      execJob: vi.fn(async (): Promise<ExecJobHandle> => {
        throw new Error("[job_unsupported] this sandbox does not support job-mode exec");
      }),
      pollJob: vi.fn(async (): Promise<JobPoll> => ({ status: "done", exitCode: 0, output: "", nextOffset: 0 })),
      cancelJob: vi.fn(async () => {}),
    };
    const ctx = makeCtx(sandbox);
    const result = await execute({ command: "echo hi", timeout: 61 }, ctx);
    expect(sandbox.execJob).toHaveBeenCalledTimes(1);
    expect(sandbox.exec).toHaveBeenCalledTimes(1);
    expect(sandbox.pollJob).not.toHaveBeenCalled();
    expect((result as { text: string }).text).toBe("sync-fallback\n");
  });

  it("a non-[job_unsupported] execJob rejection propagates untouched (no sync fallback)", async () => {
    const sandbox: FakeSandbox = {
      id: "sb-4",
      exec: vi.fn(async (): Promise<ExecResult> => ({ stdout: "", stderr: "", exitCode: 0 })),
      execJob: vi.fn(async (): Promise<ExecJobHandle> => {
        throw new SandboxUnavailableError(new Error("No such container"));
      }),
      pollJob: vi.fn(async (): Promise<JobPoll> => ({ status: "done", exitCode: 0, output: "", nextOffset: 0 })),
      cancelJob: vi.fn(async () => {}),
    };
    const ctx = makeCtx(sandbox);
    await expect(execute({ command: "echo hi", timeout: 61 }, ctx)).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    );
    expect(sandbox.exec).not.toHaveBeenCalled();
  });
});

describe("bash tool: job-mode poll loop", () => {
  it("accumulates output across multiple polls into the final text; appends [exit N] on nonzero", async () => {
    vi.useFakeTimers();
    try {
      const polls: JobPoll[] = [
        { status: "running", output: "tick0\n", nextOffset: 6 },
        { status: "running", output: "tick1\n", nextOffset: 12 },
        { status: "done", exitCode: 3, output: "tick2\n", nextOffset: 18 },
      ];
      let call = 0;
      const sandbox: FakeSandbox = {
        id: "sb-5",
        execJob: vi.fn(async (): Promise<ExecJobHandle> => ({ execId: "job-2" })),
        pollJob: vi.fn(async (): Promise<JobPoll> => polls[call++]),
        cancelJob: vi.fn(async () => {}),
      };
      const ctx = makeCtx(sandbox);
      const resultPromise = execute({ command: "loop", timeout: 61 }, ctx);
      await vi.advanceTimersByTimeAsync(JOB_POLL_INTERVAL_MS * 3);
      const result = await resultPromise;
      expect(sandbox.pollJob).toHaveBeenCalledTimes(3);
      expect((result as { text: string }).text).toBe("tick0\ntick1\ntick2\n\n[exit 3]");
    } finally {
      vi.useRealTimers();
    }
  });

  it("deadline exceeded cancels the job and reports a timeout note", async () => {
    vi.useFakeTimers();
    try {
      const sandbox: FakeSandbox = {
        id: "sb-6",
        execJob: vi.fn(async (): Promise<ExecJobHandle> => ({ execId: "job-3" })),
        pollJob: vi.fn(async (): Promise<JobPoll> => ({ status: "running", output: "", nextOffset: 0 })),
        cancelJob: vi.fn(async () => {}),
      };
      const ctx = makeCtx(sandbox);
      const resultPromise = execute({ command: "sleep 999", timeout: 61 }, ctx);
      await vi.advanceTimersByTimeAsync(61_000 + JOB_POLL_INTERVAL_MS * 2);
      const result = await resultPromise;
      expect(sandbox.cancelJob).toHaveBeenCalledWith("job-3");
      expect((result as { text: string }).text).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ctx.signal abort mid-poll cancels the job then throws the abort error", async () => {
    const controller = new AbortController();
    let pollCount = 0;
    const sandbox: FakeSandbox = {
      id: "sb-7",
      execJob: vi.fn(async (): Promise<ExecJobHandle> => ({ execId: "job-4" })),
      pollJob: vi.fn(async (): Promise<JobPoll> => {
        pollCount++;
        if (pollCount === 1) controller.abort(new Error("cancelled by user"));
        return { status: "running", output: "", nextOffset: 0 };
      }),
      cancelJob: vi.fn(async () => {}),
    };
    const ctx = makeCtx(sandbox, controller.signal);
    await expect(execute({ command: "sleep 999", timeout: 61 }, ctx)).rejects.toThrow("cancelled by user");
    expect(sandbox.cancelJob).toHaveBeenCalledWith("job-4");
    expect(sandbox.pollJob).toHaveBeenCalledTimes(1);
  });

  it("a pollJob rejection (SandboxUnavailableError) propagates untouched; the job is not cancelled", async () => {
    const sandbox: FakeSandbox = {
      id: "sb-8",
      execJob: vi.fn(async (): Promise<ExecJobHandle> => ({ execId: "job-5" })),
      pollJob: vi.fn(async (): Promise<JobPoll> => {
        throw new SandboxUnavailableError(new Error("No such container"));
      }),
      cancelJob: vi.fn(async () => {}),
    };
    const ctx = makeCtx(sandbox);
    await expect(execute({ command: "long-thing", timeout: 61 }, ctx)).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    );
    expect(sandbox.cancelJob).not.toHaveBeenCalled();
  });

  it("ctx.signal abort: a cancelJob rejection is swallowed and the abort error still surfaces", async () => {
    const controller = new AbortController();
    let pollCount = 0;
    const sandbox: FakeSandbox = {
      id: "sb-9",
      execJob: vi.fn(async (): Promise<ExecJobHandle> => ({ execId: "job-6" })),
      pollJob: vi.fn(async (): Promise<JobPoll> => {
        pollCount++;
        if (pollCount === 1) controller.abort(new Error("cancelled by user"));
        return { status: "running", output: "", nextOffset: 0 };
      }),
      cancelJob: vi.fn(async () => {
        throw new SandboxUnavailableError(new Error("No such container"));
      }),
    };
    const ctx = makeCtx(sandbox, controller.signal);
    await expect(execute({ command: "sleep 999", timeout: 61 }, ctx)).rejects.toThrow("cancelled by user");
    expect(sandbox.cancelJob).toHaveBeenCalledWith("job-6");
  });

  it("deadline exceeded: a cancelJob rejection is swallowed and the timeout result still returns", async () => {
    vi.useFakeTimers();
    try {
      const sandbox: FakeSandbox = {
        id: "sb-10",
        execJob: vi.fn(async (): Promise<ExecJobHandle> => ({ execId: "job-7" })),
        pollJob: vi.fn(async (): Promise<JobPoll> => ({ status: "running", output: "", nextOffset: 0 })),
        cancelJob: vi.fn(async () => {
          throw new SandboxSupersededError(2);
        }),
      };
      const ctx = makeCtx(sandbox);
      const resultPromise = execute({ command: "sleep 999", timeout: 61 }, ctx);
      await vi.advanceTimersByTimeAsync(61_000 + JOB_POLL_INTERVAL_MS * 2);
      const result = await resultPromise;
      expect(sandbox.cancelJob).toHaveBeenCalledWith("job-7");
      expect((result as { text: string }).text).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });
});
