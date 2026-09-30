import { describe, expect, it } from "vitest";
import type { EventSubscriptionWire } from "@valet/api/wire";
import { listenerFor, slackChannelListeners } from "./slack-listeners";

function rule(overrides: Partial<EventSubscriptionWire>): EventSubscriptionWire {
  return {
    id: "r", name: "Replies", ownerType: "team", ownerId: "t1", eventKeys: ["slack.app_mention"],
    filters: [{ field: "channel", op: "eq", value: "C1" }], target: { kind: "orchestrator", orchestrator: "team", teamId: "t1" },
    enabled: true, createdBy: "u", createdAt: 1, updatedAt: 1, ...overrides,
  };
}

describe("slackChannelListeners", () => {
  it("names who already listens in each channel", () => {
    const listeners = slackChannelListeners([
      rule({}),
      rule({ id: "r2", ownerId: "t2", filters: [{ field: "channel", op: "in", value: ["C2", "C3"] }] }),
      rule({ id: "r3", ownerType: "user", ownerId: "u9", filters: [{ field: "channel", op: "eq", value: "C4" }] }),
      rule({ id: "off", ownerId: "t2", enabled: false, filters: [{ field: "channel", op: "eq", value: "C5" }] }),
    ], "t1", (id) => (id === "t2" ? "Design" : undefined));
    expect(listenerFor(listeners, "C1")).toEqual({ kind: "this-team" });
    expect(listenerFor(listeners, "C3")).toEqual({ kind: "other", owner: "Design's Valet" });
    expect(listenerFor(listeners, "C4")).toEqual({ kind: "other", owner: "A personal Valet" });
    expect(listenerFor(listeners, "C5")).toBeUndefined();
  });

  it("treats a rule with no channel filter as listening everywhere", () => {
    const listeners = slackChannelListeners([rule({ ownerId: "t2", filters: [] })], "t1", () => "Design");
    expect(listenerFor(listeners, "C-any")).toEqual({ kind: "other", owner: "Design's Valet" });
  });
});
