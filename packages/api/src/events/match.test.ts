import { describe, expect, it } from "vitest";
import {
  eventKeyMatches,
  filtersMatch,
  resolvePath,
  SUBJECT_FILTER_FIELD,
  subscriptionMatchesEvent,
  subscriptionNamesKey,
  validateRegexPattern,
  withSubjectFilter,
} from "./match.js";
import type { EventCatalogEntry } from "@valet/engine";
import slackPlugin from "@valet/plugin-slack/plugin";

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

describe("Slack channel_name filter", () => {
  const catalog = (slackPlugin.triggers ?? []).flatMap((t) => t.catalog);
  // Intake adds `channel_name` to a message payload (`withEventChannelName`).
  const post = (channelName?: string) => ({
    type: "message", channel: "C1", bot_id: "B1", text: "CPU high",
    ...(channelName !== undefined ? { channel_name: channelName } : {}),
  });
  const prefix = [{ field: "channel_name", op: "prefix" as const, value: "alerts-" }];
  const regex = [{ field: "channel_name", op: "regex" as const, value: "^alerts-(prod|preprod)$" }];

  it.each(["slack.message", "slack.bot_message", "slack.app_mention"])("matches %s by name prefix and by regex", (key) => {
    expect(filtersMatch(post("alerts-prod"), key, prefix, catalog)).toBe(true);
    expect(filtersMatch(post("alerts-new-service"), key, prefix, catalog)).toBe(true);
    expect(filtersMatch(post("general"), key, prefix, catalog)).toBe(false);
    expect(filtersMatch(post("alerts-preprod"), key, regex, catalog)).toBe(true);
    expect(filtersMatch(post("alerts-dev"), key, regex, catalog)).toBe(false);
  });

  it("fails closed when intake has no name for the channel", () => {
    expect(filtersMatch(post(), "slack.bot_message", prefix, catalog)).toBe(false);
    expect(filtersMatch(post(), "slack.bot_message", [{ field: "channel_name", op: "regex", value: ".*" }], catalog)).toBe(false);
  });

  it("matches a renamed channel by its new name only", () => {
    // Intake reads the current name for each event, so the stored rule sees the rename.
    expect(filtersMatch(post("alerts-billing"), "slack.bot_message", prefix, catalog)).toBe(true);
    expect(filtersMatch(post("archive-billing"), "slack.bot_message", prefix, catalog)).toBe(false);
  });
});

describe("subject filter (spec 2026-10-15 event wakeups, Part G)", () => {
  const key = "github.check_run.completed";
  // No individual plugin declares `subject`; it is implicit for every key, so
  // the test catalog entry declares no filters at all (`withSubjectFilter` is
  // what the real catalog builders apply).
  const catalog: EventCatalogEntry[] = [{ key, description: "", filters: [] }];
  const pr42 = ["github:acme", "github:acme/lean-proofs", "github:acme/lean-proofs#42"];
  const pr43 = ["github:acme", "github:acme/lean-proofs", "github:acme/lean-proofs#43"];

  it("eq matches when any subject equals the value", () => {
    expect(filtersMatch({}, key, [{ field: "subject", op: "eq", value: "github:acme/lean-proofs#42" }], catalog, pr42)).toBe(true);
    expect(filtersMatch({}, key, [{ field: "subject", op: "eq", value: "github:acme/lean-proofs#42" }], catalog, pr43)).toBe(false);
  });

  it("prefix matches when any subject starts with the value", () => {
    expect(filtersMatch({}, key, [{ field: "subject", op: "prefix", value: "github:acme/lean-proofs" }], catalog, pr42)).toBe(true);
    expect(filtersMatch({}, key, [{ field: "subject", op: "prefix", value: "github:acme/lean-proofs" }], catalog, pr43)).toBe(true);
    expect(filtersMatch({}, key, [{ field: "subject", op: "prefix", value: "github:other/repo" }], catalog, pr42)).toBe(false);
  });

  it("fails closed with no subjects and on ops the spec does not define for subject", () => {
    expect(filtersMatch({}, key, [{ field: "subject", op: "eq", value: "github:acme/lean-proofs#42" }], catalog, undefined)).toBe(false);
    expect(filtersMatch({}, key, [{ field: "subject", op: "eq", value: "github:acme/lean-proofs#42" }], catalog, [])).toBe(false);
    expect(filtersMatch({}, key, [{ field: "subject", op: "contains", value: "lean-proofs" }], catalog, pr42)).toBe(false);
  });

  it("subscriptionMatchesEvent: a key match with a differing subject is a filter miss, not a key miss", () => {
    const sub = { eventKeys: [key], filters: [{ field: "subject", op: "eq" as const, value: "github:acme/lean-proofs#42" }] };
    expect(subscriptionNamesKey(sub, key)).toBe(true);
    expect(subscriptionMatchesEvent(sub, key, {}, catalog, false, pr43)).toBe(false);
    expect(subscriptionMatchesEvent(sub, key, {}, catalog, false, pr42)).toBe(true);
  });

  it("withSubjectFilter adds the implicit field once, idempotently", () => {
    const entry: EventCatalogEntry = { key, description: "", filters: [{ field: "repo", path: "repository.full_name", description: "" }] };
    const withSubject = withSubjectFilter(entry);
    expect(withSubject.filters.map((f) => f.field)).toEqual(["repo", SUBJECT_FILTER_FIELD]);
    expect(withSubjectFilter(withSubject).filters.length).toBe(2);
  });
});
