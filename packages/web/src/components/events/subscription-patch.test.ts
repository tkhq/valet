/**
 * The pure diff behind the edit-subscription dialog: which fields a save
 * sends, and when a save is a no-op. Mirrors the trigger dialog's rules —
 * only changed fields go on the wire, and an "Any channel" toggle alone
 * still rides the (unchanged) filters so the server re-runs the mention
 * gate. Filters compare by content, not key order: stored jsonb comes back
 * with alphabetized keys, and a rename must not re-send (and re-collision-
 * check) an unchanged match.
 */
import { describe, expect, it } from "vitest";
import type { EventSubscriptionFilterWire, EventSubscriptionWire } from "@valet/api/wire";
import { fromWireFilters, toWireFilters } from "./filter-editor";
import { buildSubscriptionPatch, storedAnyChannel } from "./subscription-patch";

function sub(over: Partial<EventSubscriptionWire> = {}): EventSubscriptionWire {
  return {
    id: "sub_1",
    name: "PR alerts",
    ownerType: "user",
    ownerId: "u1",
    eventKeys: ["github.pr.opened"],
    filters: [],
    target: { kind: "orchestrator" },
    enabled: true,
    createdBy: "u1",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

/** The form state as the dialog seeds it from the stored row — no edits. */
function unchangedForm(s: EventSubscriptionWire) {
  return {
    name: s.name,
    eventKeys: [...s.eventKeys],
    filters: toWireFilters(fromWireFilters(s.filters)),
    anyChannel: storedAnyChannel(s),
  };
}

const CHANNEL_EQ: EventSubscriptionFilterWire = {
  field: "channel",
  op: "eq",
  value: "C1",
  label: "#general",
};

describe("storedAnyChannel", () => {
  it("is true for a mention rule with no channel filter", () => {
    expect(storedAnyChannel(sub({ eventKeys: ["slack.app_mention"] }))).toBe(true);
  });

  it("is false for a mention rule with a channel filter", () => {
    expect(
      storedAnyChannel(sub({ eventKeys: ["slack.app_mention"], filters: [CHANNEL_EQ] })),
    ).toBe(false);
  });

  it("is false for a non-mention rule", () => {
    expect(storedAnyChannel(sub())).toBe(false);
  });
});

describe("buildSubscriptionPatch", () => {
  it("returns null when nothing changed", () => {
    const s = sub();
    expect(buildSubscriptionPatch(s, unchangedForm(s))).toBeNull();
  });

  it("ignores stored-filter key order (jsonb alphabetizes)", () => {
    // The same filter with its keys in jsonb's alphabetical order.
    const stored = { field: "channel", label: "#general", op: "eq", value: "C1" };
    const s = sub({ filters: [stored as EventSubscriptionFilterWire] });
    const patch = buildSubscriptionPatch(s, { ...unchangedForm(s), filters: [CHANNEL_EQ] });
    expect(patch).toBeNull();
  });

  it("a rename sends only the trimmed name", () => {
    const s = sub();
    expect(buildSubscriptionPatch(s, { ...unchangedForm(s), name: "  Renamed  " })).toEqual({
      name: "Renamed",
    });
  });

  it("a rename of a multi-channel reply rule does not re-send its filters", () => {
    // Reply-created rules store `in` channel filters with aligned display
    // labels. The form round-trips them through the filter rows; a rename
    // must not rewrite the filters (which would also re-run the collision
    // gate) or drop the labels.
    const s = sub({
      eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "in", value: ["C1", "C2"], labels: ["#general", "#ops"] }],
    });
    expect(buildSubscriptionPatch(s, { ...unchangedForm(s), name: "Renamed" })).toEqual({
      name: "Renamed",
    });
  });

  it("an event-key change sends the full key list", () => {
    const s = sub();
    const patch = buildSubscriptionPatch(s, {
      ...unchangedForm(s),
      eventKeys: ["github.pr.opened", "github.pr.merged"],
    });
    expect(patch).toEqual({ eventKeys: ["github.pr.opened", "github.pr.merged"] });
  });

  it("the same key set in a different order is not a change", () => {
    const s = sub({ eventKeys: ["github.pr.opened", "github.pr.merged"] });
    const patch = buildSubscriptionPatch(s, {
      ...unchangedForm(s),
      eventKeys: ["github.pr.merged", "github.pr.opened"],
    });
    expect(patch).toBeNull();
  });

  it("a filter change sends the filters", () => {
    const s = sub();
    const patch = buildSubscriptionPatch(s, { ...unchangedForm(s), filters: [CHANNEL_EQ] });
    expect(patch).toEqual({ filters: [CHANNEL_EQ] });
  });

  it("an Any-channel toggle alone rides the unchanged filters, with the flag", () => {
    const s = sub({ eventKeys: ["slack.app_mention"], filters: [CHANNEL_EQ] });
    const patch = buildSubscriptionPatch(s, { ...unchangedForm(s), anyChannel: true });
    expect(patch).toEqual({ filters: [CHANNEL_EQ], anyChannel: true });
  });

  it("a mention match change with Any channel set carries the flag", () => {
    const s = sub({ eventKeys: ["slack.app_mention"] });
    const patch = buildSubscriptionPatch(s, {
      ...unchangedForm(s),
      filters: [{ field: "user", op: "eq", value: "U1" }],
      anyChannel: true,
    });
    expect(patch).toEqual({
      filters: [{ field: "user", op: "eq", value: "U1" }],
      anyChannel: true,
    });
  });

  it("never sends the flag for a non-mention rule", () => {
    const s = sub();
    const patch = buildSubscriptionPatch(s, {
      ...unchangedForm(s),
      filters: [CHANNEL_EQ],
      anyChannel: true,
    });
    expect(patch).toEqual({ filters: [CHANNEL_EQ] });
  });
});
