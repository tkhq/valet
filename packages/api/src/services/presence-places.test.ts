import { describe, expect, it } from "vitest";
import { listenerPlaces, parentPlace, placeCovers, placeLabel, placeOfSubject, placeScopeLabel } from "./presence-places.js";

describe("placeOfSubject", () => {
  it("maps a subject to the place it belongs to", () => {
    expect(placeOfSubject("slack:T1/C900/1700.1")).toBe("slack:T1/C900");
    expect(placeOfSubject("slack:T1/C900")).toBe("slack:T1/C900");
    expect(placeOfSubject("slack:T1")).toBe("slack:T1");
    expect(placeOfSubject("github:acme/api#12")).toBe("github:acme/api#12");
    expect(placeOfSubject("github:acme/api@abc123")).toBe("github:acme/api");
    expect(placeOfSubject("github:acme/api")).toBe("github:acme/api");
    expect(placeOfSubject("linear:ENG-42")).toBe("linear:ENG-42");
    expect(placeOfSubject("linear:team/ENG")).toBe("linear:team/ENG");
  });

  it("names no place for an owner, another service, or a malformed subject", () => {
    expect(placeOfSubject("github:acme")).toBeNull();
    expect(placeOfSubject("telegram:123")).toBeNull();
    expect(placeOfSubject("slack:")).toBeNull();
  });
});

describe("parentPlace", () => {
  it("follows the subject grammar", () => {
    expect(parentPlace("slack:T1/C900")).toBe("slack:T1");
    expect(parentPlace("github:acme/api#12")).toBe("github:acme/api");
    expect(parentPlace("linear:ENG-42")).toBe("linear:team/ENG");
    expect(parentPlace("slack:T1")).toBeNull();
    expect(parentPlace("github:acme/api")).toBeNull();
    expect(parentPlace("linear:team/ENG")).toBeNull();
    expect(parentPlace("github:*")).toBeNull();
  });
});

describe("listenerPlaces", () => {
  const rule = (eventKeys: string[], filters: unknown[]) => ({ eventKeys, filters });

  it("places a listener that names one channel at that channel", () => {
    expect(listenerPlaces(rule(["slack.app_mention"], [{ field: "channel", op: "eq", value: "C900" }]), "T1"))
      .toEqual(["slack:T1/C900"]);
  });

  it("places a listener that names two channels, or none, under the Slack workspace", () => {
    expect(listenerPlaces(rule(["slack.app_mention"], [{ field: "channel", op: "in", value: ["C900", "C901"] }]), "T1"))
      .toEqual(["slack:T1"]);
    expect(listenerPlaces(rule(["slack.app_mention"], []), "T1")).toEqual(["slack:T1"]);
    // A prefix filter reaches channels no id list names.
    expect(listenerPlaces(rule(["slack.message"], [{ field: "channel", op: "prefix", value: "C9" }]), "T1")).toEqual(["slack:T1"]);
  });

  it("places a repository-wide GitHub listener at the repository, and a pull request listener at the pull request", () => {
    expect(listenerPlaces(rule(["github.pull_request.*"], [{ field: "repo", op: "eq", value: "Acme/API" }]), "T1"))
      .toEqual(["github:acme/api"]);
    expect(listenerPlaces(rule(["github.pull_request.*"], [
      { field: "repo", op: "eq", value: "acme/api" }, { field: "pr_number", op: "eq", value: 12 },
    ]), "T1")).toEqual(["github:acme/api#12"]);
    expect(listenerPlaces(rule(["github.check_run.completed"], [{ field: "subject", op: "eq", value: "github:acme/api#13" }]), "T1"))
      .toEqual(["github:acme/api#13"]);
  });

  it("places a listener over two repositories, or none, under all of GitHub", () => {
    expect(listenerPlaces(rule(["github.push"], [{ field: "repo", op: "in", value: ["acme/api", "acme/web"] }]), "T1"))
      .toEqual(["github:*"]);
    expect(listenerPlaces(rule(["github.push"], []), "T1")).toEqual(["github:*"]);
  });

  it("places Linear listeners at a team or an issue, and two issues of one team at the team", () => {
    expect(listenerPlaces(rule(["linear.Issue.*"], [{ field: "team", op: "eq", value: "ENG" }]), "T1")).toEqual(["linear:team/ENG"]);
    expect(listenerPlaces(rule(["linear.Issue.update"], [{ field: "identifier", op: "eq", value: "ENG-42" }]), "T1")).toEqual(["linear:ENG-42"]);
    expect(listenerPlaces(rule(["linear.Issue.update"], [{ field: "identifier", op: "in", value: ["ENG-1", "ENG-2"] }]), "T1"))
      .toEqual(["linear:team/ENG"]);
    expect(listenerPlaces(rule(["linear.Issue.*"], []), "T1")).toEqual(["linear:*"]);
  });

  it("gives one place for each service a listener's keys name, and none for other services", () => {
    expect(listenerPlaces(rule(["slack.app_mention", "github.issue_comment.created"], []), "T1")).toEqual(["slack:T1", "github:*"]);
    expect(listenerPlaces(rule(["telegram.message"], []), "T1")).toEqual([]);
  });
});

describe("placeLabel", () => {
  it("names the concrete place", () => {
    expect(placeLabel("slack:T1/C900", new Map([["C900", "incidents"]]))).toBe("#incidents");
    expect(placeLabel("slack:T1/C900", new Map())).toBe("C900");
    expect(placeLabel("slack:T1", new Map())).toBe("Slack");
    expect(placeLabel("github:acme/api#12", new Map())).toBe("acme/api#12");
    expect(placeLabel("github:acme/api", new Map())).toBe("acme/api");
    expect(placeLabel("github:*", new Map())).toBe("GitHub");
    expect(placeLabel("linear:ENG-42", new Map())).toBe("ENG-42");
    expect(placeLabel("linear:team/ENG", new Map())).toBe("ENG");
    expect(placeLabel("linear:*", new Map())).toBe("Linear");
  });
});

describe("placeScopeLabel", () => {
  it("names a parent row's reach, and nothing for any other row", () => {
    expect(placeScopeLabel("slack:T1")).toBe("Everywhere in Slack");
    expect(placeScopeLabel("github:acme/api")).toBe("Across acme/api");
    expect(placeScopeLabel("github:*")).toBe("Everywhere in GitHub");
    expect(placeScopeLabel("linear:team/ENG")).toBe("Across ENG");
    expect(placeScopeLabel("linear:*")).toBe("Everywhere in Linear");
    expect(placeScopeLabel("slack:T1/C900")).toBeUndefined();
    expect(placeScopeLabel("github:acme/api#12")).toBeUndefined();
    expect(placeScopeLabel("linear:ENG-42")).toBeUndefined();
  });
});

describe("placeCovers", () => {
  it("covers the place itself, its children, and everything in the service for a top row", () => {
    expect(placeCovers("github:acme/api", "github:acme/api#12")).toBe(true);
    expect(placeCovers("github:acme/api#12", "github:acme/api#12")).toBe(true);
    expect(placeCovers("github:acme/api#12", "github:acme/api#13")).toBe(false);
    expect(placeCovers("github:*", "github:acme/web#1")).toBe(true);
    expect(placeCovers("linear:*", "linear:ENG-1")).toBe(true);
    expect(placeCovers("linear:team/ENG", "linear:ENG-1")).toBe(true);
    expect(placeCovers("slack:T1", "slack:T1/C900")).toBe(true);
    expect(placeCovers("slack:T1/C900", "slack:T1/C901")).toBe(false);
    expect(placeCovers("github:*", "slack:T1/C900")).toBe(false);
  });
});
