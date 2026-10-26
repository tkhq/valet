import { describe, expect, it } from "vitest";
import { MID_TURN_DELIVERY_KEY, type BusEvent, type DecisionGate, type MessageEntry, type MessagePart as EngineMessagePart, type QueueItem } from "@valet/engine";
import { busEventToWire, engineGateToWire, engineSignalToWire, engineToWireParts, queuedItemToWire } from "./bridge.js";
import { QUEUED_TEXT_MAX } from "../wire/types.js";

function ev(event: BusEvent["event"], threadId = "t1"): BusEvent {
  return { sessionId: "s1", threadId, userId: "u1", event, timestamp: 100 };
}

describe("engineSignalToWire", () => {
  it("trims engine signal to the wire shape (drops tagName/hopCount/senderOwner)", () => {
    const signal: NonNullable<MessageEntry["signal"]> = {
      signalType: "child.settled",
      attributes: { title: "Fix the bug", outcome: "success" },
      tagName: "signal",
      senderSessionId: "child-1",
      senderOwner: { type: "user", id: "u1" },
      hopCount: 1,
    };
    expect(engineSignalToWire(signal)).toEqual({
      signalType: "child.settled",
      attributes: { title: "Fix the bug", outcome: "success" },
      senderSessionId: "child-1",
    });
  });

  it("omits attributes/senderSessionId when absent on the engine signal", () => {
    const signal: NonNullable<MessageEntry["signal"]> = {
      signalType: "orchestrator.message",
      tagName: "signal",
    };
    expect(engineSignalToWire(signal)).toEqual({ signalType: "orchestrator.message" });
  });

  it("returns undefined for undefined input", () => {
    expect(engineSignalToWire(undefined)).toBeUndefined();
  });

  it("ships only the origin channel type, never the thread key", () => {
    const signal: NonNullable<MessageEntry["signal"]> = {
      signalType: "wakeup.process.exited",
      tagName: "signal",
      origin: { channelType: "slack", threadKey: "slack:C1:171.1", reply: "auto" },
    };
    expect(engineSignalToWire(signal)).toEqual({
      signalType: "wakeup.process.exited",
      origin: { channelType: "slack" },
    });
  });
});

describe("engineToWireParts", () => {
  it("keeps per-block timing in history and live updates", () => {
    const part = { type: "thinking" as const, text: "", startedAt: 1000, durationMs: 2400 };
    const wirePart = { kind: "thinking", text: "", startedAt: 1000, durationMs: 2400 };
    expect(engineToWireParts([part])).toEqual([wirePart]);
    expect(busEventToWire(ev({ type: "thinking_update", threadId: "t1", messageId: "m1", index: 2, part })))
      .toEqual([{ type: "thinking_update", threadId: "t1", messageId: "m1", index: 2, part: wirePart }]);
  });

  it("translates engine tool_call → wire tool_call (snake_case kind)", () => {
    const parts: EngineMessagePart[] = [
      { type: "tool_call", callId: "c1", toolName: "bash", status: "running" },
    ];
    expect(engineToWireParts(parts)).toEqual([
      { kind: "tool_call", callId: "c1", toolName: "bash", status: "running", args: undefined, result: undefined, error: undefined },
    ]);
  });

  it("forwards thinking parts, drops attachment and error", () => {
    const parts: EngineMessagePart[] = [
      { type: "text", text: "hi" },
      { type: "thinking", text: "let me consider..." },
      // Attachment as a message *part* stays dropped on the wire — image
      // attachments live on the Message itself (via `attachments`), not as
      // a part. The wire type deliberately does not grow an `attachment`
      // part variant; see wire/types.ts.
      {
        type: "attachment",
        attachment: {
          type: "image",
          mimeType: "image/png",
          name: "shot.png",
          data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        },
      },
      { type: "error", message: "x" },
    ];
    expect(engineToWireParts(parts)).toEqual([
      { kind: "text", text: "hi" },
      { kind: "thinking", text: "let me consider..." },
    ]);
  });

  it("returns [] for missing parts", () => {
    expect(engineToWireParts(undefined)).toEqual([]);
  });
});

describe("busEventToWire", () => {
  it("preserves image evidence beside the text fallback", () => {
    const resultData = { content: [
      { type: "text", text: "Screenshot" },
      { type: "image", data: "cGl4ZWxz", mimeType: "image/png" },
    ] };
    expect(busEventToWire(ev({
      type: "tool_end", threadId: "t1", tool: "browser_execute",
      result: "Screenshot", resultData, isError: false,
    }))).toEqual([expect.objectContaining({ result: "Screenshot", resultData })]);
  });

  it("forwards message_start", () => {
    const out = busEventToWire(ev({ type: "message_start", threadId: "t1", messageId: "m1", role: "assistant" }));
    expect(out).toEqual([{ type: "message_start", threadId: "t1", messageId: "m1", role: "assistant" }]);
  });

  it("forwards the tool-use message_end reason", () => {
    const out = busEventToWire(
      ev({ type: "message_end", threadId: "t1", messageId: "m1", reason: "tool_use" }),
    );
    expect(out).toEqual([{ type: "message_end", threadId: "t1", messageId: "m1", reason: "tool_use" }]);
  });

  it("forwards the item a merged submission joined", () => {
    const out = busEventToWire(ev({
      type: "submission_settled", sessionId: "s1", threadId: "t1", queueItemId: "q2",
      outcome: { outcome: "merged" }, mergedIntoItemId: "q1",
    }));
    expect(out).toEqual([{ type: "submission.settled", sessionId: "s1", threadId: "t1", queueItemId: "q2", outcome: "merged", error: undefined, mergedIntoItemId: "q1" }]);
  });

  it("forwards text_delta with empty messageId placeholder", () => {
    const out = busEventToWire(ev({ type: "text_delta", threadId: "t1", text: "hello" }));
    expect(out).toEqual([{ type: "text_delta", threadId: "t1", messageId: "", delta: "hello" }]);
  });

  it("forwards tool_start", () => {
    const out = busEventToWire(ev({ type: "tool_start", threadId: "t1", tool: "bash", args: { cmd: "ls" } }));
    expect(out).toEqual([{ type: "tool_start", threadId: "t1", toolName: "bash", args: { cmd: "ls" } }]);
  });

  it("forwards callId on tool_start and tool_end when present", () => {
    const start = busEventToWire(
      ev({ type: "tool_start", threadId: "t1", tool: "bash", callId: "tc1", args: {} }),
    );
    expect(start).toEqual([
      { type: "tool_start", threadId: "t1", toolName: "bash", callId: "tc1", args: {} },
    ]);
    const end = busEventToWire(
      ev({ type: "tool_end", threadId: "t1", tool: "bash", callId: "tc1", result: "ok", isError: false }),
    );
    expect(end).toEqual([
      { type: "tool_end", threadId: "t1", toolName: "bash", callId: "tc1", result: "ok", isError: false },
    ]);
  });

  it("forwards tool_call_update args deltas", () => {
    const out = busEventToWire(
      ev({ type: "tool_call_update", threadId: "t1", callId: "tc1", toolName: "write", argsDelta: '{"pa' }),
    );
    expect(out).toEqual([
      { type: "tool_call_update", threadId: "t1", callId: "tc1", toolName: "write", argsDelta: '{"pa' },
    ]);
  });

  it("forwards tool_end with result + isError", () => {
    const out = busEventToWire(ev({ type: "tool_end", threadId: "t1", tool: "bash", result: "ok", isError: false }));
    expect(out).toEqual([{ type: "tool_end", threadId: "t1", toolName: "bash", result: "ok", isError: false }]);
  });

  it("forwards status events directly (engine status ⊆ wire status)", () => {
    const out = busEventToWire(ev({ type: "status", threadId: "t1", status: "thinking" }));
    expect(out).toEqual([{ type: "status", threadId: "t1", status: "thinking" }]);
    expect(busEventToWire(ev({ type: "status", threadId: "t1", status: "tool_calling", turnStartedAt: 4000 })))
      .toEqual([{ type: "status", threadId: "t1", status: "tool_calling", turnStartedAt: 4000 }]);
  });

  it("forwards turn_end", () => {
    const out = busEventToWire(ev({ type: "turn_end", threadId: "t1", reason: "end_turn" }));
    expect(out).toEqual([{ type: "turn_end", threadId: "t1", reason: "end_turn" }]);
  });

  it("forwards title updates after persistence", () => {
    expect(
      busEventToWire(
        ev({
          type: "title_updated",
          threadId: "t1",
          sessionTitle: "Fix Authentication",
          threadTitle: "Fix Authentication",
        }),
      ),
    ).toEqual([
      {
        type: "title.updated",
        sessionId: "s1",
        threadId: "t1",
        sessionTitle: "Fix Authentication",
        threadTitle: "Fix Authentication",
      },
    ]);
  });

  it("forwards persisted thread user activity", () => {
    expect(
      busEventToWire(ev({ type: "thread_user_activity", threadId: "t1", activityAt: 250 })),
    ).toEqual([
      {
        type: "thread.activity",
        sessionId: "s1",
        threadId: "t1",
        lastUserActivityAt: 250,
      },
    ]);
  });

  it("drops out-of-scope event types (thread_start, ...)", () => {
    expect(busEventToWire(ev({ type: "thread_start", threadId: "t1" }))).toEqual([]);
  });

  it("forwards compaction lifecycle events (thread-model-pinning design, decision 7)", () => {
    expect(busEventToWire(ev({ type: "compaction_start", threadId: "t1" }))).toEqual([
      { type: "compaction_start", threadId: "t1" },
    ]);
    expect(busEventToWire(ev({ type: "compaction_end", threadId: "t1" }))).toEqual([
      { type: "compaction_end", threadId: "t1" },
    ]);
  });

  it("forwards decision_gate with engine→wire shape projection", () => {
    const out = busEventToWire(
      ev({
        type: "decision_gate",
        threadId: "t1",
        gate: {
          id: "g1",
          sessionId: "s1",
          threadId: "t1",
          queueItemId: "q1",
          resumeKey: "rm-rf",
          ordinal: 0,
          type: "approval",
          title: "Run rm -rf?",
          body: "About to delete /workspace/build",
          actions: [
            { id: "allow", label: "Allow", style: "primary" },
            { id: "deny", label: "Deny", style: "danger" },
          ],
          status: "pending",
          createdAt: 100,
          updatedAt: 100,
          // engine-only fields the wire drops
          context: { foo: "bar" },
          origin: { channelType: "web" },
        },
      }),
    );
    expect(out).toHaveLength(1);
    const wire = out[0] as Extract<(typeof out)[number], { type: "decision_gate" }>;
    expect(wire.threadId).toBe("t1");
    expect(wire.gate.id).toBe("g1");
    expect(wire.gate.actions).toHaveLength(2);
    expect(wire.gate.title).toBe("Run rm -rf?");
    // engine-only fields are not in the wire shape
    const wireKeys = Object.keys(wire.gate);
    expect(wireKeys).not.toContain("context");
    expect(wireKeys).not.toContain("origin");
    expect(wireKeys).not.toContain("refs");
  });

  it("forwards decision_gate_resolved with resolution body", () => {
    const out = busEventToWire(
      ev({
        type: "decision_gate_resolved",
        threadId: "t1",
        gateId: "g1",
        resolution: {
          actionId: "allow",
          resolvedBy: "u1",
          resolvedAt: 200,
          source: { channelType: "web" }, // dropped
        },
      }),
    );
    expect(out).toEqual([
      {
        type: "decision_gate_resolved",
        threadId: "t1",
        gateId: "g1",
        resolution: {
          actionId: "allow",
          value: undefined,
          resolvedBy: "u1",
          resolvedAt: 200,
        },
      },
    ]);
  });

  it("forwards decision_gate_expired", () => {
    const out = busEventToWire(
      ev({ type: "decision_gate_expired", threadId: "t1", gateId: "g1" }),
    );
    expect(out).toEqual([
      { type: "decision_gate_expired", threadId: "t1", gateId: "g1" },
    ]);
  });

  it("forwards decision_gate_withdrawn with reason", () => {
    const out = busEventToWire(
      ev({
        type: "decision_gate_withdrawn",
        threadId: "t1",
        gateId: "g1",
        reason: "cancel",
      }),
    );
    expect(out).toEqual([
      {
        type: "decision_gate_withdrawn",
        threadId: "t1",
        gateId: "g1",
        reason: "cancel",
      },
    ]);
  });

  it("forwards model_switched (thread scope) with threadId preserved", () => {
    const out = busEventToWire(
      ev({
        type: "model_switched",
        threadId: "t1",
        fromModel: "claude-haiku-4-5",
        toModel: "claude-opus-4-7",
        reason: "tool:switch_model",
      }),
    );
    expect(out).toEqual([
      {
        type: "model_switched",
        threadId: "t1",
        fromModel: "claude-haiku-4-5",
        toModel: "claude-opus-4-7",
        reason: "tool:switch_model",
      },
    ]);
  });

  it("forwards model_switched (session scope) with threadId normalized to undefined", () => {
    // Session.setModel emits with an empty threadId to signal session
    // scope; the bridge normalizes it so clients can distinguish from a
    // thread-level switch by checking threadId presence.
    const out = busEventToWire({
      sessionId: "s1",
      threadId: undefined,
      userId: "u1",
      timestamp: 100,
      event: {
        type: "model_switched",
        threadId: "" as unknown as string,
        fromModel: "claude-haiku-4-5",
        toModel: "claude-opus-4-7",
        reason: "set_via_api",
      },
    });
    expect(out).toEqual([
      {
        type: "model_switched",
        threadId: undefined,
        fromModel: "claude-haiku-4-5",
        toModel: "claude-opus-4-7",
        reason: "set_via_api",
      },
    ]);
  });

  it("forwards active model_state with its submission pair", () => {
    const out = busEventToWire(
      ev({
        type: "model_state",
        threadId: "t1",
        queueItemId: "q1",
        model: "anthropic/claude-opus-4-7",
      }),
    );
    expect(out).toEqual([
      {
        type: "model.state",
        threadId: "t1",
        queueItemId: "q1",
        model: "anthropic/claude-opus-4-7",
      },
    ]);
  });

  it("forwards idle model_state with both submission fields cleared", () => {
    const out = busEventToWire(
      ev({
        type: "model_state",
        threadId: "t1",
        queueItemId: null,
        model: null,
      }),
    );
    expect(out).toEqual([
      {
        type: "model.state",
        threadId: "t1",
        queueItemId: null,
        model: null,
      },
    ]);
  });

  it("forwards sandbox_status with estimateMs passthrough", () => {
    const out = busEventToWire(
      ev({
        type: "sandbox_status",
        sandboxId: "sb1",
        state: "provisioning",
        epoch: 2,
        estimateMs: 8000,
      }),
    );
    expect(out).toEqual([
      { type: "sandbox.status", state: "provisioning", epoch: 2, estimateMs: 8000 },
    ]);
  });

  it("forwards sandbox_status without estimateMs", () => {
    const out = busEventToWire(
      ev({
        type: "sandbox_status",
        state: "ready",
        epoch: 1,
      }),
    );
    expect(out).toEqual([{ type: "sandbox.status", state: "ready", epoch: 1, estimateMs: undefined }]);
  });
});

describe("engineGateToWire oneShot", () => {
  const gate = (context?: Record<string, unknown>): DecisionGate => ({
    id: "g1", sessionId: "s1", threadId: "t1", queueItemId: "q1", resumeKey: "k", ordinal: 0, type: "approval",
    title: "Approve?", actions: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }],
    status: "pending", createdAt: 1, updatedAt: 1, ...(context ? { context } : {}),
  });

  it("marks a tool approval gate whose approve allows only this call", () => {
    expect(engineGateToWire(gate({ tool_id: "github.get_issue", oneShot: true })).oneShot).toBe(true);
  });

  it("preserves one-shot eligibility when the gate names its requester", () => {
    const wire = engineGateToWire(gate({
      tool_id: "github.get_issue", oneShot: true, approver: { userId: "bea" },
      provenance: { baseMode: "require_approval", source: "team_policy" },
    }));
    expect(wire.oneShot).toBe(true);
    expect(wire.approver).toEqual({ userId: "bea" });
  });

  it.each([undefined, { userId: "lender" }])("excludes shared-account consent even with a stale one-shot marker (approver: %j)", (approver) => {
    expect(engineGateToWire(gate({
      tool_id: "github.get_issue", oneShot: true, approver,
      provenance: { baseMode: "allow", source: "shared_account" },
    })).oneShot).toBeUndefined();
  });

  it("excludes legacy shared-account consent without complete policy provenance", () => {
    expect(engineGateToWire(gate({
      tool_id: "github.get_issue", oneShot: true, approver: { userId: "lender" },
      provenance: { source: "shared_account" },
    })).oneShot).toBeUndefined();
  });

  it("leaves it off a gate that covers later work or lends an account", () => {
    // sec_start and ask_approval open plain approval gates with approve/deny and no tool context.
    expect(engineGateToWire(gate()).oneShot).toBeUndefined();
    expect(engineGateToWire(gate({ tool_id: "github.get_issue" })).oneShot).toBeUndefined();
    expect(engineGateToWire(gate({ tool_id: "github.get_issue", approver: { userId: "bea" } })).oneShot).toBeUndefined();
    expect(engineGateToWire(gate({ oneShot: true })).oneShot).toBeUndefined();
  });
});

describe("engineGateToWire riskLevel", () => {
  const gate = (context?: Record<string, unknown>): DecisionGate => ({
    id: "g1", sessionId: "s1", threadId: "t1", queueItemId: "q1", resumeKey: "k", ordinal: 0, type: "approval",
    title: "Approve?", actions: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }],
    status: "pending", createdAt: 1, updatedAt: 1, ...(context ? { context } : {}),
  });

  it("carries the tool action's risk level", () => {
    expect(engineGateToWire(gate({ tool_id: "github.delete_repo", riskLevel: "critical" })).riskLevel).toBe("critical");
    expect(engineGateToWire(gate({ tool_id: "github.get_issue", riskLevel: "low" })).riskLevel).toBe("low");
  });

  it("omits an unknown level and gates without tool context", () => {
    expect(engineGateToWire(gate({ tool_id: "github.get_issue", riskLevel: "extreme" })).riskLevel).toBeUndefined();
    expect(engineGateToWire(gate({ riskLevel: "high" })).riskLevel).toBeUndefined();
  });
});

describe("engineGateToWire tool", () => {
  // The body the engine writes for a tool approval (`approvalGateRequest`).
  const toolBody = (toolId: string, args: Record<string, unknown>) =>
    `Post the release notes\n\ntool_id=${toolId}\nargs=${JSON.stringify(args, null, 2)}`;
  const gate = (overrides: Partial<DecisionGate>): DecisionGate => ({
    id: "g1", sessionId: "s1", threadId: "t1", queueItemId: "q1", resumeKey: "k", ordinal: 0, type: "approval",
    title: "Approve Send Message?", actions: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }],
    status: "pending", createdAt: 1, updatedAt: 1, ...overrides,
  });

  it("carries the gated call's id and args", () => {
    const args = { channel: "#eng", text: "Release 1.2 is out.", thread_ts: "1780887543.189519" };
    const wire = engineGateToWire(gate({
      body: toolBody("slack.send_message", args),
      context: { tool_id: "slack.send_message", service: "slack", args, summary: "Post the release notes", oneShot: true },
    }));
    expect(wire.tool).toEqual({ id: "slack.send_message", args });
  });

  it("carries the id alone when the context has no args", () => {
    const wire = engineGateToWire(gate({ body: toolBody("gmail.send_draft", {}), context: { tool_id: "gmail.send_draft" } }));
    expect(wire.tool).toEqual({ id: "gmail.send_draft" });
  });

  it("cuts string args longer than 4000 characters at any depth", () => {
    const long = `${"a".repeat(3999)}😀tail`;
    const args = { text: long, short: "ok", count: 3, nested: { body: long }, list: [long, 1] };
    const wire = engineGateToWire(gate({ body: toolBody("slack.send_message", args), context: { tool_id: "slack.send_message", args } }));
    const cut = `${"a".repeat(3999)}😀…`;
    expect(wire.tool?.args).toEqual({ text: cut, short: "ok", count: 3, nested: { body: cut }, list: [cut, 1] });
    // A string at the limit passes through unchanged.
    const atLimit = "b".repeat(4000);
    const exact = engineGateToWire(gate({ body: toolBody("slack.send_message", { text: atLimit }), context: { tool_id: "slack.send_message", args: { text: atLimit } } }));
    expect(exact.tool?.args).toEqual({ text: atLimit });
  });

  it("omits it on gates without tool context", () => {
    expect(engineGateToWire(gate({ body: "Deploy to production?" })).tool).toBeUndefined();
    expect(engineGateToWire(gate({ type: "question", body: toolBody("slack.send_message", {}), context: { tool_id: "slack.send_message", args: {} } })).tool).toBeUndefined();
  });

  it("omits it when the body does not show the call", () => {
    // A shared-account gate replaces the tool_id/args body with prose.
    const context = { tool_id: "slack.send_message", args: { channel: "#eng", text: "hi" }, approver: { userId: "u2" } };
    expect(engineGateToWire(gate({ body: "Valet would use your Slack account.", context })).tool).toBeUndefined();
    expect(engineGateToWire(gate({ context })).tool).toBeUndefined();
  });
});

describe("queuedItemToWire", () => {
  const item = (over: Partial<QueueItem>): QueueItem => ({
    id: "q-1", threadId: "t1", content: "hello", status: "queued", attemptCount: 0, maxAttempts: 10,
    timeoutAt: 0, createdAt: 1, updatedAt: 1, ...over,
  });

  it("carries the text the queued stack shows, never the files", () => {
    expect(queuedItemToWire(item({ metadata: { [MID_TURN_DELIVERY_KEY]: true } }))).toEqual({ id: "q-1", text: "hello", midTurn: true });
    expect(queuedItemToWire(item({
      content: { text: "see the image", attachments: [{ type: "image", url: "data:image/png;base64,AAAA", mimeType: "image/png" }] },
    }))).toEqual({ id: "q-1", text: "see the image", midTurn: false, attachments: 1 });
    expect(queuedItemToWire(item({ content: { kind: "signal", signalType: "wakeup.timer", tagName: "wakeup", body: "Check it." } })))
      .toEqual({ id: "q-1", text: "Check it.", signal: { type: "wakeup" }, midTurn: false });
    // The engine's default tag names no kind, so a child's result reads as its type.
    expect(queuedItemToWire(item({ content: { kind: "signal", signalType: "child.settled", tagName: "signal", body: "Done." } })))
      .toEqual({ id: "q-1", text: "Done.", signal: { type: "child.settled" }, midTurn: false });
    const long = queuedItemToWire(item({ content: "x".repeat(QUEUED_TEXT_MAX + 50) }));
    expect(long.text).toHaveLength(QUEUED_TEXT_MAX + 1);
  });
});
