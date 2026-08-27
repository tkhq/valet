/**
 * Pure-logic tests for `message-item` helpers: `isEmptyAssistantMessage`
 * (the predicate behind the "(no response)" placeholder) and
 * `messageCopyText` (the clipboard payload behind the per-message copy
 * button).
 */
import { describe, expect, it } from "vitest";
import { buildSkillBlock } from "@valet/shared";
import type { StreamMessage } from "~/stores/stream";
import { isEmptyAssistantMessage, messageCopyText } from "./message-item";

function msg(over: Partial<StreamMessage>): StreamMessage {
  return {
    id: "m1",
    sessionId: "s1",
    threadId: "t1",
    role: "assistant",
    content: "",
    parts: [],
    createdAt: 0,
    ...over,
  };
}

describe("isEmptyAssistantMessage", () => {
  it("matches a persisted assistant row with no parts and no content", () => {
    expect(isEmptyAssistantMessage(msg({}))).toBe(true);
  });

  it("ignores user messages and non-empty assistant messages", () => {
    expect(isEmptyAssistantMessage(msg({ role: "user" }))).toBe(false);
    expect(isEmptyAssistantMessage(msg({ content: "hi" }))).toBe(false);
    expect(
      isEmptyAssistantMessage(msg({ parts: [{ kind: "text", text: "hi" }] })),
    ).toBe(false);
  });
});

describe("messageCopyText", () => {
  it("joins text parts with blank lines and skips thinking/tool parts", () => {
    const text = messageCopyText(
      msg({
        parts: [
          { kind: "thinking", text: "pondering" },
          { kind: "text", text: "first" },
          {
            kind: "tool_call",
            callId: "c1",
            toolName: "bash",
            args: {},
            status: "completed",
          },
          { kind: "text", text: "second" },
        ],
      }),
    );
    expect(text).toBe("first\n\nsecond");
  });

  it("falls back to content when a message has no text parts", () => {
    expect(messageCopyText(msg({ content: "legacy body" }))).toBe("legacy body");
    // The fallback trims too. Without this a legacy message pastes the
    // padding the transport left around it.
    expect(messageCopyText(msg({ content: "  padded body  " }))).toBe("padded body");
    expect(
      messageCopyText(
        msg({ content: "legacy body", parts: [{ kind: "thinking", text: "x" }] }),
      ),
    ).toBe("legacy body");
  });

  it("returns an empty string when there is nothing to copy", () => {
    expect(messageCopyText(msg({}))).toBe("");
    expect(messageCopyText(msg({ parts: [{ kind: "text", text: "  " }] }))).toBe("");
  });

  it("copies the re-sendable command form for a skill-invocation user message", () => {
    // The bubble shows a collapsed card + the typed args; copying the raw
    // multi-KB expansion would paste internal markup that bypasses dispatch.
    const expansion = buildSkillBlock("review", "# Review\n\nbody", "src/ please");
    expect(
      messageCopyText(
        msg({ role: "user", content: expansion, skill: { name: "review", args: "src/ please" } }),
      ),
    ).toBe("/skill:review src/ please");
    // Legacy rows without the metadata stamp go through the regex tier.
    expect(messageCopyText(msg({ role: "user", content: buildSkillBlock("review", "body") }))).toBe(
      "/skill:review",
    );
  });

  it("never rewrites assistant text, even when it looks like a skill block", () => {
    const echoed = buildSkillBlock("review", "body");
    expect(messageCopyText(msg({ role: "assistant", content: echoed }))).toBe(echoed);
  });
});
