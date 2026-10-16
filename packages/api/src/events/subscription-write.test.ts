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

describe("subject filter (spec Part G)", () => {
  const body = { name: "PR helper", eventKeys: ["github.pull_request.opened"], target: { kind: "orchestrator" } };

  it("accepts eq and prefix for any key, without the field being plugin-declared", () => {
    expect(validateSubscription([githubPlugin], { ...body, filters: [{ field: "subject", op: "eq", value: "github:acme/lean-proofs#42" }] })).toBeNull();
    expect(validateSubscription([githubPlugin], { ...body, filters: [{ field: "subject", op: "prefix", value: "github:acme/lean-proofs" }] })).toBeNull();
  });

  it("refuses an op the spec does not define for subject", () => {
    const error = validateSubscription([githubPlugin], { ...body, filters: [{ field: "subject", op: "contains", value: "lean-proofs" }] });
    expect(error).toContain("subject");
    expect(error).toContain("eq");
    expect(error).toContain("prefix");
  });
});

describe("derived event keys (spec Part G, Non-goals)", () => {
  const body = { name: "CI", filters: [], target: { kind: "orchestrator" } };

  it("refuses a derived key and names the fix", () => {
    const error = validateSubscription([githubPlugin], { ...body, eventKeys: ["github.pull_request.checks_completed"] });
    expect(error).toContain("github.pull_request.checks_completed");
    expect(error).toContain("wait_for_event");
  });

  it("keeps a glob that also covers a derived key, without selecting it", () => {
    expect(validateSubscription([githubPlugin], { ...body, eventKeys: ["github.pull_request.*"] })).toBeNull();
  });
});
