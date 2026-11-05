import { describe, expect, it } from "vitest";
import { actionInScope, intersectToolScopes, readToolScope, toolInScope } from "./tool-scope.js";

describe("task tool scopes", () => {
  it("keeps an absent scope compatible and treats an empty list as deny all", () => {
    expect(actionInScope(undefined, "slack.post")).toBe(true);
    expect(actionInScope({ actions: [] }, "slack.post")).toBe(false);
    expect(toolInScope({ tools: [] }, "bash")).toBe(false);
  });
  it("matches complete service names without accepting neighboring prefixes", () => {
    expect(actionInScope({ actions: ["slack.*"] }, "slack.search")).toBe(true);
    expect(actionInScope({ actions: ["slack.*"] }, "slack_user.search")).toBe(false);
    expect(actionInScope({ actions: ["slack.search"] }, "slack.post")).toBe(false);
  });
  it("intersects a child's request with both inherited lists", () => {
    expect(intersectToolScopes(
      { tools: ["read", "skill"], actions: ["slack.*", "github.get_issue"] },
      { tools: ["skill", "bash"], actions: ["slack.search", "github.*", "gmail.send"] },
    )).toEqual({ tools: ["skill"], actions: ["slack.search", "github.get_issue"] });
  });
  it("preserves restrictions when another layer is absent", () => {
    expect(intersectToolScopes(undefined, { actions: [] })).toEqual({ actions: [] });
    expect(intersectToolScopes({ tools: ["read"] }, { actions: ["github.*"] }))
      .toEqual({ tools: ["read"], actions: ["github.*"] });
  });
  it("fails closed for malformed persisted scopes", () => {
    for (const value of [null, false, { actions: "slack.*" }, { actions: ["*"] }, { tools: [1] }, { typo: [] }]) {
      expect(readToolScope(value)).toEqual({ tools: [], actions: [] });
    }
    expect(readToolScope(undefined)).toBeUndefined();
    expect(readToolScope({ actions: ["github.get_issue"] })).toEqual({ actions: ["github.get_issue"] });
  });
});
