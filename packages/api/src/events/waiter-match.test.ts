import { describe, expect, it } from "vitest";
import type { DerivedEventDef, EventMatchSpec, NormalizedEvent } from "@valet/engine";
import { derivedClausesAccept, keyMatches, matchClauses, needsPreviousStatus, toDigest } from "./waiter-match.js";

const SELF_ID = "U-SELF";
const OTHER_ID = "U-OTHER";

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    key: "github.check_run.completed",
    dedupeKey: "dk-1",
    occurredAt: "2026-10-15T00:00:00.000Z",
    refs: {},
    summary: "a check run completed",
    payload: {},
    ...overrides,
  };
}

function spec(clauses: EventMatchSpec["clauses"], self: string[] = []): EventMatchSpec {
  return { clauses, once: true, self };
}

const CHECKS_COMPLETED: DerivedEventDef = {
  key: "github.pull_request.checks_completed",
  description: "all checks settled",
  sources: ["github.check_run.*", "github.check_suite.*", "github.workflow_run.*", "github.status"],
  derive: async () => null,
};

describe("keyMatches", () => {
  it("matches an exact key", () => {
    expect(keyMatches("github.check_run.completed", "github.check_run.completed")).toBe(true);
  });
  it("matches a trailing-wildcard pattern", () => {
    expect(keyMatches("github.check_run.*", "github.check_run.completed")).toBe(true);
  });
  it("rejects a non-matching key", () => {
    expect(keyMatches("github.check_run.*", "github.check_suite.completed")).toBe(false);
  });
});

describe("matchClauses — E1 vectors", () => {
  it("E1 row 1: a trailing-wildcard key matches the event", () => {
    const result = matchClauses(
      spec([{ key: "github.check_run.*" }]),
      event({ key: "github.check_run.completed" }),
      [],
    );
    expect(result).toEqual({ direct: true, derive: [] });
  });

  it("E1 row 2: a status clause excludes a non-matching status", () => {
    const result = matchClauses(
      spec([{ key: "github.check_run.completed", status: ["failure"] }]),
      event({ key: "github.check_run.completed", status: "success" }),
      [],
    );
    expect(result).toEqual({ direct: false, derive: [] });
  });

  it("E1 row 3: bots:false excludes a bot actor", () => {
    const result = matchClauses(
      spec([{ key: "slack.message", bots: false }]),
      event({ key: "slack.message", actor: { externalId: "U-BOT", bot: true } }),
      [],
    );
    expect(result).toEqual({ direct: false, derive: [] });
  });

  it("E1 row 4: an actor in self is dropped with no include_self", () => {
    const result = matchClauses(
      spec([{ key: "slack.message" }], [SELF_ID]),
      event({ key: "slack.message", actor: { externalId: SELF_ID } }),
      [],
    );
    expect(result).toEqual({ direct: false, derive: [] });
  });

  it("E1 row 5: include_self:true keeps an actor in self", () => {
    const result = matchClauses(
      spec([{ key: "slack.message", include_self: true }], [SELF_ID]),
      event({ key: "slack.message", actor: { externalId: SELF_ID } }),
      [],
    );
    expect(result).toEqual({ direct: true, derive: [] });
  });

  it("E1 row 6: from_status with no previousStatus (title-only update) is no match", () => {
    const result = matchClauses(
      spec([{ key: "linear.issue.update", status: ["triage"], from_status: ["backlog"] }]),
      event({ key: "linear.issue.update", status: "triage", previousStatus: undefined }),
      [],
    );
    expect(result).toEqual({ direct: false, derive: [] });
  });

  it("E1 row 7: a derived key matches through its sources and marks derive", () => {
    const result = matchClauses(
      spec([{ key: "github.pull_request.checks_completed" }]),
      event({ key: "github.check_run.completed" }),
      [CHECKS_COMPLETED],
    );
    expect(result).toEqual({ direct: false, derive: ["github.pull_request.checks_completed"] });
  });

  // E1 row 8 ("any clause | event org differs from session org | no match") is
  // enforced by the caller (spec Part E, step 2: findEventWaiters candidates
  // are kept only when the session's org equals the event's org), before
  // matchClauses ever sees the event. matchClauses has no org to compare.
});

describe("matchClauses — additional vectors", () => {
  it("a status clause with no event status is no match", () => {
    const result = matchClauses(
      spec([{ key: "github.check_run.completed", status: ["failure"] }]),
      event({ key: "github.check_run.completed", status: undefined }),
      [],
    );
    expect(result).toEqual({ direct: false, derive: [] });
  });

  it("actor matches by login", () => {
    const result = matchClauses(
      spec([{ key: "slack.message", actor: "conner" }]),
      event({ key: "slack.message", actor: { externalId: "U-1", login: "conner" } }),
      [],
    );
    expect(result).toEqual({ direct: true, derive: [] });
  });

  it("actor matches by external id", () => {
    const result = matchClauses(
      spec([{ key: "slack.message", actor: "U-1" }]),
      event({ key: "slack.message", actor: { externalId: "U-1" } }),
      [],
    );
    expect(result).toEqual({ direct: true, derive: [] });
  });

  it("actor clause excludes a non-matching actor", () => {
    const result = matchClauses(
      spec([{ key: "slack.message", actor: "conner" }]),
      event({ key: "slack.message", actor: { externalId: "U-1", login: "someone-else" } }),
      [],
    );
    expect(result).toEqual({ direct: false, derive: [] });
  });

  it("include_self absent with an actor outside self matches", () => {
    const result = matchClauses(
      spec([{ key: "slack.message" }], [SELF_ID]),
      event({ key: "slack.message", actor: { externalId: OTHER_ID } }),
      [],
    );
    expect(result).toEqual({ direct: true, derive: [] });
  });

  it("a non-matching key and no derived def is no match", () => {
    const result = matchClauses(
      spec([{ key: "github.pull_request.opened" }]),
      event({ key: "github.check_run.completed" }),
      [],
    );
    expect(result).toEqual({ direct: false, derive: [] });
  });
});

describe("matchClauses — derived clauses (final review, items 1 to 3)", () => {
  const CHECKS = "github.pull_request.checks_completed";
  const PR = "github:acme/lean-proofs#42";
  const REPO = "github:acme/lean-proofs";

  it("E1: a derived clause's status filter does not apply to the source event", () => {
    const result = matchClauses(
      spec([{ key: CHECKS, status: ["success"] }]),
      event({ key: "github.check_run.completed", status: "failure" }),
      [CHECKS_COMPLETED],
    );
    expect(result).toEqual({ direct: false, derive: [CHECKS] });
  });

  it("E1: bots:false on a derived clause does not drop a github-actions[bot] source", () => {
    const result = matchClauses(
      spec([{ key: CHECKS, bots: false }]),
      event({ key: "github.check_run.completed", actor: { externalId: "41898282", login: "github-actions[bot]", bot: true } }),
      [CHECKS_COMPLETED],
    );
    expect(result).toEqual({ direct: false, derive: [CHECKS] });
  });

  it("a derived clause ignores self, actor, and from_status on the source", () => {
    const result = matchClauses(
      spec([{ key: CHECKS, actor: "nobody", from_status: ["queued"] }], ["9001"]),
      event({ key: "github.check_run.completed", actor: { externalId: "9001" } }),
      [CHECKS_COMPLETED],
    );
    expect(result).toEqual({ direct: false, derive: [CHECKS] });
  });

  it("a direct and a derived clause both match one mid-run failure", () => {
    const result = matchClauses(
      spec([{ key: CHECKS }, { key: "github.check_run.completed", status: ["failure"] }]),
      event({ key: "github.check_run.completed", status: "failure", subjects: [REPO, PR] }),
      [CHECKS_COMPLETED],
    );
    expect(result).toEqual({ direct: true, derive: [CHECKS] });
  });

  it("with a primarySubject, a direct clause needs it on the event", () => {
    const withPrimary: EventMatchSpec = { ...spec([{ key: "github.check_run.completed" }, { key: CHECKS }]), primarySubject: PR };
    const otherPr = event({ key: "github.check_run.completed", status: "failure", subjects: [REPO, "github:acme/lean-proofs#7"] });
    expect(matchClauses(withPrimary, otherPr, [CHECKS_COMPLETED])).toEqual({ direct: false, derive: [CHECKS] });
    const ownPr = event({ key: "github.check_run.completed", status: "failure", subjects: [REPO, PR] });
    expect(matchClauses(withPrimary, ownPr, [CHECKS_COMPLETED])).toEqual({ direct: true, derive: [CHECKS] });
  });

  it("with a primarySubject, a derived clause matches a commit status through the repository subject", () => {
    const withPrimary: EventMatchSpec = { ...spec([{ key: CHECKS }]), primarySubject: PR };
    const status = event({ key: "github.status", status: "success", subjects: ["github:acme", REPO, `${REPO}@aaaa`] });
    expect(matchClauses(withPrimary, status, [CHECKS_COMPLETED])).toEqual({ direct: false, derive: [CHECKS] });
  });

  it("derivedClausesAccept checks status and from_status on the derived event", () => {
    const derived = { key: CHECKS, status: "failure", subjects: [PR], summary: "s", occurredAt: "t", dedupeKey: "k" };
    expect(derivedClausesAccept(spec([{ key: CHECKS, status: ["success"] }]), CHECKS, derived)).toBe(false);
    expect(derivedClausesAccept(spec([{ key: CHECKS, status: ["failure"] }]), CHECKS, derived)).toBe(true);
    expect(derivedClausesAccept(spec([{ key: CHECKS, status: ["success"] }, { key: CHECKS }]), CHECKS, derived)).toBe(true);
    expect(derivedClausesAccept(spec([{ key: CHECKS, from_status: ["success"] }]), CHECKS, derived)).toBe(false);
    expect(derivedClausesAccept(spec([{ key: "github.check_run.completed" }]), CHECKS, derived)).toBe(false);
  });

  it("toDigest gives a derive digest its own dedupe key", () => {
    expect(toDigest(event({ dedupeKey: "dk-9" }), CHECKS).dedupeKey).toBe(`derive:${CHECKS}:dk-9`);
    expect(toDigest(event({ dedupeKey: "dk-9" })).dedupeKey).toBe("dk-9");
  });
});

describe("needsPreviousStatus", () => {
  it("is true when a clause names from_status", () => {
    expect(needsPreviousStatus(spec([{ key: "linear.issue.update", from_status: ["backlog"] }]))).toBe(
      true,
    );
  });
  it("is false when no clause names from_status", () => {
    expect(needsPreviousStatus(spec([{ key: "linear.issue.update", status: ["triage"] }]))).toBe(false);
  });
  it("is false when only a derived clause names from_status", () => {
    expect(needsPreviousStatus(spec([{ key: CHECKS_COMPLETED.key, from_status: ["failure"] }]), [CHECKS_COMPLETED])).toBe(false);
  });
});


describe("toDigest", () => {
  it("carries the core NormalizedEvent fields", () => {
    const e = event({
      key: "github.check_run.completed",
      status: "failure",
      previousStatus: "pending",
      subjects: ["github:acme/lean-proofs#42"],
      summary: "check run failed",
      actor: { externalId: "U-1", login: "conner" },
      occurredAt: "2026-10-15T01:02:03.000Z",
      dedupeKey: "dk-42",
    });
    expect(toDigest(e)).toEqual({
      key: "github.check_run.completed",
      status: "failure",
      previousStatus: "pending",
      subjects: ["github:acme/lean-proofs#42"],
      summary: "check run failed",
      actor: "conner",
      occurredAt: "2026-10-15T01:02:03.000Z",
      dedupeKey: "dk-42",
    });
  });

  it("defaults subjects to an empty array when the event carries none", () => {
    const e = event({ subjects: undefined });
    expect(toDigest(e).subjects).toEqual([]);
  });

  it("marks a derived match with the derive key", () => {
    const e = event();
    expect(toDigest(e, "github.pull_request.checks_completed").derive).toBe(
      "github.pull_request.checks_completed",
    );
  });

  it("takes text from a Slack message payload", () => {
    const e = event({ key: "slack.message", payload: { text: "hello there" } });
    expect(toDigest(e).text).toBe("hello there");
  });

  it("takes text from a GitHub comment body", () => {
    const e = event({ key: "github.issue_comment.created", payload: { comment: { body: "nice work" } } });
    expect(toDigest(e).text).toBe("nice work");
  });

  it("takes text from a GitHub review body", () => {
    const e = event({
      key: "github.pull_request_review.submitted",
      payload: { review: { body: "LGTM" } },
    });
    expect(toDigest(e).text).toBe("LGTM");
  });

  it("takes text from a Linear comment body", () => {
    const e = event({ key: "linear.comment.create", payload: { data: { body: "ping" } } });
    expect(toDigest(e).text).toBe("ping");
  });

  it("has no text for an unrecognized payload shape", () => {
    const e = event({ key: "github.check_run.completed", payload: { foo: "bar" } });
    expect(toDigest(e).text).toBeUndefined();
  });

  it("takes the url from a GitHub comment's html_url", () => {
    const e = event({
      key: "github.issue_comment.created",
      payload: { comment: { body: "x", html_url: "https://github.com/acme/repo/issues/1#comment" } },
    });
    expect(toDigest(e).url).toBe("https://github.com/acme/repo/issues/1#comment");
  });

  it("takes the url from a GitHub pull_request's html_url when no comment is present", () => {
    const e = event({
      key: "github.pull_request.opened",
      payload: { pull_request: { html_url: "https://github.com/acme/repo/pull/1" } },
    });
    expect(toDigest(e).url).toBe("https://github.com/acme/repo/pull/1");
  });

  it("takes the url from a GitHub check_run's html_url", () => {
    const e = event({
      key: "github.check_run.completed",
      payload: { check_run: { html_url: "https://github.com/acme/repo/runs/1" } },
    });
    expect(toDigest(e).url).toBe("https://github.com/acme/repo/runs/1");
  });

  it("falls back to a bare payload html_url", () => {
    const e = event({
      key: "github.status",
      payload: { html_url: "https://github.com/acme/repo/commit/abc" },
    });
    expect(toDigest(e).url).toBe("https://github.com/acme/repo/commit/abc");
  });

  it("takes the url from Linear's refs.url", () => {
    const e = event({
      key: "linear.issue.update",
      refs: { url: "https://linear.app/acme/issue/ENG-7" },
      payload: {},
    });
    expect(toDigest(e).url).toBe("https://linear.app/acme/issue/ENG-7");
  });

  it("has no url for an unrecognized payload shape", () => {
    const e = event({ key: "slack.message", payload: { text: "hi" } });
    expect(toDigest(e).url).toBeUndefined();
  });
});
