import { describe, expect, it } from "vitest";
import { isThreadUnread, pendingAgentQuestion } from "./thread-read";

const replied = { lastUserActivityAt: 100, lastAgentActivityAt: 200, agentQuestion: "Merge it now?" };

describe("team thread notifications", () => {
  it("tells the people who wrote in a thread about its reply", () => {
    expect(isThreadUnread({ ...replied, participant: true })).toBe(true);
    expect(pendingAgentQuestion({ ...replied, participant: true })).toBe("Merge it now?");
  });

  it("does not tell a team member who never wrote in the thread", () => {
    expect(isThreadUnread({ ...replied, participant: false })).toBe(false);
    expect(pendingAgentQuestion({ ...replied, participant: false })).toBeUndefined();
  });

  it("keeps personal threads as they were", () => {
    expect(isThreadUnread(replied)).toBe(true);
    expect(isThreadUnread({ ...replied, readAt: 300 })).toBe(false);
    expect(pendingAgentQuestion(replied)).toBe("Merge it now?");
  });
});
