/**
 * The place helpers the Presence rail reads (spec Part B): the mid grain,
 * the service-wide row, and the places a line of presence names.
 */
import type { EventSubscriptionFilterWire, PresencePlaceWire } from "@valet/api/wire";
import { describe, expect, it } from "vitest";
import { isMidGrain, isServiceRoot, placeSearchTerm, placeSubjectsForRule } from "./places";

function place(subject: string, label: string, service: PresencePlaceWire["service"], parent: string | null = null): PresencePlaceWire {
  return { subject, label, service, parent, listenerCount: 1, activeThreadCount: 0, lastActivityAt: null };
}

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

describe("placeSubjectsForRule", () => {
  const places = [
    place("slack:T1", "Slack", "slack"),
    place("slack:T1/C900", "#incidents", "slack", "slack:T1"),
    place("slack:T1/C901", "#deploys", "slack", "slack:T1"),
    place("github:acme/api", "acme/api", "github"),
    place("github:acme/api#12", "acme/api#12", "github", "github:acme/api"),
    place("linear:team/ENG", "ENG", "linear"),
  ];
  const rule = (filters: EventSubscriptionFilterWire[]) => ({ filters });

  it("maps a channel filter by channel id", () => {
    expect(placeSubjectsForRule(rule([{ field: "channel", op: "eq", value: "C900", label: "#incidents" }]), places)).toEqual(["slack:T1/C900"]);
  });

  it("maps every channel of an in filter", () => {
    expect(placeSubjectsForRule(rule([{ field: "channel", op: "in", value: ["C900", "C901"] }]), places)).toEqual(["slack:T1/C900", "slack:T1/C901"]);
  });

  it("maps a repository filter case-insensitively, and not to its pull requests", () => {
    expect(placeSubjectsForRule(rule([{ field: "repo", op: "eq", value: "Acme/API" }]), places)).toEqual(["github:acme/api"]);
  });

  it("maps a team filter", () => {
    expect(placeSubjectsForRule(rule([{ field: "team", op: "eq", value: "ENG" }]), places)).toEqual(["linear:team/ENG"]);
  });

  it("maps no place for a broad filter or for no filter", () => {
    expect(placeSubjectsForRule(rule([{ field: "channel", op: "prefix", value: "C9" }]), places)).toEqual([]);
    expect(placeSubjectsForRule(rule([]), places)).toEqual([]);
    expect(placeSubjectsForRule(rule([{ field: "repo", op: "eq", value: "acme/web" }]), places)).toEqual([]);
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
