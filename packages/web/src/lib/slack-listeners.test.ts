import { describe, expect, it } from "vitest";
import type { EventSubscriptionWire } from "@valet/api/wire";
import { listenerFor, slackChannelListeners, teamListening } from "./slack-listeners";

function rule(overrides: Partial<EventSubscriptionWire>): EventSubscriptionWire {
  return {
    id: "r", name: "Replies", ownerType: "team", ownerId: "t1", eventKeys: ["slack.app_mention"],
    filters: [{ field: "channel", op: "eq", value: "C1" }], target: { kind: "assistant", assistant: "team", teamId: "t1" },
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

  it("does not call a prefix filter an exact channel or an everywhere listener", () => {
    const listeners = slackChannelListeners([rule({ ownerId: "t2", filters: [{ field: "channel", op: "prefix", value: "C" }] })], "t1", () => "Design");
    expect(listeners.has("C")).toBe(false);
    expect(listenerFor(listeners, "C-any")).toBeUndefined();
  });

  it("treats a rule with no channel filter as listening everywhere", () => {
    const listeners = slackChannelListeners([rule({ ownerId: "t2", filters: [] })], "t1", () => "Design");
    expect(listenerFor(listeners, "C-any")).toEqual({ kind: "other", owner: "Design's Valet" });
  });
});


describe("teamListening channel alternatives", () => {
  it("lists a name pattern as its own rule instead of everywhere", () => {
    const pattern = rule({ id: "lead", filters: [{ field: "channel_name", op: "prefix", value: "lead-" }] });
    const listening = teamListening([rule({}), pattern], "t1");
    expect(listening.everywhere).toBe(false);
    expect(listening.patterns).toEqual([pattern]);
    expect(listening.channels).toEqual([{ id: "C1", label: "C1" }]);
  });

  it("does not offer a conjunction of channel filters as one editable channel list", () => {
    const intersection = rule({ filters: [
      { field: "channel", op: "eq", value: "C1" },
      { field: "channel", op: "eq", value: "C2" },
    ] });
    expect(teamListening([intersection], "t1").editable).toBeUndefined();
  });
});
