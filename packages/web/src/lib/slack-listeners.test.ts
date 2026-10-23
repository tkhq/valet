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

  it.each([false, true])("prefers own wildcard coverage over a specific other-team match (reverse=%s)", (reverse) => {
    const rules = [
      rule({ id: "own-all", filters: [] }),
      rule({ id: "other-pattern", ownerId: "t2", filters: [{ field: "channel_name", op: "prefix", value: "lead-" }] }),
    ];
    const listeners = slackChannelListeners(reverse ? rules.reverse() : rules, "t1", () => "Design",
      [{ id: "C1", name: "lead-sales" }]);
    expect(listenerFor(listeners, "C1")).toEqual({ kind: "this-team" });
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


describe("catalog channel occupancy", () => {
  const catalog = [{ id: "C1", name: "lead-sales" }, { id: "C2", name: "lead-dev" }, { id: "C3", name: "general" }];
  it.each(["prefix", "regex"] as const)("occupies %s matches for both teams", (op) => {
    for (const ownerId of ["t1", "t2"]) {
      const listeners = slackChannelListeners([rule({ ownerId, filters: [{ field: "channel_name", op, value: op === "prefix" ? "lead-" : "^lead-" }] })], "t1", () => "Design", catalog);
      expect(listenerFor(listeners, "C1")?.kind).toBe(ownerId === "t1" ? "this-team" : "other");
      expect(listenerFor(listeners, "C3")).toBeUndefined();
    }
  });
  it("intersects IDs, names and exclusions without evaluating unrelated conditions", () => {
    const listeners = slackChannelListeners([rule({ filters: [
      { field: "channel", op: "in", value: ["C1", "C2", "C3"] },
      { field: "channel_name", op: "prefix", value: "lead-" },
      { field: "channel_name", op: "not_regex", value: "dev$" },
      { field: "user", op: "eq", value: "U1" },
    ] })], "t1", () => undefined, catalog);
    expect([...listeners.keys()]).toEqual(["C1"]);
  });
  it.each(["(", "(a+)+", "x".repeat(201)])("fails closed for invalid or refused regex %s", (value) => {
    const listeners = slackChannelListeners([rule({ filters: [{ field: "channel_name", op: "not_regex", value }] })], "t1", () => undefined, catalog);
    expect(listeners.size).toBe(0);
  });
  it("keeps unrelated conditions as potential coverage, not unconditional scope", () => {
    const conditional = rule({ filters: [{ field: "user", op: "eq", value: "U1" }] });
    expect(listenerFor(slackChannelListeners([conditional], "t1", () => undefined, catalog), "C3"))
      .toEqual({ kind: "this-team", conditional: true });
    expect(teamListening([conditional], "t1").everywhere).toBe(false);
  });
  it.each([
    [{ field: "channel", op: "eq", value: "C1" }, { field: "channel", op: "eq", value: "C2" }],
    [{ field: "channel_name", op: "contains", value: "lead" }, { field: "channel", op: "not_in", value: ["C1", "C2"] }],
    [{ field: "channel_name", op: "prefix", value: "lead-" }, { field: "channel_name", op: "not_prefix", value: "lead-" }],
  ] satisfies EventSubscriptionWire["filters"][])("does not union contradictory scopes %j", (...filters) => {
    expect(slackChannelListeners([rule({ filters })], "t1", () => undefined, catalog).size).toBe(0);
  });
  it("uses the backend regex input bound for positive and negative patterns", () => {
    const longName = "a".repeat(2_000) + "suffix";
    const filters: EventSubscriptionWire["filters"] = [{ field: "channel_name", op: "regex", value: "suffix$" }];
    expect(slackChannelListeners([rule({ filters })], "t1", () => undefined, [{ id: "C1", name: longName }]).size).toBe(0);
    expect(slackChannelListeners([rule({ filters: [{ ...filters[0]!, op: "not_regex" }] })], "t1", () => undefined,
      [{ id: "C1", name: longName }]).has("C1")).toBe(true);
  });
  it("uses current names and ignores disabled rules", () => {
    const pattern = rule({ filters: [{ field: "channel_name", op: "prefix", value: "lead-" }] });
    expect(slackChannelListeners([pattern], "t1", () => undefined, catalog).has("C1")).toBe(true);
    expect(slackChannelListeners([pattern], "t1", () => undefined, [{ id: "C1", name: "general" }]).size).toBe(0);
    expect(slackChannelListeners([{ ...pattern, enabled: false }], "t1", () => undefined, catalog).size).toBe(0);
  });
  it("matches absent names only for exclusion operators", () => {
    for (const op of ["prefix", "not_prefix"] as const) {
      const listeners = slackChannelListeners([rule({ filters: [{ field: "channel_name", op, value: "lead-" }] })], "t1", () => undefined, [{ id: "C1" }]);
      expect(listeners.has("C1")).toBe(op === "not_prefix");
    }
  });
});
