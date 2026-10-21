/**
 * `wait_for_event` (spec 2026-10-15: event wakeups, Part D). The validator
 * is pure; the tool runs against a fake seam built from `vi.fn()`s, the
 * same stub-ctx idiom as wakeup-tools.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { waitForEventTool, wakeupListTool, builtinTools } from "../src/builtin-tools/index.js";
import { validateWaitForEvent, wakeupsUnavailable } from "../src/wakeups/validate.js";
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
import type { ArmEventRequest, Wakeup, WakeupLimits, WakeupsSeam } from "../src/wakeups/types.js";

const LIMITS: WakeupLimits = { leaseMaxHours: 72, timerMaxHours: 24, perSession: 2, watchMaxEventsPerHour: 60 };

const stubCredentials: CredentialProvider = {
  get: async (): Promise<Credential | null> => null,
  request: async (): Promise<Credential> => {
    throw new Error("not implemented in test stub");
  },
};

const NOW = 1_760_000_000_000;

function eventWakeup(overrides: Partial<Wakeup> = {}): Wakeup {
  return {
    id: "wk_ev1",
    sessionId: "s1",
    threadId: "t1",
    kind: "event",
    status: "running",
    reason: "CI on #42",
    logOffset: 0,
    logTail: "",
    eventCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    deadlineAt: NOW + 6 * 3_600_000,
    subjects: ["github:acme/lean-proofs#42"],
    eventMatch: {
      clauses: [{ key: "github.check_run.completed", status: ["failure"] }, { key: "github.pull_request.checks_completed" }],
      once: false,
      self: [],
    },
    eventBuffer: [],
    ...overrides,
  };
}

function makeCtx(seam: Partial<WakeupsSeam> | null, extra: Partial<Pick<ToolContext, "origin" | "sessionPurpose">> = {}): ToolContext {
  const base: ToolContext = {
    userId: "u1",
    orgId: "o1",
    sessionId: "s1",
    threadId: "t1",
    signal: new AbortController().signal,
    credentials: stubCredentials,
    // The tool never touches ctx.sandbox; an empty stub stands in for it,
    // the same idiom as wakeup-tools.test.ts.
    sandbox: {} as Sandbox,
    requestDecision: async (_gate: DecisionGateRequest): Promise<DecisionResolution> => {
      throw new Error("not implemented in test stub");
    },
    threadRead: async (_key: string, _opts?: MessageQuery): Promise<SessionEntry[]> => [],
    listThreads: async () => [],
    setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
    ...extra,
  };
  if (seam === null) return base;
  return {
    ...base,
    wakeups: {
      limits: LIMITS,
      create: vi.fn(),
      hold: vi.fn(),
      get: vi.fn(),
      list: vi.fn(async () => ({ wakeups: [], leases: [], otherThreads: 0 })),
      cancel: vi.fn(),
      readLog: vi.fn(),
      ...seam,
    },
  };
}

const VALID = {
  subject: "https://github.com/acme/lean-proofs/pull/42",
  on: [{ key: "github.check_run.completed", status: ["failure"] }],
  reason: "CI on #42",
  max_hours: 6,
};

describe("validateWaitForEvent", () => {
  it("accepts a valid call and defaults once to true", () => {
    const v = validateWaitForEvent(VALID, LIMITS);
    expect(v).toEqual({
      ok: true,
      value: {
        subject: VALID.subject,
        on: [{ key: "github.check_run.completed", status: ["failure"] }],
        once: true,
        reason: "CI on #42",
        maxHours: 6,
      },
    });
  });

  it("refuses zero clauses and nine clauses", () => {
    const none = validateWaitForEvent({ ...VALID, on: [] }, LIMITS);
    expect(none).toEqual({ ok: false, text: expect.stringContaining("Set on to 1 to 8 clauses") });
    const nine = validateWaitForEvent({ ...VALID, on: Array.from({ length: 9 }, () => ({ key: "slack.message" })) }, LIMITS);
    expect(nine).toEqual({ ok: false, text: expect.stringContaining("Set on to 1 to 8 clauses") });
  });

  it("accepts eight clauses", () => {
    const eight = validateWaitForEvent({ ...VALID, on: Array.from({ length: 8 }, () => ({ key: "slack.message" })) }, LIMITS);
    expect(eight.ok).toBe(true);
  });

  it("refuses an empty reason and a 201-character reason", () => {
    expect(validateWaitForEvent({ ...VALID, reason: "   " }, LIMITS)).toEqual({
      ok: false,
      text: "[wait_for_event] Set reason (1 to 200 characters).",
    });
    expect(validateWaitForEvent({ ...VALID, reason: "x".repeat(201) }, LIMITS).ok).toBe(false);
    expect(validateWaitForEvent({ ...VALID, reason: "x".repeat(200) }, LIMITS).ok).toBe(true);
  });

  it("refuses max_hours 0 and over timerMaxHours", () => {
    const text = "[wait_for_event] Set max_hours (1 to 24).";
    expect(validateWaitForEvent({ ...VALID, max_hours: 0 }, LIMITS)).toEqual({ ok: false, text });
    expect(validateWaitForEvent({ ...VALID, max_hours: 25 }, LIMITS)).toEqual({ ok: false, text });
    expect(validateWaitForEvent({ ...VALID, max_hours: 24 }, LIMITS).ok).toBe(true);
  });

  it("refuses min_interval_seconds 29 and 3601, and accepts 30 as 30000 ms", () => {
    const stream = { ...VALID, once: false };
    const text = "[wait_for_event] Set min_interval_seconds between 30 and 3600.";
    expect(validateWaitForEvent({ ...stream, min_interval_seconds: 29 }, LIMITS)).toEqual({ ok: false, text });
    expect(validateWaitForEvent({ ...stream, min_interval_seconds: 3601 }, LIMITS)).toEqual({ ok: false, text });
    const ok = validateWaitForEvent({ ...stream, min_interval_seconds: 30 }, LIMITS);
    expect(ok.ok && ok.value.minIntervalMs).toBe(30_000);
    expect(ok.ok && ok.value.once).toBe(false);
  });

  it("refuses min_interval_seconds in once mode, explicit or default", () => {
    const text =
      "[wait_for_event] min_interval_seconds works only in stream mode. Set once to false, or remove min_interval_seconds.";
    expect(validateWaitForEvent({ ...VALID, once: true, min_interval_seconds: 60 }, LIMITS)).toEqual({ ok: false, text });
    expect(validateWaitForEvent({ ...VALID, min_interval_seconds: 60 }, LIMITS)).toEqual({ ok: false, text });
  });

  it("refuses a clause with no key and a clause with a bad status list", () => {
    expect(validateWaitForEvent({ ...VALID, on: [{ status: ["failure"] }] }, LIMITS)).toEqual({
      ok: false,
      text: expect.stringContaining("Set on to 1 to 8 clauses"),
    });
    const bad = validateWaitForEvent({ ...VALID, on: [{ key: "slack.message", status: "failure" }] }, LIMITS);
    expect(bad).toEqual({ ok: false, text: expect.stringContaining("clause 1: give status as a list of strings") });
  });

  it("keeps only the known clause fields", () => {
    const v = validateWaitForEvent(
      {
        ...VALID,
        on: [{ key: "slack.message", bots: false, include_self: true, actor: "U002", from_status: ["backlog"], extra: 1 }],
      },
      LIMITS,
    );
    expect(v.ok && v.value.on).toEqual([
      { key: "slack.message", bots: false, include_self: true, actor: "U002", from_status: ["backlog"] },
    ]);
  });

  it("refuses an empty subject and a NUL byte", () => {
    expect(validateWaitForEvent({ ...VALID, subject: " " }, LIMITS).ok).toBe(false);
    expect(validateWaitForEvent({ ...VALID, reason: "a\u0000b" }, LIMITS)).toEqual({
      ok: false,
      text: expect.stringContaining("reason contains a NUL byte"),
    });
  });

  it("refuses an argument object that is not an object", () => {
    expect(validateWaitForEvent("nope", LIMITS).ok).toBe(false);
  });
});

describe("waitForEventTool", () => {
  it("is a builtin tool", () => {
    expect(builtinTools.some((t) => t.name === "wait_for_event")).toBe(true);
  });

  // Part I: the description carries one recipe per acceptance scenario
  // (A, B, C) plus the Linear-issue-reply recipe, and says that a standing,
  // unbounded watch is a subscription, not a one-off wait.
  it("carries the four recipe headings and the subscription sentence", () => {
    expect(waitForEventTool.description).toContain("CI on a pull request");
    expect(waitForEventTool.description).toContain("A Slack reply");
    expect(waitForEventTool.description).toContain("A Linear triage shift");
    expect(waitForEventTool.description).toContain("A reply on a Linear issue");
    expect(waitForEventTool.description).toContain("propose an event subscription instead");
  });

  it("names who self covers and shows an include_self recipe (final review, item 7)", () => {
    expect(waitForEventTool.description).toContain(
      "Events by the person you act for, and your own GitHub or Linear actions, are skipped unless a clause sets include_self.",
    );
    expect(waitForEventTool.description).toContain('"include_self": true');
    // The Slack inbox drops Valet's own posts before ingest, so no clause can keep them.
    expect(waitForEventTool.description).toContain(
      "Valet's own Slack posts never arrive as events, so your own Slack message cannot trigger a wait.",
    );
    expect(waitForEventTool.description).toContain("in a channel or in your DM with them");
    expect(waitForEventTool.description).not.toContain("or the Valet app are skipped");
  });

  it("returns wakeupsUnavailable without a seam", async () => {
    const result = await waitForEventTool.execute(VALID, makeCtx(null));
    expect(result.text).toBe(wakeupsUnavailable("wait_for_event"));
  });

  it("returns R9 in a workflow session with no armEvent", async () => {
    const result = await waitForEventTool.execute(VALID, makeCtx({}, { sessionPurpose: "workflow" }));
    expect(result.text).toBe("[wait_for_event] Workflow runs cannot wait for events. Use a workflow trigger instead.");
  });

  it("returns wakeupsUnavailable for another session with no armEvent", async () => {
    const result = await waitForEventTool.execute(VALID, makeCtx({}));
    expect(result.text).toBe(wakeupsUnavailable("wait_for_event"));
  });

  it("returns the validation refusal and does not arm", async () => {
    const armEvent = vi.fn();
    const result = await waitForEventTool.execute({ ...VALID, max_hours: 0 }, makeCtx({ armEvent }));
    expect(result.text).toBe("[wait_for_event] Set max_hours (1 to 24).");
    expect(armEvent).not.toHaveBeenCalled();
  });

  it("returns the [wakeups_limit] text at the per-thread limit (R8)", async () => {
    const armEvent = vi.fn();
    const list = vi.fn(async () => ({
      wakeups: [eventWakeup({ id: "wk_a" }), eventWakeup({ id: "wk_b" })],
      leases: [],
      otherThreads: 0,
    }));
    const result = await waitForEventTool.execute(VALID, makeCtx({ armEvent, list }));
    expect(result.text).toMatch(/^\[wakeups_limit\] This thread already has 2 active wakeups/);
    expect(armEvent).not.toHaveBeenCalled();
  });

  it("returns a refusal from the seam as its text", async () => {
    const refused = "[wait_for_event] github.check_suite.done is not an event key for github. Call workflows.list_event_types for the keys.";
    const armEvent = vi.fn(async () => ({ refused }));
    const result = await waitForEventTool.execute(VALID, makeCtx({ armEvent }));
    expect(result.text).toBe(refused);
  });

  it("passes both opt-outs through the arm request", async () => {
    const armEvent = vi.fn(async () => ({ wakeup: eventWakeup() }));
    await waitForEventTool.execute({ ...VALID, evaluate_current: false, end_on_close: false }, makeCtx({ armEvent }));
    expect(armEvent).toHaveBeenCalledWith("t1", expect.objectContaining({ evaluateCurrent: false, endOnClose: false }), undefined, stubCredentials);
  });

  it.each(["evaluate_current", "end_on_close"])("refuses a nonboolean %s", async (name) => {
    const armEvent = vi.fn(async () => ({ wakeup: eventWakeup() }));
    const result = await waitForEventTool.execute({ ...VALID, [name]: "false" }, makeCtx({ armEvent }));
    expect(result.text).toBe(`[wait_for_event] Set ${name} to true or false.`);
    expect(armEvent).not.toHaveBeenCalled();
  });

  it("states that an unbound branch wait will bind when a PR opens", async () => {
    const branch = "github:acme/lean-proofs:branch/feat/nested";
    const armEvent = vi.fn(async () => ({ wakeup: eventWakeup({ subjects: [branch] }) }));
    const result = await waitForEventTool.execute({ ...VALID, subject: "https://github.com/acme/lean-proofs/tree/feat/nested" }, makeCtx({ armEvent }));
    expect(result.text).toContain("The wait will bind when a PR opens.");
  });

  it("does not promise a later opening when the branch lookup failed", async () => {
    const branch = "github:acme/lean-proofs:branch/feat/nested";
    const armEvent = vi.fn(async () => ({ wakeup: eventWakeup({ subjects: [branch] }), warning: "The open PR lookup timed out. Check GitHub access." }));
    const result = await waitForEventTool.execute({ ...VALID, subject: "https://github.com/acme/lean-proofs/tree/feat/nested" }, makeCtx({ armEvent }));
    expect(result.text).toContain("Warning: The open PR lookup timed out");
    expect(result.text).not.toContain("will bind when a PR opens");
  });

  it("includes an ingress-readiness warning in the arm tool result", async () => {
    const warning = "GitHub App delivery readiness could not be checked.";
    const armEvent = vi.fn(async () => ({ wakeup: eventWakeup(), warning }));
    const result = await waitForEventTool.execute(VALID, makeCtx({ armEvent }));
    expect(result.text).toMatch(/^waiting wk_/);
    expect(result.text).toContain(`Warning: ${warning}`);
  });

  it("arms with the validated request, the origin, and the turn's credentials, and returns the D2 text", async () => {
    const wakeup = eventWakeup();
    const armEvent = vi.fn(async (_threadId: string, _req: ArmEventRequest) => ({ wakeup }));
    const origin = { channelType: "slack", threadKey: "slack:C001:1.2", reply: "manual" as const };
    const ctx = makeCtx({ armEvent }, { origin });
    const result = await waitForEventTool.execute(
      {
        subject: "https://github.com/acme/lean-proofs/pull/42",
        on: [{ key: "github.check_run.completed", status: ["failure"] }, { key: "github.pull_request.checks_completed" }],
        once: false,
        reason: "CI on #42",
        max_hours: 6,
      },
      ctx,
    );
    expect(armEvent).toHaveBeenCalledWith(
      "t1",
      {
        subject: "https://github.com/acme/lean-proofs/pull/42",
        on: [{ key: "github.check_run.completed", status: ["failure"] }, { key: "github.pull_request.checks_completed" }],
        once: false,
        reason: "CI on #42",
        maxHours: 6,
      },
      origin,
      stubCredentials,
    );
    expect(result.text).toBe(
      `waiting wk_ev1 on github:acme/lean-proofs#42 for github.check_run.completed (status failure), ` +
        `github.pull_request.checks_completed until ${new Date(NOW + 6 * 3_600_000).toISOString()}. ` +
        "End your turn now; an event.matched signal starts your next turn.",
    );
  });
});

describe("an event waiter with a primary subject (final review, item 3)", () => {
  const indexed = () => eventWakeup({
    subjects: ["github:acme/lean-proofs#42", "github:acme/lean-proofs"],
    eventMatch: {
      clauses: [{ key: "github.pull_request.checks_completed" }],
      once: true,
      self: [],
      primarySubject: "github:acme/lean-proofs#42",
    },
  });

  it("names only the primary subject in the arm result", async () => {
    const armEvent = vi.fn(async () => ({ wakeup: indexed() }));
    const result = await waitForEventTool.execute(VALID, makeCtx({ armEvent }));
    expect(result.text).toMatch(/^waiting wk_ev1 on github:acme\/lean-proofs#42 for /);
  });

  it("names only the primary subject in wakeup_list", async () => {
    const list = vi.fn(async () => ({ wakeups: [indexed()], leases: [], otherThreads: 0 }));
    const result = await wakeupListTool.execute({}, makeCtx({ list }));
    expect(result.text).toContain('"CI on #42" on github:acme/lean-proofs#42 (1 clause)');
  });
});

describe("wakeup_list with an event waiter", () => {
  it("shows the subject and the clause count", async () => {
    const list = vi.fn(async () => ({ wakeups: [eventWakeup()], leases: [], otherThreads: 0 }));
    const result = await wakeupListTool.execute({}, makeCtx({ list }));
    expect(result.text).toContain('wk_ev1 event running "CI on #42" on github:acme/lean-proofs#42 (2 clauses)');
    expect(result.text).toContain(`deadline ${new Date(NOW + 6 * 3_600_000).toISOString()}`);
  });
});
