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


describe("subscription conversation destination", () => {
  const body = { name: "Review", eventKeys: ["github.pull_request.opened"], filters: [] };
  it.each([null, [], {}, { mode: "other" }, { mode: "existing" },
    { mode: "existing", sessionId: "", threadId: "t" },
    { mode: "existing", sessionId: "s", threadId: 1 },
    { mode: "new", threadId: "ignored" }])("refuses malformed destinations %j", thread => {
    expect(validateSubscription([githubPlugin], { ...body, target: { kind: "orchestrator", thread } })).not.toBeNull();
  });
  it.each([{ mode: "new" }, { mode: "existing", sessionId: "s", threadId: "t" }])("accepts destinations %j", thread => {
    expect(validateSubscription([githubPlugin], { ...body, target: { kind: "orchestrator", thread } })).toBeNull();
  });
  it("refuses destinations on workflows and alongside follow", () => {
    expect(validateSubscription([githubPlugin], { ...body, target: { kind: "workflow", workflowId: "w", thread: { mode: "new" } } })).not.toBeNull();
    expect(validateSubscription([githubPlugin], { ...body, target: { kind: "orchestrator", follow: true, thread: { mode: "new" } } })).not.toBeNull();
  });
});
