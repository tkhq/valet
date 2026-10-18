/**
 * The place helpers the Presence overview and pages read (spec Part B): the mid grain,
 * the service-wide row, and the places a line of presence names.
 */
import type { EventSubscriptionFilterWire, PresencePlaceWire } from "@valet/api/wire";
import { describe, expect, it } from "vitest";
import { isMidGrain, isServiceRoot, placeSearchTerm } from "./places";
import { place } from "./test-fixtures";


describe("isMidGrain", () => {
  it.each(["slack:T1/C900", "github:acme/api", "linear:team/ENG"])("reads %s as the mid grain", (subject) => {
    expect(isMidGrain({ subject })).toBe(true);
  });

  it.each(["slack:T1", "slack:T1/C900/1700000000.1", "github:*", "github:acme/api#12", "github:acme/api@abc123", "linear:*", "linear:ENG-42"])(
    "reads %s as not the mid grain",
    (subject) => {
      expect(isMidGrain({ subject })).toBe(false);
    },
  );
});

describe("isServiceRoot", () => {
  it("reads the Slack workspace, github:*, and linear:* as service-wide", () => {
    expect(isServiceRoot({ subject: "slack:T1", parent: null })).toBe(true);
    expect(isServiceRoot({ subject: "github:*", parent: null })).toBe(true);
    expect(isServiceRoot({ subject: "linear:*", parent: null })).toBe(true);
    expect(isServiceRoot({ subject: "slack:T1/C900", parent: "slack:T1" })).toBe(false);
  });
});


describe("placeSearchTerm", () => {
  it("searches a Slack channel by its channel id, which the event summary carries", () => {
    expect(placeSearchTerm(place("slack:T1/C900", "#incidents", "slack"))).toBe("C900");
  });

  it("searches a Slack thread by its channel id", () => {
    expect(placeSearchTerm(place("slack:T1/C900/1700000000.1", "Thread", "slack"))).toBe("C900");
  });

  it("searches the Slack workspace, a repository, and a Linear team by label", () => {
    expect(placeSearchTerm(place("slack:T1", "Slack", "slack"))).toBe("Slack");
    expect(placeSearchTerm(place("github:acme/api", "acme/api", "github"))).toBe("acme/api");
    expect(placeSearchTerm(place("linear:team/ENG", "ENG", "linear"))).toBe("ENG");
  });
});
