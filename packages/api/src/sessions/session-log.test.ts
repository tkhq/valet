/**
 * The projection behind `GET /api/sessions/:id/log` (V1 port #8).
 *
 * Two properties matter and are pinned here. The log must SHOW the events a
 * person reads to answer "what is this session doing" — lifecycle, tools,
 * turn boundaries, errors. And it must DROP the streaming plane, because a
 * log that repeats the reply token by token is not a log.
 */
import { describe, it, expect } from "vitest";
import type { EngineEvent, StoredBusEvent } from "@valet/engine";
import { isLoggable, toLogEntries, toLogEntry } from "./session-log.js";

function stored(event: EngineEvent, over: Partial<StoredBusEvent> = {}): StoredBusEvent {
  return {
    sessionId: "s-1",
    event,
    timestamp: 1_700_000_000_000,
    offset: "0000000000000001",
    ...over,
  };
}

describe("isLoggable", () => {
  it("keeps the lifecycle, tool, turn, and error events", () => {
    for (const type of [
      "sandbox_status",
      "status",
      "thread_start",
      "model_switched",
      "tool_start",
      "tool_end",
      "turn_end",
      "submission_settled",
      "error",
    ]) {
      expect(isLoggable(type)).toBe(true);
    }
  });

  it("drops the streaming plane", () => {
    // These arrive once per token or per argument chunk. They are transcript
    // material and would drown every other row.
    for (const type of ["text_delta", "tool_call_update", "message_delta", "message_start", "message_end"]) {
      expect(isLoggable(type)).toBe(false);
    }
  });

  it("drops queue_state, which the composer already shows", () => {
    expect(isLoggable("queue_state")).toBe(false);
  });

  it("drops an event type it has no line for", () => {
    expect(isLoggable("some_event_added_next_quarter")).toBe(false);
  });
});

describe("toLogEntry", () => {
  it("returns null for an event with no line", () => {
    expect(toLogEntry(stored({ type: "text_delta", threadId: "t-1", text: "hello" }))).toBeNull();
  });

  it("names the tool and the thing it acted on", () => {
    const entry = toLogEntry(
      stored({ type: "tool_start", threadId: "t-1", tool: "edit", args: { path: "src/app.ts", content: "…" } }),
    );
    expect(entry?.kind).toBe("tool");
    expect(entry?.summary).toBe("Tool edit");
    expect(entry?.detail).toBe("src/app.ts");
  });

  it("falls back through the argument fields to find a subject", () => {
    const entry = toLogEntry(
      stored({ type: "tool_start", threadId: "t-1", tool: "bash", args: { command: "pnpm test" } }),
    );
    expect(entry?.detail).toBe("pnpm test");
  });

  it("leaves the detail off when no argument names a subject", () => {
    const entry = toLogEntry(stored({ type: "tool_start", threadId: "t-1", tool: "think", args: { depth: 3 } }));
    expect(entry?.detail).toBeUndefined();
  });

  it("says a tool failed", () => {
    const entry = toLogEntry(
      stored({ type: "tool_end", threadId: "t-1", tool: "bash", result: "exit 1", isError: true }),
    );
    expect(entry?.summary).toBe("Tool bash failed");
  });

  it("reports the sandbox state and epoch", () => {
    const entry = toLogEntry(stored({ type: "sandbox_status", state: "ready", epoch: 2, sandboxId: "sb-9" }));
    expect(entry?.kind).toBe("lifecycle");
    expect(entry?.summary).toBe("Sandbox ready");
    expect(entry?.detail).toBe("sb-9 (epoch 2)");
  });

  it("reads an engine status without its underscores", () => {
    const entry = toLogEntry(stored({ type: "status", threadId: "t-1", status: "blocked_on_decision_gate" }));
    expect(entry?.summary).toBe("Agent blocked on decision gate");
  });

  it("summarises a turn with its model, duration, and token total", () => {
    const entry = toLogEntry(
      stored({
        type: "turn_end",
        threadId: "t-1",
        reason: "end_turn",
        model: "claude-opus-5",
        turnDurationMs: 4321,
        usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, total: 125 },
      }),
    );
    expect(entry?.kind).toBe("turn");
    expect(entry?.summary).toBe("Turn ended (end turn)");
    expect(entry?.detail).toBe("claude-opus-5 · 4.3s · 125 tokens");
  });

  it("carries the error code and message", () => {
    const entry = toLogEntry(
      stored({ type: "error", threadId: "t-1", code: "provider_error", error: "429 too many requests", recoverable: true }),
    );
    expect(entry?.kind).toBe("error");
    expect(entry?.summary).toBe("Error provider_error");
    expect(entry?.detail).toBe("429 too many requests");
  });

  it("says how long a stuck message has been stuck", () => {
    const entry = toLogEntry(
      stored({
        type: "submission_stuck",
        sessionId: "s-1",
        threadId: "t-1",
        queueItemId: "q-1",
        attemptCount: 3,
        ageMs: 20 * 60_000,
      }),
    );
    expect(entry?.detail).toBe("3 attempts over 20 minutes");
  });

  it("carries the stream offset and thread id through", () => {
    const entry = toLogEntry(
      stored({ type: "thread_start", threadId: "t-7" }, { offset: "0000000000000042", threadId: "t-7" }),
    );
    expect(entry?.offset).toBe("0000000000000042");
    expect(entry?.threadId).toBe("t-7");
  });

  it("flattens and clips a long detail to one line", () => {
    const entry = toLogEntry(
      stored({ type: "tool_end", threadId: "t-1", tool: "read", result: `line\n${"x".repeat(400)}`, isError: false }),
    );
    expect(entry?.detail).not.toContain("\n");
    expect((entry?.detail ?? "").length).toBeLessThanOrEqual(160);
    expect(entry?.detail?.endsWith("…")).toBe(true);
  });

  it("does not prefix a command that already carries its slash", () => {
    const entry = toLogEntry(
      stored({
        type: "command_result",
        threadId: "t-1",
        entry: {
          id: "e-1",
          sessionId: "s-1",
          threadId: "t-1",
          parentId: null,
          type: "command_result",
          command: "/model",
          source: "builtin",
          ok: true,
          output: "switched",
          createdAt: 1,
        },
      }),
    );
    expect(entry?.summary).toBe("Command /model");
  });
});

describe("toLogEntries", () => {
  it("keeps reading order and drops the rows with no line", () => {
    const entries = toLogEntries([
      stored({ type: "thread_start", threadId: "t-1" }, { offset: "1" }),
      stored({ type: "text_delta", threadId: "t-1", text: "he" }, { offset: "2" }),
      stored({ type: "text_delta", threadId: "t-1", text: "llo" }, { offset: "3" }),
      stored({ type: "tool_start", threadId: "t-1", tool: "read", args: { path: "a.ts" } }, { offset: "4" }),
    ]);
    expect(entries.map((e) => e.offset)).toEqual(["1", "4"]);
  });

  it("returns nothing for an empty page", () => {
    expect(toLogEntries([])).toEqual([]);
  });
});
