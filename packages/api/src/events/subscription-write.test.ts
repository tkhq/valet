import { describe, expect, it } from "vitest";
import githubPlugin from "@valet/plugin-github/plugin";
import { validateSubscription } from "./subscription-write.js";

describe("subscription presence", () => {
  it.each([{ kind: "workflow", workflowId: "workflow" }, { kind: "orchestrator" }])("validates identity for $kind targets", (target) => {
    const body = { name: "PR helper", eventKeys: ["github.pull_request.opened"], filters: [], target };
    expect(validateSubscription([githubPlugin], { ...body, target: { ...target, presence: { displayName: "Reviewer", avatarUrl: "https://example.com/a.webp" } } })).toBeNull();
    expect(validateSubscription([githubPlugin], { ...body, target: { ...target, presence: { avatarUrl: "http://example.com/a" } } })).toContain("HTTPS");
    expect(validateSubscription([githubPlugin], { ...body, target: { ...target, presence: null } })).toContain("object");
    expect(validateSubscription([githubPlugin], body)).toBeNull();
  });
});
