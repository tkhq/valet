import { describe, expect, it } from "vitest";
import { eventKeyMatches, filtersMatch, resolvePath, subscriptionMatchesEvent, validateRegexPattern } from "./match.js";
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

  it("regex is compiled once and reused across events (cache)", () => {
    // Two matches with the same pattern exercise the compiled-regex cache; both
    // must behave identically.
    const f = [{ field: "repo", op: "regex" as const, value: "^tkhq/" }];
    expect(filtersMatch(payload, "github.pull_request.opened", f, CATALOG)).toBe(true);
    expect(filtersMatch({ repository: { full_name: "other/x" }, sender: { login: "z" } }, "github.pull_request.opened", f, CATALOG)).toBe(false);
  });

  it("unknown field never matches", () => {
    expect(filtersMatch(payload, "github.pull_request.opened", [{ field: "nope", op: "eq", value: "x" }], CATALOG)).toBe(false);
  });
  it("validateRegexPattern accepts a normal pattern, rejects long/invalid/nested-quantifier", () => {
    expect(validateRegexPattern("^tkhq/.*$")).toBeNull();
    expect(validateRegexPattern("(a|b|c)+")).toBeNull(); // alternation, not nested quantifier
    expect(validateRegexPattern("x".repeat(201))).toContain("too long");
    expect(validateRegexPattern("(")).toContain("invalid");
    expect(validateRegexPattern("(a+)+")).toContain("nests");
    expect(validateRegexPattern("(.*)*")).toContain("nests");
  });

  it("empty filter list always matches", () => {
    expect(filtersMatch(payload, "github.pull_request.opened", [], CATALOG)).toBe(true);
  });
});

describe("catalog-driven pinning arm", () => {
  const catalog: EventCatalogEntry[] = [
    {
      key: "svc.pinned",
      description: "a creator-pinned key",
      filters: [{ field: "user", path: "user", description: "sender" }],
      scope: { channelField: "channel", creatorUserField: "user" },
    },
    {
      key: "svc.open",
      description: "a channel-scoped but unpinned key",
      filters: [{ field: "channel", path: "channel", description: "room" }],
      scope: { channelField: "channel" },
    },
  ];

  it("fails closed on a pinned key with no filter on the pinned field", () => {
    const sub = { eventKeys: ["svc.pinned"], filters: [] };
    expect(subscriptionMatchesEvent(sub, "svc.pinned", { user: "U1" }, catalog)).toBe(false);
  });

  it("matches a pinned key when the pinned-field filter is present", () => {
    const sub = { eventKeys: ["svc.pinned"], filters: [{ field: "user", op: "eq", value: "U1" }] };
    expect(subscriptionMatchesEvent(sub, "svc.pinned", { user: "U1" }, catalog)).toBe(true);
  });

  it("does not fail closed on a channel-scoped, unpinned key with no filters", () => {
    const sub = { eventKeys: ["svc.open"], filters: [] };
    expect(subscriptionMatchesEvent(sub, "svc.open", { channel: "C1" }, catalog)).toBe(true);
  });
});
