import { describe, expect, it } from "vitest";
import githubPlugin from "@valet/plugin-github/plugin";
import { InMemoryCredentialStore, type ValetPlugin } from "@valet/engine";
import { validateSubscription } from "./subscription-write.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { existingThreadError, subjectModeAllowed } from "./thread-policy-write.js";

describe("subscription appearance", () => {
  it.each([{ kind: "workflow", workflowId: "workflow" }, { kind: "assistant" }])("validates identity for $kind targets", (target) => {
    const body = { name: "PR helper", eventKeys: ["github.pull_request.opened"], filters: [], target };
    expect(validateSubscription([githubPlugin], { ...body, target: { ...target, appearance: { displayName: "Reviewer", avatarUrl: "https://example.com/a.webp" } } })).toBeNull();
    expect(validateSubscription([githubPlugin], { ...body, target: { ...target, appearance: { avatarUrl: "http://example.com/a" } } })).toContain("HTTPS");
    expect(validateSubscription([githubPlugin], { ...body, target: { ...target, appearance: null } })).toContain("object");
    expect(validateSubscription([githubPlugin], body)).toBeNull();
  });
});

describe("subject filter (spec Part G)", () => {
  const body = { name: "PR helper", eventKeys: ["github.pull_request.opened"], target: { kind: "assistant" } };

  it("accepts eq and prefix for any key, without the field being plugin-declared", () => {
    expect(validateSubscription([githubPlugin], { ...body, filters: [{ field: "subject", op: "eq", value: "github:acme/lean-proofs#42" }] })).toBeNull();
    expect(validateSubscription([githubPlugin], { ...body, filters: [{ field: "subject", op: "prefix", value: "github:acme/lean-proofs" }] })).toBeNull();
  });

  it("refuses an op the spec does not define for subject", () => {
    const error = validateSubscription([githubPlugin], { ...body, filters: [{ field: "subject", op: "contains", value: "lean-proofs" }] });
    expect(error).toBe('A place condition matches only with "is" or "starts with", not "contains". Change how the condition matches.');
  });
});

describe("derived event keys (spec Part G, Non-goals)", () => {
  const body = { name: "CI", filters: [], target: { kind: "assistant" } };

  it("refuses a derived key and names the fix", () => {
    const error = validateSubscription([githubPlugin], { ...body, eventKeys: ["github.pull_request.checks_completed"] });
    expect(error).toContain("github.pull_request.checks_completed");
    expect(error).toContain("wait_for_event");
  });

  it("keeps a glob that also covers a derived key, without selecting it", () => {
    expect(validateSubscription([githubPlugin], { ...body, eventKeys: ["github.pull_request.*"] })).toBeNull();
  });
});

describe("thread policy (spec 2026-10-16: delivery threads, Part A)", () => {
  const body = { name: "PR helper", eventKeys: ["github.pull_request.opened"], filters: [] };
  // The same catalog with no subject hook: its events name no natural subject.
  const { naturalSubject: _hook, ...subjectless } = githubPlugin;
  const githubWithoutSubject: ValetPlugin = subjectless;

  it("accepts every mode on an assistant target", () => {
    for (const thread of [{ mode: "new" }, { mode: "subject" }, { mode: "own" }, { mode: "existing", sessionId: "s1", threadId: "t1" }]) {
      expect(validateSubscription([githubPlugin], { ...body, target: { kind: "assistant", thread } })).toBeNull();
    }
  });

  it("refuses a malformed policy with the shape text", () => {
    expect(validateSubscription([githubPlugin], { ...body, target: { kind: "assistant", thread: { mode: "bogus" } } }))
      .toBe("Thread policy mode must be new, subject, own, or existing.");
    expect(validateSubscription([githubPlugin], { ...body, target: { kind: "assistant", thread: { mode: "own", extra: 1 } } }))
      .toBe('Thread policy has an unknown field "extra". Remove it.');
  });

  it("refuses subject when no selected event names a subject", () => {
    expect(validateSubscription([githubWithoutSubject], { ...body, target: { kind: "assistant", thread: { mode: "subject" } } }))
      .toBe("These events have no natural thread. Pick another choice under Where: its own thread or a new thread.");
  });

  it("refuses a thread policy on a workflow target", () => {
    expect(validateSubscription([githubPlugin], { ...body, target: { kind: "workflow", workflowId: "wf", thread: { mode: "new" } } }))
      .toBe("A thread choice applies only when the assistant does the work. Remove the thread from this workflow line.");
  });

  it("allows subject per plugin, from the plugin that owns the keys", () => {
    expect(subjectModeAllowed(["github.pull_request.opened"], [githubPlugin])).toBe(true);
    expect(subjectModeAllowed(["github.*"], [githubPlugin])).toBe(true);
    expect(subjectModeAllowed(["github.pull_request.opened"], [githubWithoutSubject])).toBe(false);
    expect(subjectModeAllowed(["linear.issue.update"], [githubPlugin])).toBe(false);
  });
});

describe("existingThreadError", () => {
  it("fails closed on a malformed policy instead of reading it as own", async () => {
    const { appDb } = await freshTestPgDb();
    const owner = { type: "user" as const, id: "u1" };
    const deps = { db: appDb, engineCredentials: new InMemoryCredentialStore() };
    const writer = { orgId: "org", userId: "u1" };
    expect(await existingThreadError(deps, writer, owner, { mode: "existing" }))
      .toBe("An existing thread needs sessionId and threadId.");
    expect(await existingThreadError(deps, writer, owner, { mode: "own", extra: 1 }))
      .toBe('Thread policy has an unknown field "extra". Remove it.');
    expect(await existingThreadError(deps, writer, owner, "existing"))
      .toBe("Thread policy must be an object with a mode.");
    expect(await existingThreadError(deps, writer, owner, { mode: "own" })).toBeNull();
    expect(await existingThreadError(deps, writer, owner, undefined)).toBeNull();
  });
});
