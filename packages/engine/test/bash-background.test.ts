/**
 * `bash` background mode and sleep refusal (spec 2026-10-08: sandbox
 * scratch, wakeups, and leases, Task 7).
 *
 * `makeCtx` follows the stub-ctx idiom from bash-job-mode.test.ts (a
 * hand-built ToolContext over a fake sandbox) plus a `wakeups` seam of
 * `vi.fn()`s, same idiom as wakeup-tools.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import {
  bashTool,
  JOB_POLL_INTERVAL_MS,
} from "../src/builtin-tools/index.js";
import type {
  Credential,
  CredentialProvider,
  DecisionGateRequest,
  DecisionResolution,
  ExecJobHandle,
  JobPoll,
  MessageQuery,
  Sandbox,
  SessionEntry,
  ToolContext,
} from "../src/types.js";
import type { Lease, Wakeup, WakeupsSeam } from "../src/wakeups/types.js";

type FakeSandbox = Partial<Sandbox> & { id: string };

const stubCredentials: CredentialProvider = {
  get: async (): Promise<Credential | null> => null,
  request: async (): Promise<Credential> => {
    throw new Error("not implemented in test stub");
  },
};

const baseWakeup: Wakeup = {
  id: "wk_base",
  sessionId: "s1",
  threadId: "t1",
  kind: "process",
  status: "running",
  reason: "base",
  logOffset: 0,
  logTail: "",
  eventCount: 0,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const baseLease: Lease = {
  id: "ls_base",
  sessionId: "s1",
  ownerKind: "hold",
  reason: "base",
  createdAt: 1_700_000_000_000,
  deadlineAt: 1_700_000_000_000,
};

function makeCtx(sandbox: FakeSandbox, seam?: Partial<WakeupsSeam>): ToolContext {
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
    signal: new AbortController().signal,
    threadRead: async (_key: string, _opts?: MessageQuery): Promise<SessionEntry[]> => [],
    listThreads: async () => [],
    setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
    wakeups: {
      limits: { leaseMaxHours: 72, timerMaxHours: 720, perSession: 20, watchMaxEventsPerHour: 120 },
      create: vi.fn(),
      hold: vi.fn(),
      get: vi.fn(),
      list: vi.fn(async () => ({ wakeups: [], leases: [] })),
      cancel: vi.fn(),
      readLog: vi.fn(),
      ...seam,
    },
  };
}

describe("bash tool: background mode", () => {
  it("background: true with deadline and reason starts a process and returns at once", async () => {
    const create = vi.fn(async () => ({
      wakeup: { ...baseWakeup, id: "wk_p", deadlineAt: 1_700_000_000_000 },
      lease: baseLease,
    }));
    const ctx = makeCtx({ id: "sb" }, { create });
    const r = await bashTool.execute(
      { command: "lake build", background: true, deadline_hours: 48, reason: "full proof build" },
      ctx,
    );
    expect(create).toHaveBeenCalledWith("t1", {
      kind: "process",
      command: "lake build",
      reason: "full proof build",
      deadlineHours: 48,
    });
    expect(r.text).toBe(
      "started sandbox process wk_p (deadline 2023-11-14T22:13:20.000Z). " +
        "You will receive a process.exited signal. Read its log with process_read.",
    );
  });

  it("background without deadline or reason refuses and starts nothing", async () => {
    const create = vi.fn();
    const r = await bashTool.execute(
      { command: "lake build", background: true },
      makeCtx({ id: "sb" }, { create }),
    );
    expect(r.text).toBe("[bash_background] Set deadline_hours (1 to 72) and reason when background is true.");
    expect(create).not.toHaveBeenCalled();
  });
});

describe("bash tool: sleep refusal", () => {
  it("foreground sleep over 300s is refused", async () => {
    const exec = vi.fn();
    const r = await bashTool.execute({ command: "sleep 3600" }, makeCtx({ id: "sb", exec }));
    expect(r.text).toBe("[bash_sleep] Use wake_at to pause for more than 5 minutes.");
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("bash tool: timeout hint", () => {
  it("the job-mode timeout text points at background mode", async () => {
    vi.useFakeTimers();
    try {
      const sandbox: FakeSandbox = {
        id: "sb-timeout",
        execJob: vi.fn(async (): Promise<ExecJobHandle> => ({ execId: "job-timeout" })),
        pollJob: vi.fn(async (): Promise<JobPoll> => ({ status: "running", output: "", nextOffset: 0 })),
        cancelJob: vi.fn(async () => {}),
      };
      const ctx = makeCtx(sandbox);
      const resultPromise = bashTool.execute({ command: "long-running-task", timeout: 61 }, ctx);
      await vi.advanceTimersByTimeAsync(61_000 + JOB_POLL_INTERVAL_MS * 2);
      const r = await resultPromise;
      expect(r.text).toContain(
        "[timed out after 61s] For work longer than an hour, rerun with background: true and a deadline_hours.",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
