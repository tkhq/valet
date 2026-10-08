/**
 * Wakeup tools (spec 2026-10-08: sandbox scratch, wakeups, and leases).
 *
 * Drives each tool's execute() directly with a hand-built ToolContext, same
 * stub-ctx idiom as bash-job-mode.test.ts: a plain object with only the
 * fields the tools under test touch, plus a `wakeups` seam built from
 * `vi.fn()`s that each test overrides as needed.
 */
import { describe, it, expect, vi } from "vitest";
import {
  watchTool,
  wakeAtTool,
  holdSandboxTool,
  processReadTool,
  wakeupListTool,
  wakeupCancelTool,
} from "../src/builtin-tools/index.js";
import type {
  Credential,
  CredentialProvider,
  DecisionGateRequest,
  DecisionResolution,
  MessageQuery,
  Sandbox,
  SessionEntry,
  ToolContext,
} from "../src/types.js";
import type { Lease, Wakeup, WakeupsSeam } from "../src/wakeups/types.js";

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

function makeCtx(seam: Partial<WakeupsSeam>): ToolContext {
  return {
    userId: "u1",
    orgId: "o1",
    sessionId: "s1",
    threadId: "t1",
    credentials: stubCredentials,
    // None of these tools touch ctx.sandbox; an empty stub stands in for it,
    // same idiom as bash-job-mode.test.ts's FakeSandbox.
    sandbox: {} as Sandbox,
    requestDecision: async (_gate: DecisionGateRequest): Promise<DecisionResolution> => {
      throw new Error("not implemented in test stub");
    },
    threadRead: async (_key: string, _opts?: MessageQuery): Promise<SessionEntry[]> => [],
    listThreads: async () => [],
    setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
    wakeups: {
      limits: { leaseMaxHours: 72, timerMaxHours: 24, perSession: 20, watchMaxEventsPerHour: 60 },
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

describe("watch", () => {
  it("starts a watch wakeup and reports the id", async () => {
    const create = vi.fn(async () => ({
      wakeup: { ...baseWakeup, id: "wk_w", kind: "watch" as const },
      lease: { ...baseLease, id: "ls_w" },
    }));
    const r = await watchTool.execute({ command: "tail -f out.log", reason: "ci", max_hours: 2 }, makeCtx({ create }));
    expect(create).toHaveBeenCalledWith("t1", { kind: "watch", command: "tail -f out.log", reason: "ci", maxHours: 2 });
    expect(r.text).toContain("started watch wk_w");
  });
});

describe("wake_at", () => {
  it("schedules a timer and echoes the ISO time", async () => {
    const create = vi.fn(async () => ({
      wakeup: { ...baseWakeup, id: "wk_t", kind: "timer" as const, status: "pending" as const, fireAt: 1_700_000_000_000 },
    }));
    const r = await wakeAtTool.execute({ after_seconds: 7200, prompt: "Check the proof report" }, makeCtx({ create }));
    expect(create.mock.calls[0]?.[1]).toMatchObject({ kind: "timer", prompt: "Check the proof report" });
    expect(r.text).toBe("scheduled wakeup wk_t at 2023-11-14T22:13:20.000Z");
  });
});

describe("hold_sandbox", () => {
  it("creates a lease", async () => {
    const hold = vi.fn(async () => ({ ...baseLease, id: "ls_h", deadlineAt: 1_700_000_000_000 }));
    const r = await holdSandboxTool.execute({ hours: 48, reason: "manual run" }, makeCtx({ hold }));
    expect(r.text).toBe("holding sandbox until 2023-11-14T22:13:20.000Z (lease ls_h)");
  });
});

describe("process_read", () => {
  it("returns the slice and nextOffset", async () => {
    const readLog = vi.fn(async () => ({ text: "hello", nextOffset: 5, eof: false }));
    const r = await processReadTool.execute({ id: "wk_a", offset: 0, bytes: 4096 }, makeCtx({ readLog }));
    expect(r.text).toBe("hello\n[nextOffset 5]");
  });

  it("marks eof", async () => {
    const readLog = vi.fn(async () => ({ text: "", nextOffset: 5, eof: true }));
    const r = await processReadTool.execute({ id: "wk_a", offset: 5 }, makeCtx({ readLog }));
    expect(r.text).toBe("(no new output)\n[nextOffset 5] [eof]");
  });
});

describe("wakeup_list", () => {
  it("renders one line per row and a hold lease", async () => {
    const list = vi.fn(async () => ({
      wakeups: [{ ...baseWakeup, id: "wk_a", reason: "proof build", deadlineAt: 1_700_000_000_000 }],
      leases: [{ ...baseLease, id: "ls_h", ownerKind: "hold" as const, reason: "manual", deadlineAt: 1_700_000_000_000 }],
    }));
    const r = await wakeupListTool.execute({}, makeCtx({ list }));
    expect(r.text).toContain('wk_a process running "proof build" deadline 2023-11-14T22:13:20.000Z');
    expect(r.text).toContain('ls_h hold "manual" deadline 2023-11-14T22:13:20.000Z');
  });
});

describe("wakeup_cancel", () => {
  it("reports the kind and unknown ids", async () => {
    expect(
      (await wakeupCancelTool.execute({ id: "wk_a" }, makeCtx({ cancel: vi.fn(async () => ({ kind: "wakeup" as const })) }))).text,
    ).toBe("cancelled wk_a");
    expect(
      (await wakeupCancelTool.execute({ id: "nope" }, makeCtx({ cancel: vi.fn(async () => null) }))).text,
    ).toBe("[wakeup_cancel] nope is not an active wakeup or lease. Call wakeup_list to see active ids.");
  });
});

describe("wakeups seam absent", () => {
  it("every tool refuses without the seam", async () => {
    const ctx = makeCtx({});
    delete ctx.wakeups;
    const unavailable = "[wakeups_unavailable] this session cannot schedule wakeups.";
    expect((await watchTool.execute({ command: "x", reason: "r", max_hours: 1 }, ctx)).text).toBe(unavailable);
    expect((await wakeAtTool.execute({ after_seconds: 60, prompt: "p" }, ctx)).text).toBe(unavailable);
    expect((await holdSandboxTool.execute({ hours: 1, reason: "r" }, ctx)).text).toBe(unavailable);
    expect((await processReadTool.execute({ id: "x" }, ctx)).text).toBe(unavailable);
    expect((await wakeupListTool.execute({}, ctx)).text).toBe(unavailable);
    expect((await wakeupCancelTool.execute({ id: "x" }, ctx)).text).toBe(unavailable);
  });
});

describe("per-session limit", () => {
  it("refuses over the per-session limit", async () => {
    const list = vi.fn(async () => ({
      wakeups: Array.from({ length: 20 }, (_, i) => ({ ...baseWakeup, id: `wk_${i}` })),
      leases: [],
    }));
    const r = await wakeAtTool.execute({ after_seconds: 60, prompt: "p" }, makeCtx({ list }));
    expect(r.text).toBe(
      "[wakeups_limit] This session already has 20 active wakeups and leases (limit 20, sandbox.wakeupsPerSession). Cancel one with wakeup_cancel.",
    );
  });
});
