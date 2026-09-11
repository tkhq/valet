import { describe, expect, it } from "vitest";
import { readTeamClaim } from "./team-sync.js";

describe("readTeamClaim", () => {
  it("reads an array of paths as present", () => {
    expect(readTeamClaim({ groups: ["/platform", "/research"] }, "groups", "groups_asserted")).toEqual({
      present: true,
      paths: ["/platform", "/research"],
    });
  });

  it("reads an empty array as present and authoritative", () => {
    expect(readTeamClaim({ groups: [] }, "groups", "groups_asserted")).toEqual({
      present: true,
      paths: [],
    });
  });

  it("drops a blank entry, which names no group", () => {
    const claim = readTeamClaim({ groups: ["/platform", "", "  "] }, "groups", "groups_asserted");
    expect(claim).toEqual({ present: true, paths: ["/platform"] });
  });

  it("reports NO information when any entry is not a string", () => {
    expect(readTeamClaim({ groups: [{ name: "/platform" }] }, "groups", "groups_asserted")).toEqual({
      present: false,
    });
    expect(readTeamClaim({ groups: ["/platform", 7] }, "groups", "groups_asserted")).toEqual({
      present: false,
    });
    expect(readTeamClaim({ groups: ["/platform", null] }, "groups", "groups_asserted")).toEqual({
      present: false,
    });
  });

  it("reports NO information when the list names no group at all", () => {
    expect(readTeamClaim({ groups: ["", "  "] }, "groups", "groups_asserted")).toEqual({
      present: false,
    });
    expect(
      readTeamClaim({ groups: [""], groups_asserted: "true" }, "groups", "groups_asserted"),
    ).toEqual({ present: false });
  });

  it("reports NO information for an unreadable list even when the marker is present", () => {
    expect(
      readTeamClaim({ groups: [{ name: "/platform" }], groups_asserted: "true" }, "groups", "groups_asserted"),
    ).toEqual({ present: false });
  });

  it("reports NO information when both the claim and the marker are missing", () => {
    expect(readTeamClaim({ email: "a@x.test" }, "groups", "groups_asserted")).toEqual({ present: false });
  });

  it("reports NO information when the claim is null and the marker is missing", () => {
    expect(readTeamClaim({ groups: null }, "groups", "groups_asserted")).toEqual({ present: false });
  });

  it("reads a missing claim as 'no groups' only when the marker is present", () => {
    expect(readTeamClaim({ groups_asserted: "true" }, "groups", "groups_asserted")).toEqual({
      present: true,
      paths: [],
    });
  });

  it("reads the marker as an own property, never an inherited one", () => {
    expect(readTeamClaim({ email: "a@x.test" }, "groups", "constructor")).toEqual({ present: false });
    expect(readTeamClaim({ email: "a@x.test" }, "groups", "toString")).toEqual({ present: false });
    expect(readTeamClaim({ constructor: "true" }, "groups", "constructor")).toEqual({
      present: true,
      paths: [],
    });
  });

  it("reports NO information for a single-valued claim, marker or not", () => {
    expect(readTeamClaim({ groups: "/platform" }, "groups", "groups_asserted")).toEqual({ present: false });
    expect(
      readTeamClaim({ groups: "/platform", groups_asserted: "true" }, "groups", "groups_asserted"),
    ).toEqual({ present: false });
    expect(readTeamClaim({ groups: { platform: true } }, "groups", "groups_asserted")).toEqual({
      present: false,
    });
  });

  it("honours configured claim names", () => {
    expect(readTeamClaim({ valet_teams: ["/platform"] }, "valet_teams", "valet_teams_sent")).toEqual({
      present: true,
      paths: ["/platform"],
    });
  });
});
