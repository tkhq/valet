/**
 * The place helpers the Presence overview and pages read (spec Part B): the mid grain,
 * the service-wide row, and the places a line of presence names.
 */
import { describe, expect, it } from "vitest";
import { isMidGrain, isServiceRoot, SERVICE_NAMES } from "./places";
import { SERVICE_NAMES as MARK_SERVICE_NAMES } from "./service-mark";

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

describe("SERVICE_NAMES", () => {
  it("is the one table the service marks use", () => {
    expect(SERVICE_NAMES).toBe(MARK_SERVICE_NAMES);
  });
});
