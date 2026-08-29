import { describe, expect, it } from "vitest";
import { eventKeyMatches, filtersMatch, resolvePath } from "./match.js";
import type { EventCatalogEntry } from "@valet/engine";

const CATALOG: EventCatalogEntry[] = [
  {
    key: "github.pull_request.opened",
    description: "",
    filters: [
      { field: "repo", path: "repository.full_name", description: "" },
      { field: "sender", path: "sender.login", description: "" },
    ],
  },
];

describe("eventKeyMatches", () => {
  it("matches exact keys", () => {
    expect(eventKeyMatches("github.pull_request.opened", ["github.pull_request.opened"])).toBe(true);
  });
  it("matches trailing wildcards", () => {
    expect(eventKeyMatches("github.pull_request.opened", ["github.pull_request.*"])).toBe(true);
    expect(eventKeyMatches("github.pull_request.opened", ["github.*"])).toBe(true);
  });
  it("rejects non-matches and non-boundary wildcard prefixes", () => {
    expect(eventKeyMatches("github.push", ["github.pull_request.*"])).toBe(false);
    expect(eventKeyMatches("github.pull_request_review.opened", ["github.pull_request.*"])).toBe(false);
  });
});

describe("resolvePath", () => {
  it("walks dot paths", () => {
    expect(resolvePath({ repository: { full_name: "a/b" } }, "repository.full_name")).toBe("a/b");
  });
  it("returns undefined for missing segments", () => {
    expect(resolvePath({ repository: {} }, "repository.full_name")).toBeUndefined();
  });
});

describe("filtersMatch", () => {
  const payload = { repository: { full_name: "tkhq/valet" }, sender: { login: "conner" } };
  it("eq", () => {
    expect(filtersMatch(payload, "github.pull_request.opened", [{ field: "repo", op: "eq", value: "tkhq/valet" }], CATALOG)).toBe(true);
    expect(filtersMatch(payload, "github.pull_request.opened", [{ field: "repo", op: "eq", value: "other/x" }], CATALOG)).toBe(false);
  });
  it("in", () => {
    expect(filtersMatch(payload, "github.pull_request.opened", [{ field: "repo", op: "in", value: ["a/b", "tkhq/valet"] }], CATALOG)).toBe(true);
  });
  it("prefix and contains", () => {
    expect(filtersMatch(payload, "github.pull_request.opened", [{ field: "repo", op: "prefix", value: "tkhq/" }], CATALOG)).toBe(true);
    expect(filtersMatch(payload, "github.pull_request.opened", [{ field: "sender", op: "contains", value: "onne" }], CATALOG)).toBe(true);
  });
  it("regex matches and fails closed on a bad pattern", () => {
    expect(filtersMatch(payload, "github.pull_request.opened", [{ field: "repo", op: "regex", value: "^tkhq/.*$" }], CATALOG)).toBe(true);
    expect(filtersMatch(payload, "github.pull_request.opened", [{ field: "repo", op: "regex", value: "^other/" }], CATALOG)).toBe(false);
    // An invalid pattern must return false, never throw.
    expect(filtersMatch(payload, "github.pull_request.opened", [{ field: "repo", op: "regex", value: "(" }], CATALOG)).toBe(false);
  });

  it("unknown field never matches", () => {
    expect(filtersMatch(payload, "github.pull_request.opened", [{ field: "nope", op: "eq", value: "x" }], CATALOG)).toBe(false);
  });
  it("empty filter list always matches", () => {
    expect(filtersMatch(payload, "github.pull_request.opened", [], CATALOG)).toBe(true);
  });
});
