/**
 * Pure-logic tests for `isEmptyAssistantMessage` — the predicate behind the
 * "(no response)" placeholder that names a turn that died before its first
 * token (bad key, exhausted credits) instead of rendering a blank bubble.
 */
import { describe, expect, it } from "vitest";
import type { StreamMessage } from "~/stores/stream";
import { isEmptyAssistantMessage } from "./message-item";

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
