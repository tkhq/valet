import { describe, expect, it } from "vitest";
import { eventKeyMatches, hasChannelScopeFilter, selectsSlackMention, storedAnyChannel } from "./event-match.js";

describe("subscription match rules", () => {
  it("keeps wildcard matching within the dotted prefix", () => {
    expect(eventKeyMatches("github.pull_request.opened", ["github.pull_request.*"])).toBe(true);
    expect(eventKeyMatches("github.pull_request_review.submitted", ["github.pull_request.*"])).toBe(false);
    expect(eventKeyMatches("github.pull_request.opened", ["github.*.opened"])).toBe(false);
    expect(eventKeyMatches("github.pull_request.opened", [])).toBe(false);
    expect(selectsSlackMention(["slack.*"])).toBe(true);
    expect(selectsSlackMention(["slack.app_mention"])).toBe(true);
    expect(selectsSlackMention(["slack.message"])).toBe(false);
  });

  it("derives stored channel consent only from fixed channel filters", () => {
    for (const filter of [null, {}, { field: "user", op: "eq", value: "U1" },
      { field: "channel", op: "in", value: [] }, { field: "channel", op: "prefix", value: "C" }]) {
      expect(hasChannelScopeFilter([filter])).toBe(false);
      expect(storedAnyChannel(["slack.*"], [filter])).toBe(true);
    }
    expect(hasChannelScopeFilter([{ field: "channel", op: "eq", value: "C1" }])).toBe(true);
    expect(storedAnyChannel(["slack.*"], [{ field: "channel", op: "in", value: ["C1"] }])).toBe(false);
    expect(storedAnyChannel(["linear.issue.update"], [])).toBe(false);
  });
});
