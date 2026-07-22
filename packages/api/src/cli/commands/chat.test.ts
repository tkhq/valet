import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ExitCode } from "../exit.js";
import {
  askLine,
  chatRepl,
  chatTurn,
  parseGateSelection,
  renderGatePrompt,
  type ChatClient,
  type ChatTurnDeps,
  type ReplDeps,
} from "./chat.js";
import type { StreamFn } from "./send.js";
import type { DecisionGate, SendPromptResponse, WireEvent } from "../../wire/types.js";

// ── event builders ─────────────────────────────────────────────────────────

function textDelta(delta: string, threadId = "t1"): WireEvent {
  return { seq: 1, ts: 1, type: "text_delta", threadId, messageId: "m1", delta };
}
function toolStart(toolName: string, threadId = "t1"): WireEvent {
  return { seq: 1, ts: 1, type: "tool_start", threadId, toolName };
}
function toolEnd(toolName: string, isError: boolean, threadId = "t1"): WireEvent {
  return { seq: 1, ts: 1, type: "tool_end", threadId, toolName, result: "", isError };
}
function settled(
  outcome: Extract<WireEvent, { type: "submission.settled" }>["outcome"],
  queueItemId = "msg1",
  threadId = "t1",
): WireEvent {
  return { seq: 1, ts: 1, type: "submission.settled", sessionId: "s1", threadId, queueItemId, outcome };
}
function turnEnd(threadId = "t1"): WireEvent {
  return { seq: 1, ts: 1, type: "turn_end", threadId, reason: "end_turn" };
}
function errorEvent(message: string): WireEvent {
  return { seq: 1, ts: 1, type: "error", code: "boom", message, recoverable: false };
}

function approvalGate(overrides: Partial<DecisionGate> = {}): DecisionGate {
  return {
    id: "gate_1",
    sessionId: "s1",
    threadId: "t1",
    type: "approval",
    title: "Approve write?",
    body: "write hello.txt",
    actions: [
      { id: "approve", label: "Approve", style: "primary" },
      { id: "deny", label: "Deny", style: "danger" },
    ],
    status: "pending",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}
function gateEvent(gate: DecisionGate, threadId = "t1"): WireEvent {
  return { seq: 1, ts: 1, type: "decision_gate", threadId, gate };
}

function makeStream(events: WireEvent[]): StreamFn {
  return () =>
    (async function* () {
      for (const e of events) yield e;
    })();
}

/** A capturing `ChatTurnDeps` with a stub client + scripted gate answers. */
function makeDeps(
  events: WireEvent[],
  opts: {
    sendResponse?: SendPromptResponse;
    selections?: (string | null)[];
  } = {},
): {
  deps: ChatTurnDeps;
  out: () => string;
  resolveCalls: Array<{ id: string; gateId: string; body: unknown }>;
  sendCalls: Array<{ id: string; body: unknown }>;
} {
  const chunks: string[] = [];
  const resolveCalls: Array<{ id: string; gateId: string; body: unknown }> = [];
  const sendCalls: Array<{ id: string; body: unknown }> = [];
  const selections = [...(opts.selections ?? [])];

  const client: ChatClient = {
    sendPrompt: async (id, body) => {
      sendCalls.push({ id, body });
      return opts.sendResponse ?? { messageId: "msg1", threadId: "t1" };
    },
    resolveDecision: async (id, gateId, body) => {
      resolveCalls.push({ id, gateId, body });
    },
  };

  const deps: ChatTurnDeps = {
    client,
    stream: makeStream(events),
    url: "http://x",
    write: (s) => {
      chunks.push(s);
    },
    readSelection: async () => (selections.length > 0 ? selections.shift()! : null),
  };

  return { deps, out: () => chunks.join(""), resolveCalls, sendCalls };
}

// ── chatTurn: basic streaming ───────────────────────────────────────────────

describe("chatTurn", () => {
  it("sends the prompt, writes tokens in order, and ends on the matching settle", async () => {
    const { deps, out, sendCalls } = makeDeps([
      textDelta("Hello"),
      textDelta(", "),
      textDelta("world"),
      settled("completed"),
    ]);

    const result = await chatTurn(deps, { sessionId: "s1", threadId: "t1", text: "hi" });

    expect(sendCalls).toEqual([{ id: "s1", body: { text: "hi", threadId: "t1" } }]);
    expect(out()).toBe("Hello, world\n");
    expect(result.exit).toBe(ExitCode.OK);
    expect(result.threadId).toBe("t1");
  });

  it("renders compact tool lines", async () => {
    const { deps, out } = makeDeps([toolStart("bash"), toolEnd("bash", false), settled("completed")]);
    await chatTurn(deps, { sessionId: "s1", text: "run" });
    expect(out()).toBe("⚙ bash · running\n✓ bash\n\n");
  });

  it("ignores deltas/tools on other threads", async () => {
    const { deps, out } = makeDeps([textDelta("nope", "other"), textDelta("yes"), settled("completed")]);
    await chatTurn(deps, { sessionId: "s1", threadId: "t1", text: "hi" });
    expect(out()).toBe("yes\n");
  });

  it("maps a failed settle to TurnError", async () => {
    const { deps } = makeDeps([textDelta("partial"), settled("failed")]);
    const result = await chatTurn(deps, { sessionId: "s1", text: "hi" });
    expect(result.exit).toBe(ExitCode.TurnError);
  });

  it("ends on turn_end for our thread when no settle arrives", async () => {
    const { deps } = makeDeps([textDelta("done"), turnEnd("t1")]);
    const result = await chatTurn(deps, { sessionId: "s1", threadId: "t1", text: "hi" });
    expect(result.exit).toBe(ExitCode.OK);
  });

  it("prints an error event and returns TurnError", async () => {
    const { deps, out } = makeDeps([errorEvent("kaboom")]);
    const result = await chatTurn(deps, { sessionId: "s1", text: "hi" });
    expect(out()).toContain("error: kaboom");
    expect(result.exit).toBe(ExitCode.TurnError);
  });
});

// ── chatTurn: gate round-trips ──────────────────────────────────────────────

describe("chatTurn gate round-trip", () => {
  it("resolves an approval gate by number and resumes the stream", async () => {
    const gate = approvalGate();
    const { deps, out, resolveCalls } = makeDeps(
      [textDelta("thinking"), gateEvent(gate), textDelta("done"), settled("completed")],
      { selections: ["1"] },
    );

    const result = await chatTurn(deps, { sessionId: "s1", threadId: "t1", text: "go" });

    expect(resolveCalls).toEqual([{ id: "s1", gateId: "gate_1", body: { actionId: "approve" } }]);
    // The turn resumed after resolution and ran to the settle.
    expect(out()).toContain("thinking");
    expect(out()).toContain("done");
    expect(result.exit).toBe(ExitCode.OK);
  });

  it("resolves an approval gate by literal action id", async () => {
    const gate = approvalGate();
    const { deps, resolveCalls } = makeDeps([gateEvent(gate), settled("completed")], {
      selections: ["deny"],
    });
    await chatTurn(deps, { sessionId: "s1", threadId: "t1", text: "go" });
    expect(resolveCalls).toEqual([{ id: "s1", gateId: "gate_1", body: { actionId: "deny" } }]);
  });

  it("resolves a question gate with free-text value", async () => {
    const gate = approvalGate({ id: "q_1", type: "question", title: "Which branch?", actions: [] });
    const { deps, resolveCalls } = makeDeps([gateEvent(gate), settled("completed")], {
      selections: ["feature/foo"],
    });
    await chatTurn(deps, { sessionId: "s1", threadId: "t1", text: "go" });
    expect(resolveCalls).toEqual([{ id: "s1", gateId: "q_1", body: { value: "feature/foo" } }]);
  });

  it("re-prompts on an invalid selection then resolves", async () => {
    const gate = approvalGate();
    const { deps, out, resolveCalls } = makeDeps([gateEvent(gate), settled("completed")], {
      selections: ["9", "approve"],
    });
    await chatTurn(deps, { sessionId: "s1", threadId: "t1", text: "go" });
    expect(out()).toContain("no option 9");
    expect(resolveCalls).toEqual([{ id: "s1", gateId: "gate_1", body: { actionId: "approve" } }]);
  });

  it("cancels the turn (GatePending, no resolve) when the selection is EOF", async () => {
    const gate = approvalGate();
    const { deps, resolveCalls } = makeDeps([gateEvent(gate), settled("completed")], {
      selections: [null],
    });
    const result = await chatTurn(deps, { sessionId: "s1", threadId: "t1", text: "go" });
    expect(resolveCalls).toEqual([]);
    expect(result.exit).toBe(ExitCode.GatePending);
  });

  it("ignores a gate on another thread", async () => {
    const gate = approvalGate({ threadId: "other" });
    const { deps, resolveCalls } = makeDeps([gateEvent(gate, "other"), settled("completed")]);
    const result = await chatTurn(deps, { sessionId: "s1", threadId: "t1", text: "go" });
    expect(resolveCalls).toEqual([]);
    expect(result.exit).toBe(ExitCode.OK);
  });
});

// ── parseGateSelection (pure) ───────────────────────────────────────────────

describe("parseGateSelection", () => {
  const gate = approvalGate();

  it("maps a 1-based number to the matching action id", () => {
    expect(parseGateSelection(gate, "1")).toEqual({ kind: "resolve", resolution: { actionId: "approve" } });
    expect(parseGateSelection(gate, "2")).toEqual({ kind: "resolve", resolution: { actionId: "deny" } });
  });

  it("maps a literal action id", () => {
    expect(parseGateSelection(gate, "deny")).toEqual({ kind: "resolve", resolution: { actionId: "deny" } });
  });

  it("trims surrounding whitespace", () => {
    expect(parseGateSelection(gate, "  1  ")).toEqual({ kind: "resolve", resolution: { actionId: "approve" } });
  });

  it("flags out-of-range numbers and unknown ids as invalid", () => {
    expect(parseGateSelection(gate, "0").kind).toBe("invalid");
    expect(parseGateSelection(gate, "5").kind).toBe("invalid");
    expect(parseGateSelection(gate, "nope").kind).toBe("invalid");
    expect(parseGateSelection(gate, "").kind).toBe("invalid");
  });

  it("returns cancel on null", () => {
    expect(parseGateSelection(gate, null)).toEqual({ kind: "cancel" });
  });

  it("treats a question gate answer as a free-text value", () => {
    const q = approvalGate({ type: "question", actions: [] });
    expect(parseGateSelection(q, "yes please")).toEqual({ kind: "resolve", resolution: { value: "yes please" } });
    expect(parseGateSelection(q, "")).toEqual({ kind: "cancel" });
    expect(parseGateSelection(q, null)).toEqual({ kind: "cancel" });
  });
});

// ── renderGatePrompt (pure) ─────────────────────────────────────────────────

describe("renderGatePrompt", () => {
  it("numbers approval actions and tags style", () => {
    const out = renderGatePrompt(approvalGate());
    expect(out).toContain("decision required: Approve write? [approval]");
    expect(out).toContain("write hello.txt");
    expect(out).toContain("  1. Approve (primary)  [approve]");
    expect(out).toContain("  2. Deny (danger)  [deny]");
    expect(out).toContain("(enter a number or an action id)");
  });

  it("prompts for free text on a question gate", () => {
    const out = renderGatePrompt(approvalGate({ type: "question", actions: [] }));
    expect(out).toContain("[question]");
    expect(out).toContain("(type your answer)");
    expect(out).not.toContain("1.");
  });
});

// ── chatRepl (injectable line reader) ───────────────────────────────────────

describe("chatRepl", () => {
  it("returns OK on EOF (readLine → null) without running a turn", async () => {
    const runTurn = vi.fn(async (_text: string) => {});
    const deps: ReplDeps = { readLine: async () => null, runTurn };
    expect(await chatRepl(deps)).toBe(ExitCode.OK);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("returns OK on /exit", async () => {
    const runTurn = vi.fn(async (_text: string) => {});
    const deps: ReplDeps = { readLine: async () => "/exit", runTurn };
    expect(await chatRepl(deps)).toBe(ExitCode.OK);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("skips empty lines and runs a turn per non-empty line, then exits on EOF", async () => {
    const lines: (string | null)[] = ["  ", "first", "", "second", null];
    const runTurn = vi.fn(async (_text: string) => {});
    const deps: ReplDeps = {
      readLine: async () => (lines.length > 0 ? lines.shift()! : null),
      runTurn,
    };
    expect(await chatRepl(deps)).toBe(ExitCode.OK);
    expect(runTurn.mock.calls.map((c) => c[0])).toEqual(["first", "second"]);
  });

  it("treats /quit as an exit alias", async () => {
    const deps: ReplDeps = { readLine: async () => "/quit", runTurn: vi.fn(async (_text: string) => {}) };
    expect(await chatRepl(deps)).toBe(ExitCode.OK);
  });
});

describe("chat/askLine (readline lifecycle)", () => {
  function makeRl(): { rl: ReadlineInterface; input: PassThrough; output: PassThrough } {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume(); // drain so writes don't buffer
    const rl = createInterface({ input, output });
    return { rl, input, output };
  }

  it("resolves with the typed line", async () => {
    const { rl, input } = makeRl();
    const p = askLine(rl, "› ");
    input.write("hello world\n");
    expect(await p).toBe("hello world");
    rl.close();
  });

  it("resolves null on EOF (input end / Ctrl-D)", async () => {
    const { rl, input } = makeRl();
    const p = askLine(rl, "› ");
    input.end(); // EOF → readline 'close'
    expect(await p).toBeNull();
  });

  it("resolves null immediately when the interface is already closed", async () => {
    const { rl } = makeRl();
    rl.close();
    expect(await askLine(rl, "› ")).toBeNull();
  });

  it("resolves null when the signal is already aborted", async () => {
    const { rl } = makeRl();
    const ac = new AbortController();
    ac.abort();
    expect(await askLine(rl, "› ", ac.signal)).toBeNull();
    rl.close();
  });

  it("aborting a pending question does NOT wedge the next prompt (the T8 hang fix)", async () => {
    const { rl, input } = makeRl();
    const ac = new AbortController();
    const first = askLine(rl, "gate › ", ac.signal);
    ac.abort(); // Ctrl-C during a gate read
    expect(await first).toBeNull();

    // The NEXT question must still resolve when the user types a line — the bug
    // was that Node's stale kQuestionCallback swallowed this input forever.
    const second = askLine(rl, "you › ");
    input.write("still works\n");
    expect(await second).toBe("still works");
    rl.close();
  });
});
