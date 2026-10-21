import type { NormalizedEvent } from "@valet/engine";
import { describe, expect, it } from "vitest";
import { githubEventSubjects, githubNaturalSubject, githubSubjects } from "./subjects.js";

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    key: "github.check_run.completed",
    dedupeKey: "d1",
    occurredAt: "2026-10-16T00:00:00.000Z",
    refs: {},
    summary: "check run completed",
    payload: {},
    ...overrides,
  };
}

const SHA = "aaaa000000000000000000000000000000000001";

// Recorded payloads, trimmed to the fields `githubEventSubjects` reads
// (spec: docs/specs/2026-10-15-event-wakeups-design.md, Part A2/A6).
const checkRunFailurePr42 = {
  action: "completed",
  check_run: {
    head_sha: SHA,
    conclusion: "failure",
    pull_requests: [{ number: 42 }],
  },
  repository: { full_name: "Acme/Lean-Proofs" },
  sender: { id: 1, login: "octocat", type: "User" },
};

const checkSuiteForkNoPrs = {
  action: "completed",
  check_suite: {
    head_sha: SHA,
    conclusion: "success",
    pull_requests: [],
  },
  repository: { full_name: "acme/lean-proofs" },
  sender: { id: 1, login: "octocat", type: "User" },
};

const prClosedMerged = {
  action: "closed",
  pull_request: {
    number: 42,
    merged: true,
    head: { sha: SHA },
  },
  repository: { full_name: "acme/lean-proofs" },
  sender: { id: 1, login: "octocat", type: "User" },
};

// Trimmed to omit `pull_request.head.sha` — this fixture only exercises the
// PR-number subject, per A6's row for this event. `review.state` is the real
// payload casing ("APPROVED"), so `statusOf`'s `.toLowerCase()` is exercised
// rather than asserted against an already-lowercase fixture.
const reviewApproved = {
  action: "submitted",
  pull_request: { number: 42 },
  review: { state: "APPROVED" },
  repository: { full_name: "acme/lean-proofs" },
  sender: { id: 1, login: "octocat", type: "User" },
};

const commentOnPr42 = {
  action: "created",
  issue: { number: 42 },
  comment: { body: "nice" },
  repository: { full_name: "acme/lean-proofs" },
  sender: { id: 1, login: "octocat", type: "User" },
};

const statusPending = {
  state: "pending",
  sha: SHA,
  repository: { full_name: "acme/lean-proofs" },
  sender: { id: 1, login: "octocat", type: "User" },
};

describe("githubEventSubjects", () => {
  it.each([
    [
      "check_run",
      checkRunFailurePr42,
      ["github:acme", "github:acme/lean-proofs", "github:acme/lean-proofs#42", `github:acme/lean-proofs@${SHA}`],
      "failure",
    ],
    [
      "check_suite",
      checkSuiteForkNoPrs,
      ["github:acme", "github:acme/lean-proofs", `github:acme/lean-proofs@${SHA}`],
      "success",
    ],
    [
      "pull_request",
      prClosedMerged,
      ["github:acme", "github:acme/lean-proofs", "github:acme/lean-proofs#42", `github:acme/lean-proofs@${SHA}`],
      "merged",
    ],
    [
      "pull_request_review",
      reviewApproved,
      ["github:acme", "github:acme/lean-proofs", "github:acme/lean-proofs#42"],
      "approved",
    ],
    ["issue_comment", commentOnPr42, ["github:acme", "github:acme/lean-proofs", "github:acme/lean-proofs#42"], undefined],
    ["status", statusPending, ["github:acme", "github:acme/lean-proofs", `github:acme/lean-proofs@${SHA}`], "pending"],
  ])("%s maps to subjects and status", (type, payload, subjects, status) => {
    const r = githubEventSubjects(type, payload);
    expect(r.subjects).toEqual(subjects);
    expect(r.status).toBe(status);
  });

  it("owner and repo are lower-cased even when the payload is mixed case", () => {
    const r = githubEventSubjects("check_run", checkRunFailurePr42);
    expect(r.subjects).toContain("github:acme/lean-proofs");
  });

  it("non-bot sender marks the actor as not a bot", () => {
    expect(githubEventSubjects("check_run", checkRunFailurePr42).bot).toBe(false);
  });

  it("bot sender marks the actor as a bot", () => {
    expect(
      githubEventSubjects("check_run", {
        ...checkRunFailurePr42,
        sender: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
      }).bot,
    ).toBe(true);
  });
});

describe("githubSubjects.fromUrl", () => {
  it.each([
    ["https://github.com/Acme/Lean-Proofs/pull/42", "github:acme/lean-proofs#42"],
    ["https://github.com/acme/lean-proofs/issues/7", "github:acme/lean-proofs#7"],
    [`https://github.com/acme/lean-proofs/commit/${SHA}`, `github:acme/lean-proofs@${SHA}`],
    ["https://github.com/acme/lean-proofs", "github:acme/lean-proofs"],
    ["github:acme/lean-proofs#42", "github:acme/lean-proofs#42"],
    ["https://example.com/x", null],
  ])("fromUrl(%s)", (input, subject) => {
    expect(githubSubjects.fromUrl(input)?.subject ?? null).toBe(subject);
  });
});

describe("githubSubjects label/url", () => {
  it("label and url round-trip a PR subject", () => {
    expect(githubSubjects.label("github:acme/lean-proofs#42")).toBe("acme/lean-proofs#42");
    expect(githubSubjects.url("github:acme/lean-proofs#42")).toBe("https://github.com/acme/lean-proofs/pull/42");
  });

  it("label and url round-trip a commit subject", () => {
    expect(githubSubjects.label(`github:acme/lean-proofs@${SHA}`)).toBe(`acme/lean-proofs@${SHA}`);
    expect(githubSubjects.url(`github:acme/lean-proofs@${SHA}`)).toBe(`https://github.com/acme/lean-proofs/commit/${SHA}`);
  });

  it("label and url round-trip a repo subject", () => {
    expect(githubSubjects.label("github:acme/lean-proofs")).toBe("acme/lean-proofs");
    expect(githubSubjects.url("github:acme/lean-proofs")).toBe("https://github.com/acme/lean-proofs");
  });
});

describe("githubNaturalSubject", () => {
  it("returns the pull request subject when the payload names one", () => {
    const { subjects } = githubEventSubjects("check_run", checkRunFailurePr42);
    expect(githubNaturalSubject(event({ subjects }))).toEqual({
      subject: "github:acme/lean-proofs#42",
      label: "acme/lean-proofs#42",
    });
  });

  it("falls back to the repository subject when no pull request or issue is named", () => {
    const { subjects } = githubEventSubjects("check_suite", checkSuiteForkNoPrs);
    expect(githubNaturalSubject(event({ subjects }))).toEqual({
      subject: "github:acme/lean-proofs",
      label: "acme/lean-proofs",
    });
  });

  it("returns null when the event names no repository", () => {
    const { subjects } = githubEventSubjects("ping", {});
    expect(githubNaturalSubject(event({ subjects }))).toBeNull();
  });
});

describe("branch subjects", () => {
  it.each([
    ["https://github.com/Acme/App/tree/feat/nested", "github:acme/app:branch/feat/nested"],
    ["https://github.com/acme/app/tree/feat%2Fnested", "github:acme/app:branch/feat/nested"],
    ["github:acme/app:branch/Feat/nested", "github:acme/app:branch/Feat/nested"],
  ])("parses %s", (input, subject) => {
    expect(githubSubjects.fromUrl(input)?.subject).toBe(subject);
    expect(githubSubjects.url(subject)).toContain("/tree/");
  });

  it.each([
    ["pull_request", { pull_request: { head: { ref: "feat/nested", repo: { full_name: "acme/app" } } } }],
    ["check_run", { check_run: { check_suite: { head_branch: "feat/nested" }, pull_requests: [{ head: { repo: { full_name: "acme/app" } } }] } }],
    ["check_suite", { check_suite: { head_branch: "feat/nested", head_repository: { full_name: "acme/app" } } }],
    ["workflow_run", { workflow_run: { head_branch: "feat/nested", head_repository: { full_name: "acme/app" } } }],
    ["push", { ref: "refs/heads/feat/nested" }],
  ])("adds the branch for %s", (type, payload) => {
    expect(githubEventSubjects(type, { repository: { full_name: "acme/app" }, ...payload }).subjects)
      .toContain("github:acme/app:branch/feat/nested");
  });

  it("strips a trailing branch URL slash", () => {
    expect(githubSubjects.fromUrl("https://github.com/acme/app/tree/feat/nested/")?.subject).toBe("github:acme/app:branch/feat/nested");
  });

  it.each([undefined, [], [{ head: { repo: { full_name: "fork/app" } } }]])("does not infer a check-suite branch without same-repo confirmation", (pull_requests) => {
    expect(githubEventSubjects("check_suite", { repository: { full_name: "acme/app" },
      check_suite: { head_branch: "feat/nested", pull_requests } }).subjects).not.toContain("github:acme/app:branch/feat/nested");
  });

  it("rejects the mixed canonical URL form", () => {
    expect(githubSubjects.fromUrl("github:o/r/tree/x")).toBeNull();
  });

  it.each([undefined, [{ head: { repo: { full_name: "fork/app" } } }]])("does not infer a check-run branch from a fork or unknown head", (pull_requests) => {
    const payload = { repository: { full_name: "acme/app" },
      check_run: { check_suite: { head_branch: "feat/nested" }, pull_requests } };
    expect(githubEventSubjects("check_run", payload).subjects).not.toContain("github:acme/app:branch/feat/nested");
  });

  it("ignores a fork head on the same branch", () => {
    const payload = { repository: { full_name: "acme/app" },
      pull_request: { number: 42, head: { ref: "feat/nested", repo: { full_name: "fork/app" } } } };
    expect(githubEventSubjects("pull_request", payload).subjects).not.toContain("github:acme/app:branch/feat/nested");
  });
});
