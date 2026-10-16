import { describe, expect, it, vi } from "vitest";
import type { EngineHost } from "../engine/host.js";
import type { AppDb } from "../lib/drizzle.js";

const deliverToAssistantThread = vi.fn(async () => ({ sessionId: "sess-landed", threadId: "thr-landed" }));
vi.mock("./assistant-delivery.js", () => ({ deliverToAssistantThread }));

const { buildAssistantTarget } = await import("./assistant-target.js");

describe("buildAssistantTarget", () => {
  it("passes the resolved destination through and returns the thread it landed in", async () => {
    // The seam only forwards deps; the delivery function is mocked above.
    const deps = { db: {} as AppDb, engineHost: {} as EngineHost };
    const deliver = buildAssistantTarget(deps);
    const destination = { kind: "key" as const, key: "sub:rule-1", title: "ENG triage" };
    const landed = await deliver({
      orgId: "org-1", ownerType: "user", ownerId: "user-1", actorUserId: "user-1",
      signal: { kind: "signal", signalType: "linear.issue.update", body: "ENG-42 changed" },
      dispatchId: "event:d1", destination,
    });
    expect(landed).toEqual({ sessionId: "sess-landed", threadId: "thr-landed" });
    expect(deliverToAssistantThread).toHaveBeenCalledWith(deps, expect.objectContaining({
      orgId: "org-1", owner: { type: "user", id: "user-1" }, destination,
      dispatchId: "event:d1", mismatchReason: "event_target_mismatch",
    }));
  });
});
