/**
 * Pure checks for incident mention routing's waiter selection (spec
 * 2026-10-15: incident mention routing, Terminology and Part A step 4).
 * The dispatcher suite covers the full routing path over real rows.
 */
import { describe, expect, it } from "vitest";
import type { EventMatchSpec } from "@valet/engine";
import { slackEventTeam, watchesEveryChannelMessage } from "./watching-waiter.js";

const CHANNEL = "slack:T001/C1";

function spec(over: Partial<EventMatchSpec> = {}): EventMatchSpec {
  return { clauses: [{ key: "slack.message", bots: false }], once: false, self: [], ...over };
}

describe("watchesEveryChannelMessage", () => {
  it("accepts an open slack.message clause", () => {
    expect(watchesEveryChannelMessage(spec(), CHANNEL)).toBe(true);
  });

  it("accepts a wildcard key that matches slack.message", () => {
    expect(watchesEveryChannelMessage(spec({ clauses: [{ key: "slack.*" }] }), CHANNEL)).toBe(true);
  });

  it("rejects a waiter with no slack.message clause", () => {
    expect(watchesEveryChannelMessage(spec({ clauses: [{ key: "slack.reaction_added" }] }), CHANNEL)).toBe(false);
  });

  it("rejects a clause restricted to one sender", () => {
    expect(watchesEveryChannelMessage(spec({ clauses: [{ key: "slack.message", actor: "U7" }] }), CHANNEL)).toBe(false);
  });

  it("rejects a clause with a status or previous-status filter", () => {
    expect(watchesEveryChannelMessage(spec({ clauses: [{ key: "slack.message", status: ["open"] }] }), CHANNEL)).toBe(false);
    expect(watchesEveryChannelMessage(spec({ clauses: [{ key: "slack.message", from_status: ["open"] }] }), CHANNEL)).toBe(false);
  });

  it("accepts a waiter when one open clause sits beside a narrow one", () => {
    const clauses = [{ key: "slack.message", actor: "U7" }, { key: "slack.message" }];
    expect(watchesEveryChannelMessage(spec({ clauses }), CHANNEL)).toBe(true);
  });

  it("rejects a primary subject other than the channel", () => {
    expect(watchesEveryChannelMessage(spec({ primarySubject: "slack:T001/C1/9.9" }), CHANNEL)).toBe(false);
    expect(watchesEveryChannelMessage(spec({ primarySubject: CHANNEL }), CHANNEL)).toBe(true);
  });
});

describe("slackEventTeam", () => {
  it("prefers the channel subject, then the payload team", () => {
    expect(slackEventTeam(["slack:T001/C1"], { team: "T999" }, "C1")).toBe("T001");
    expect(slackEventTeam([], { team: "T999" }, "C1")).toBe("T999");
    expect(slackEventTeam(null, "not an object", "C1")).toBeUndefined();
  });
});
