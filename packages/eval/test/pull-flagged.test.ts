import { describe, expect, it } from "vitest";
import type { MessageEntry } from "@valet/engine";
import { flaggedPullFile } from "../src/index.js";

let entryId = 0;
function entry(overrides: Partial<MessageEntry>): MessageEntry {
  return {
    id: `e-${entryId++}`,
    sessionId: "s1",
    threadId: "t1",
    parentId: null,
    createdAt: 1000 + entryId,
    type: "message",
    role: "user",
    content: "",
    ...overrides,
  };
}

describe("flaggedPullFile", () => {
  it("extracts one trajectory per thread with prompt, model, and metadata", () => {
    const file = flaggedPullFile(
      {
        sessionId: "sess-1",
        rating: "positive",
        title: "Great run",
        ratedAt: 1234,
        userId: "u1",
        threads: [
          {
            threadId: "th-1",
            entries: [
              entry({ role: "user", content: "do the thing" }),
              entry({
                role: "assistant",
                content: "done",
                model: "anthropic/claude-haiku-4-5",
                stopReason: "end_turn",
                parts: [
                  {
                    type: "tool_call",
                    callId: "c1",
                    toolName: "bash",
                    status: "completed",
                    result: { text: "ok" },
                  },
                ],
              }),
            ],
          },
        ],
      },
      "2026-09-02T00:00:00.000Z",
    );

    expect(file.sessionId).toBe("sess-1");
    expect(file.rating).toBe("positive");
    expect(file.pulledAt).toBe("2026-09-02T00:00:00.000Z");
    expect(file.trajectories).toHaveLength(1);
    const t = file.trajectories[0];
    expect(t.caseId).toBe("flagged:sess-1:th-1");
    expect(t.prompt).toBe("do the thing");
    expect(t.model).toBe("anthropic/claude-haiku-4-5");
    expect(t.finalOutput).toBe("done");
    expect(t.toolCalls.map((c) => c.toolName)).toEqual(["bash"]);
    expect(t.metadata).toEqual({ sessionId: "sess-1", threadId: "th-1", rating: "positive" });
  });
});
