import { describe, expect, it } from "vitest";
import { canonicalizeToolScope, qualifiedActionId, type ActionIdResolver } from "./action-id.js";
import { actionInScope } from "./tool-scope.js";

const resolver: ActionIdResolver = {
  resolve: (spelling) => {
    if (spelling === "sheets.write" || spelling === "google_workspace.sheets.write") return { service: "google_workspace", canonical: "sheets.write" };
    if (spelling === "slack.send") return { service: "slack", canonical: "slack.send" };
    return undefined;
  },
  service: (name) => (name === "google_workspace" || name === "slack" ? name : undefined),
  foreignPrefixedIds: (service) => (service === "google_workspace" ? ["sheets.write"] : []),
};

describe("qualifiedActionId", () => {
  it("keeps a declared id that has a dot and prefixes a bare one", () => {
    expect(qualifiedActionId("google_workspace", "sheets.write")).toBe("sheets.write");
    expect(qualifiedActionId("notion", "search")).toBe("notion.search");
  });
});

describe("canonicalizeToolScope", () => {
  it("rewrites exact entries to canonical ids", () => {
    const scope = canonicalizeToolScope({ tools: ["call_tool"], actions: ["google_workspace.sheets.write"] }, resolver);
    expect(scope).toEqual({ tools: ["call_tool"], actions: ["sheets.write"] });
    expect(actionInScope(scope, "sheets.write")).toBe(true);
  });

  it("expands a service wildcard with the service's foreign-prefixed ids", () => {
    const scope = canonicalizeToolScope({ actions: ["google_workspace.*"] }, resolver);
    expect(scope?.actions).toEqual(["google_workspace.*", "sheets.write"]);
    expect(actionInScope(scope, "slack.send")).toBe(false);
  });

  it("leaves unknown entries, a scope without actions, and a missing resolver unchanged", () => {
    expect(canonicalizeToolScope({ actions: ["x.y", "z.*"] }, resolver)?.actions).toEqual(["x.y", "z.*"]);
    expect(canonicalizeToolScope({ tools: ["bash"] }, resolver)).toEqual({ tools: ["bash"] });
    expect(canonicalizeToolScope({ actions: ["google_workspace.sheets.write"] }, undefined)?.actions).toEqual(["google_workspace.sheets.write"]);
  });
});
