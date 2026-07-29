import { describe, expect, it, vi } from "vitest";
import type { AgentClient } from "./agent-client.js";
import { ChannelSession, PromptHandler, extractUsageEntry } from "./prompt.js";

function createAgentClientMock() {
  return {
    sendUsageReport: vi.fn(),
    sendAgentStatus: vi.fn(),
    sendComplete: vi.fn(),
    sendTurnCreate: vi.fn(),
    sendTurnFinalize: vi.fn(),
    sendAnalyticsEvents: vi.fn(),
    sendReviewResult: vi.fn(),
  } as unknown as AgentClient & { sendUsageReport: ReturnType<typeof vi.fn> };
}

function createHandler(agentClient: AgentClient) {
  const handler = new PromptHandler("http://opencode.test", agentClient);
  (handler as any).eventStreamActive = true;
  return handler;
}

/** A `message.updated` info payload as OpenCode emits it. */
function assistantMessage(id: string, tokens: Record<string, unknown>) {
  return {
    id,
    role: "assistant",
    modelID: "claude-sonnet-4-6",
    providerID: "anthropic",
    tokens,
  };
}

const TOKENS = { input: 100, output: 50, reasoning: 25, cache: { read: 10_000, write: 500 } };

describe("extractUsageEntry", () => {
  it("keeps the five token buckets raw and composes billable totals", () => {
    const result = extractUsageEntry(assistantMessage("msg_1", TOKENS), null);

    expect(result).not.toBeNull();
    expect(result!.ocMessageId).toBe("msg_1");
    expect(result!.entry).toEqual({
      model: "anthropic/claude-sonnet-4-6",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10_000,
      cacheWriteTokens: 500,
      reasoningTokens: 25,
    });
    // Cache tiers bill as input, reasoning as output — but stay unfolded above.
    expect(result!.billableInput).toBe(10_600);
    expect(result!.billableOutput).toBe(75);
  });

  it("falls back to the supplied model when the message omits one", () => {
    const { modelID: _m, providerID: _p, ...noModel } = assistantMessage("msg_1", TOKENS);
    expect(extractUsageEntry(noModel, "anthropic/claude-opus-4-8")!.entry.model)
      .toBe("anthropic/claude-opus-4-8");
    expect(extractUsageEntry(noModel, null)!.entry.model).toBe("unknown");
  });

  it("returns null when there is nothing billable to report", () => {
    expect(extractUsageEntry(assistantMessage("msg_1", {}), null)).toBeNull();
    expect(extractUsageEntry({ id: "msg_1", role: "assistant" }, null)).toBeNull();
    expect(extractUsageEntry(assistantMessage("", TOKENS), null)).toBeNull();
    expect(extractUsageEntry(
      assistantMessage("msg_1", { input: 0, output: 0, cache: { read: 0, write: 0 } }), null,
    )).toBeNull();
  });

  it("coerces non-numeric token values to zero rather than NaN", () => {
    const result = extractUsageEntry(
      assistantMessage("msg_1", { input: "nope", output: 50, cache: null }), null);
    expect(result!.entry.inputTokens).toBe(0);
    expect(result!.entry.cacheReadTokens).toBe(0);
    expect(result!.billableOutput).toBe(50);
  });
});

describe("ephemeral session usage capture", () => {
  function armed(handler: PromptHandler, sessionId: string, opts: {
    kind?: "memory_flush" | "review";
    originTurnId?: string | null;
    excluded?: string[];
  } = {}) {
    (handler as any).ephemeralContent.set(sessionId, "");
    (handler as any).beginEphemeralUsage(
      sessionId,
      opts.kind ?? "memory_flush",
      opts.originTurnId === undefined ? "turn_1" : opts.originTurnId,
      "anthropic/claude-sonnet-4-6",
      new Set(opts.excluded ?? []),
    );
  }

  function feed(handler: PromptHandler, sessionId: string, info: Record<string, unknown>) {
    (handler as any).handleEvent({
      type: "message.updated",
      properties: { sessionID: sessionId, info },
    });
  }

  it("reports usage burned by a forked session", () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);
    armed(handler, "ses_fork");

    feed(handler, "ses_fork", assistantMessage("msg_flush", TOKENS));
    (handler as any).flushEphemeralUsage("ses_fork");

    expect(agentClient.sendUsageReport).toHaveBeenCalledTimes(1);
    const [turnId, entries, meta] = agentClient.sendUsageReport.mock.calls[0];
    expect(turnId).toBe("turn_1");
    expect(entries).toEqual([{
      ocMessageId: "msg_flush",
      model: "anthropic/claude-sonnet-4-6",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10_000,
      cacheWriteTokens: 500,
      reasoningTokens: 25,
    }]);
    expect(meta).toEqual({ kind: "memory_flush", ephemeralSessionId: "ses_fork" });
  });

  // POST /session/{id}/fork clones every parent message, emitting a
  // message.updated per clone that still carries the ORIGINAL token counts.
  // Billing those would report the whole conversation as flush cost.
  it("never bills the parent history a fork replayed", () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);
    armed(handler, "ses_fork", { excluded: ["clone_1", "clone_2"] });

    feed(handler, "ses_fork", assistantMessage("clone_1", { input: 900_000, output: 4_000, cache: { read: 5_000_000, write: 0 } }));
    feed(handler, "ses_fork", assistantMessage("clone_2", { input: 800_000, output: 3_000, cache: { read: 4_000_000, write: 0 } }));
    feed(handler, "ses_fork", assistantMessage("msg_flush", TOKENS));
    (handler as any).flushEphemeralUsage("ses_fork");

    const [, entries] = agentClient.sendUsageReport.mock.calls[0];
    expect(entries).toHaveLength(1);
    expect(entries[0].ocMessageId).toBe("msg_flush");
  });

  it("takes the latest token totals for a message that updates as it streams", () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);
    armed(handler, "ses_fork");

    feed(handler, "ses_fork", assistantMessage("msg_flush", { input: 100, output: 10, cache: { read: 0, write: 0 } }));
    feed(handler, "ses_fork", assistantMessage("msg_flush", { input: 100, output: 900, cache: { read: 10_000, write: 500 } }));
    (handler as any).flushEphemeralUsage("ses_fork");

    const [, entries] = agentClient.sendUsageReport.mock.calls[0];
    expect(entries).toHaveLength(1);
    expect(entries[0].outputTokens).toBe(900);
    expect(entries[0].cacheReadTokens).toBe(10_000);
  });

  // The whole point of a separate map: fork usage must never reach the
  // counters that decide when to flush, or the trigger tightens on itself.
  it("leaves the parent channel's compaction counters untouched", () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);
    const channel = new ChannelSession("chan_1");
    channel.opencodeSessionId = "ses_parent";
    channel.cumulativeInputTokens = 1_234;
    channel.cumulativeOutputTokens = 56;
    (handler as any).ocSessionToChannel.set("ses_parent", channel);
    armed(handler, "ses_fork");

    feed(handler, "ses_fork", assistantMessage("msg_flush", TOKENS));

    expect(channel.cumulativeInputTokens).toBe(1_234);
    expect(channel.cumulativeOutputTokens).toBe(56);
    expect(channel.usageEntries.size).toBe(0);
    expect(channel.countedTokenMessageIds.size).toBe(0);
  });

  it("attributes review usage to the session, with no turn", () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);
    armed(handler, "ses_review", { kind: "review", originTurnId: null });

    feed(handler, "ses_review", assistantMessage("msg_review", TOKENS));
    (handler as any).flushEphemeralUsage("ses_review");

    const [turnId, , meta] = agentClient.sendUsageReport.mock.calls[0];
    expect(turnId).toBeUndefined();
    expect(meta.kind).toBe("review");
  });

  it("does not report twice if flushed twice", () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);
    armed(handler, "ses_fork");

    feed(handler, "ses_fork", assistantMessage("msg_flush", TOKENS));
    (handler as any).flushEphemeralUsage("ses_fork");
    (handler as any).flushEphemeralUsage("ses_fork");

    expect(agentClient.sendUsageReport).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the session burned nothing", () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);
    armed(handler, "ses_fork");

    (handler as any).flushEphemeralUsage("ses_fork");

    expect(agentClient.sendUsageReport).not.toHaveBeenCalled();
  });

  it("ignores usage for a session that was never registered", () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);

    feed(handler, "ses_unknown", assistantMessage("msg_1", TOKENS));
    (handler as any).flushEphemeralUsage("ses_unknown");

    expect(agentClient.sendUsageReport).not.toHaveBeenCalled();
  });
});

describe("executeMemoryFlush usage attribution", () => {
  // executeMemoryFlush is fired and forgotten from turn finalize, and
  // cleanupAfterFinalize nulls channel.turnId immediately after. The turn must
  // therefore be captured before the first await, or the usage loses its turn.
  it("captures the turn id before finalize can null it", async () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);
    const channel = new ChannelSession("chan_1");
    channel.opencodeSessionId = "ses_parent";
    channel.turnId = "turn_1";
    channel.lastUsedModel = "anthropic/claude-sonnet-4-6";
    (handler as any).ocSessionToChannel.set("ses_parent", channel);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/fork")) {
        return new Response(JSON.stringify({ id: "ses_fork" }), { status: 200 });
      }
      if (url.endsWith("/message")) {
        // The fork's cloned history, which must not be billed.
        return new Response(JSON.stringify([{ info: { id: "clone_1" } }]), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    (handler as any).pollUntilIdle = vi.fn().mockResolvedValue(undefined);
    (handler as any).deleteSession = vi.fn().mockResolvedValue(undefined);
    // Runs once the fork is registered — stand-in for the flush turn's SSE.
    (handler as any).sendPromptAsync = vi.fn().mockImplementation(async () => {
      (handler as any).handleEvent({
        type: "message.updated",
        properties: {
          sessionID: "ses_fork",
          info: assistantMessage("clone_1", { input: 999_999, output: 999, cache: { read: 9_000_000, write: 0 } }),
        },
      });
      (handler as any).handleEvent({
        type: "message.updated",
        properties: { sessionID: "ses_fork", info: assistantMessage("msg_flush", TOKENS) },
      });
    });

    const flushing = (handler as any).executeMemoryFlush(channel);
    // Finalize nulls the turn while the flush is still in flight.
    channel.turnId = null;
    await flushing;

    expect(agentClient.sendUsageReport).toHaveBeenCalledTimes(1);
    const [turnId, entries, meta] = agentClient.sendUsageReport.mock.calls[0];
    expect(turnId).toBe("turn_1");
    expect(meta).toEqual({ kind: "memory_flush", ephemeralSessionId: "ses_fork" });
    // Only the flush's own message — the replayed clone is excluded.
    expect(entries).toHaveLength(1);
    expect(entries[0].ocMessageId).toBe("msg_flush");
    // And the flush's cost never feeds the counters that trigger it.
    expect(channel.cumulativeInputTokens).toBe(0);
    expect((handler as any).ephemeralUsage.has("ses_fork")).toBe(false);

    vi.restoreAllMocks();
  });
});
