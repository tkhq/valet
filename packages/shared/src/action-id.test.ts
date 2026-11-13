import { describe, expect, it } from "vitest";
import { canonicalizeToolScope, qualifiedActionId, type ActionIdResolver, buildActionIdResolver } from "./action-id.js";
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

describe("buildActionIdResolver", () => {
  const built = buildActionIdResolver([
    { service: "google_workspace", declaredIds: ["sheets.write_spreadsheet", "drive.search_files"], dynamic: false },
    { service: "google_calendar", declaredIds: ["calendar.list_events"], dynamic: false },
    { service: "slack-user", declaredIds: ["slack_user.post_message"], dynamic: false },
    { service: "slack", declaredIds: ["send_message"], dynamic: false },
    { service: "notion", declaredIds: [], dynamic: true },
  ]);

  it("resolves every accepted spelling of a static action to one canonical id", () => {
    expect(built.resolve("sheets.write_spreadsheet")).toEqual({ service: "google_workspace", canonical: "sheets.write_spreadsheet" });
    expect(built.resolve("google_workspace.sheets.write_spreadsheet")?.canonical).toBe("sheets.write_spreadsheet");
    expect(built.resolve("slack_user.post_message")).toEqual({ service: "slack-user", canonical: "slack_user.post_message" });
    expect(built.resolve("slack.send_message")).toEqual({ service: "slack", canonical: "slack.send_message" });
    // The service with the action's last segment, when one action ends with it.
    expect(built.resolve("google_calendar.list_events")?.canonical).toBe("calendar.list_events");
  });

  it("resolves a runtime service's tools and leaves unknown spellings unresolved", () => {
    expect(built.resolve("notion.search")).toEqual({ service: "notion", canonical: "notion.search" });
    expect(built.resolve("github.create_issue")).toBeUndefined();
    expect(built.resolve("send_message")).toBeUndefined();
  });

  it("names a service's foreign-prefixed ids for a wildcard", () => {
    expect(built.foreignPrefixedIds("google_workspace")).toEqual(["sheets.write_spreadsheet", "drive.search_files"]);
    expect(built.foreignPrefixedIds("slack")).toEqual([]);
    expect(built.service("Google-Workspace")).toBe("google_workspace");
  });
});
