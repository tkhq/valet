import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { githubTriggerDefs } from "./triggers.js";

const SECRET = "test-webhook-secret";

function sign(body: Uint8Array): string {
  return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
}

function encode(payload: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

function findTrigger(eventType: string) {
  const trigger = githubTriggerDefs.find((t) => t.id === `github.${eventType}`);
  if (!trigger) throw new Error(`no trigger def for ${eventType}`);
  return trigger;
}

const PULL_REQUEST_PAYLOAD = {
  action: "opened",
  number: 42,
  pull_request: { id: 1, title: "Add feature" },
  repository: { full_name: "acme/widgets" },
};

const ISSUES_PAYLOAD = {
  action: "closed",
  issue: { id: 7, number: 9, title: "Bug report" },
  repository: { full_name: "acme/widgets" },
};

describe("githubTriggerDefs", () => {
  it("verifies a valid pull_request webhook and produces a VerifiedEvent", async () => {
    const trigger = findTrigger("pull_request");
    const rawBody = encode(PULL_REQUEST_PAYLOAD);
    const headers = {
      "X-Hub-Signature-256": sign(rawBody),
      "X-GitHub-Event": "pull_request",
      "X-GitHub-Delivery": "delivery-pr-1",
    };

    const event = await trigger.verify({ headers, rawBody }, { webhookSecret: SECRET });

    expect(event).not.toBeNull();
    expect(event?.eventType).toBe("pull_request");
    expect(event?.deliveryId).toBe("delivery-pr-1");
    expect(event?.payload).toEqual(PULL_REQUEST_PAYLOAD);
  });

  it("verifies a valid issues webhook and produces a VerifiedEvent", async () => {
    const trigger = findTrigger("issues");
    const rawBody = encode(ISSUES_PAYLOAD);
    const headers = {
      "X-Hub-Signature-256": sign(rawBody),
      "X-GitHub-Event": "issues",
      "X-GitHub-Delivery": "delivery-issue-1",
    };

    const event = await trigger.verify({ headers, rawBody }, { webhookSecret: SECRET });

    expect(event).not.toBeNull();
    expect(event?.eventType).toBe("issues");
    expect(event?.deliveryId).toBe("delivery-issue-1");
    expect(event?.payload).toEqual(ISSUES_PAYLOAD);
  });

  it("rejects a tampered body (signature no longer matches)", async () => {
    const trigger = findTrigger("pull_request");
    const rawBody = encode(PULL_REQUEST_PAYLOAD);
    const headers = {
      "X-Hub-Signature-256": sign(rawBody),
      "X-GitHub-Event": "pull_request",
      "X-GitHub-Delivery": "delivery-pr-2",
    };

    const tamperedBody = encode({ ...PULL_REQUEST_PAYLOAD, number: 999 });
    const event = await trigger.verify({ headers, rawBody: tamperedBody }, { webhookSecret: SECRET });

    expect(event).toBeNull();
  });

  it("rejects a request missing the signature header", async () => {
    const trigger = findTrigger("pull_request");
    const rawBody = encode(PULL_REQUEST_PAYLOAD);
    const headers = {
      "X-GitHub-Event": "pull_request",
      "X-GitHub-Delivery": "delivery-pr-3",
    };

    const event = await trigger.verify({ headers, rawBody }, { webhookSecret: SECRET });

    expect(event).toBeNull();
  });

  it("rejects an event whose type doesn't belong to this def's family", async () => {
    const trigger = findTrigger("pull_request");
    const rawBody = encode(ISSUES_PAYLOAD);
    const headers = {
      "X-Hub-Signature-256": sign(rawBody),
      "X-GitHub-Event": "issues",
      "X-GitHub-Delivery": "delivery-issue-2",
    };

    const event = await trigger.verify({ headers, rawBody }, { webhookSecret: SECRET });

    expect(event).toBeNull();
  });

  it("does header lookups case-insensitively", async () => {
    const trigger = findTrigger("issues");
    const rawBody = encode(ISSUES_PAYLOAD);
    const headers = {
      "x-hub-signature-256": sign(rawBody),
      "x-github-event": "issues",
      "x-github-delivery": "delivery-issue-3",
    };

    const event = await trigger.verify({ headers, rawBody }, { webhookSecret: SECRET });

    expect(event).not.toBeNull();
    expect(event?.deliveryId).toBe("delivery-issue-3");
  });
});

const prDef = githubTriggerDefs.find((t) => t.id === "github.pull_request")!;

describe("github toEvent", () => {
  it("normalizes a pull_request.opened payload", () => {
    const event = prDef.toEvent({
      eventType: "pull_request",
      deliveryId: "delivery-1",
      payload: {
        action: "opened",
        repository: { full_name: "tkhq/valet" },
        installation: { id: 42 },
        sender: { id: 7, login: "conner" },
        pull_request: { number: 5, title: "Add thing", html_url: "https://github.com/tkhq/valet/pull/5" },
      },
    });
    expect(event.key).toBe("github.pull_request.opened");
    expect(event.dedupeKey).toBe("delivery-1");
    expect(event.refs.repo).toBe("tkhq/valet");
    expect(event.refs.installation_id).toBe("42");
    expect(event.actor).toEqual({ externalId: "7", login: "conner" });
    expect(event.summary).toContain("tkhq/valet");
    expect(event.summary).toContain("pull_request opened");
  });

  it("takes occurredAt from the payload's own timestamps, not ingestion time", () => {
    const event = prDef.toEvent({
      eventType: "pull_request",
      deliveryId: "d3",
      payload: {
        action: "closed",
        repository: { full_name: "a/b" },
        pull_request: { number: 5, updated_at: "2026-07-01T12:00:00Z" },
      },
    });
    expect(event.occurredAt).toBe("2026-07-01T12:00:00Z");

    // Comment events also carry issue/pull_request — the comment's own
    // timestamp wins.
    const commentDef = githubTriggerDefs.find((t) => t.id === "github.issue_comment")!;
    const comment = commentDef.toEvent({
      eventType: "issue_comment",
      deliveryId: "d4",
      payload: {
        action: "created",
        comment: { created_at: "2026-07-02T08:30:00Z" },
        issue: { updated_at: "2026-07-02T09:00:00Z" },
      },
    });
    expect(comment.occurredAt).toBe("2026-07-02T08:30:00Z");

    // push: head_commit.timestamp.
    const pushDef = githubTriggerDefs.find((t) => t.id === "github.push")!;
    const push = pushDef.toEvent({
      eventType: "push",
      deliveryId: "d5",
      payload: { repository: { full_name: "a/b" }, head_commit: { timestamp: "2026-07-03T10:00:00-07:00" } },
    });
    expect(push.occurredAt).toBe("2026-07-03T10:00:00-07:00");
  });

  it("falls back to wall clock when no payload timestamp is present", () => {
    const before = Date.now();
    const pushDef = githubTriggerDefs.find((t) => t.id === "github.push")!;
    const event = pushDef.toEvent({ eventType: "push", deliveryId: "d6", payload: { repository: { full_name: "a/b" } } });
    const parsed = Date.parse(event.occurredAt);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(Date.now());
  });

  it("uses the bare event key when the payload has no action", () => {
    const pushDef = githubTriggerDefs.find((t) => t.id === "github.push")!;
    const event = pushDef.toEvent({ eventType: "push", deliveryId: "d2", payload: { repository: { full_name: "a/b" } } });
    expect(event.key).toBe("github.push");
  });

  it("declares a catalog with repo filter on every def (except ping)", () => {
    const pingDef = githubTriggerDefs.find((t) => t.id === "github.ping")!;
    expect(pingDef.catalog).toHaveLength(0);

    for (const def of githubTriggerDefs.filter((t) => t.id !== "github.ping")) {
      expect(def.catalog.length).toBeGreaterThan(0);
      expect(def.catalog[0].filters.some((f) => f.field === "repo")).toBe(true);
    }
  });
});

// ─── Review event families ──────────────────────────────────────────────────

const REVIEW_SUBMITTED_PAYLOAD = {
  action: "submitted",
  review: {
    id: 2626884,
    user: { login: "octocat", id: 583231 },
    body: "Two nits",
    // The webhook delivers a LOWERCASE state; the REST API returns uppercase.
    state: "changes_requested",
    submitted_at: "2026-07-05T12:00:00Z",
    commit_id: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
  },
  pull_request: { number: 42, title: "Add feature", updated_at: "2026-07-05T13:00:00Z" },
  repository: { full_name: "acme/widgets" },
  sender: { login: "octocat", id: 583231 },
};

const REVIEW_COMMENT_PAYLOAD = {
  action: "created",
  comment: {
    id: 993,
    path: "source/rest/handler.go",
    line: 12,
    side: "RIGHT",
    body: "Close the response body",
    created_at: "2026-07-05T12:05:00Z",
    updated_at: "2026-07-05T12:05:00Z",
    user: { login: "octocat", id: 583231 },
    pull_request_review_id: 2626884,
  },
  pull_request: { number: 42, updated_at: "2026-07-05T13:00:00Z" },
  repository: { full_name: "acme/widgets" },
  sender: { login: "octocat", id: 583231 },
};

const REVIEW_THREAD_PAYLOAD = {
  action: "resolved",
  thread: { node_id: "PRRT_kwDO", comments: [{ id: 993, path: "source/rest/handler.go" }] },
  pull_request: { number: 42, updated_at: "2026-07-05T13:00:00Z" },
  repository: { full_name: "acme/widgets" },
  sender: { login: "octocat", id: 583231 },
};

/**
 * Mirrors `resolvePath` in `packages/api/src/events/match.ts`, which the
 * subscription filter matcher uses on the raw payload. plugin-github must not
 * import from the api package, so the walk is copied here to prove that each
 * declared catalog `path` resolves to a scalar on a real payload. A path that
 * resolves to undefined makes the filter silently fail to match.
 */
function resolveDotPath(payload: unknown, path: string): unknown {
  let cur: unknown = payload;
  for (const segment of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

/** `filtersMatch` coerces with `asString`, which accepts string and number only. */
function isFilterableScalar(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number";
}

function catalogEntry(triggerId: string, key: string) {
  const def = githubTriggerDefs.find((t) => t.id === triggerId);
  if (!def) throw new Error(`no trigger def for ${triggerId}`);
  const entry = def.catalog.find((e) => e.key === key);
  if (!entry) throw new Error(`no catalog entry ${key} on ${triggerId}`);
  return entry;
}

describe("github review event families", () => {
  it("declares a trigger def for each review event family", () => {
    for (const eventType of [
      "pull_request_review",
      "pull_request_review_comment",
      "pull_request_review_thread",
    ]) {
      expect(githubTriggerDefs.map((t) => t.id)).toContain(`github.${eventType}`);
    }
  });

  it("verifies a pull_request_review webhook", async () => {
    const trigger = findTrigger("pull_request_review");
    const rawBody = encode(REVIEW_SUBMITTED_PAYLOAD);
    const headers = {
      "X-Hub-Signature-256": sign(rawBody),
      "X-GitHub-Event": "pull_request_review",
      "X-GitHub-Delivery": "delivery-review-1",
    };

    const event = await trigger.verify({ headers, rawBody }, { webhookSecret: SECRET });

    expect(event).not.toBeNull();
    expect(event?.eventType).toBe("pull_request_review");
    expect(event?.deliveryId).toBe("delivery-review-1");
  });

  it("does not let the pull_request def swallow a pull_request_review delivery", async () => {
    const trigger = findTrigger("pull_request");
    const rawBody = encode(REVIEW_SUBMITTED_PAYLOAD);
    const headers = {
      "X-Hub-Signature-256": sign(rawBody),
      "X-GitHub-Event": "pull_request_review",
      "X-GitHub-Delivery": "delivery-review-2",
    };

    const event = await trigger.verify({ headers, rawBody }, { webhookSecret: SECRET });

    expect(event).toBeNull();
  });

  it("normalizes review events to action-qualified keys", () => {
    const review = findTrigger("pull_request_review").toEvent({
      eventType: "pull_request_review",
      deliveryId: "d-review",
      payload: REVIEW_SUBMITTED_PAYLOAD,
    });
    expect(review.key).toBe("github.pull_request_review.submitted");
    expect(review.refs.repo).toBe("acme/widgets");
    // review.submitted_at, not pull_request.updated_at.
    expect(review.occurredAt).toBe("2026-07-05T12:00:00Z");

    const comment = findTrigger("pull_request_review_comment").toEvent({
      eventType: "pull_request_review_comment",
      deliveryId: "d-review-comment",
      payload: REVIEW_COMMENT_PAYLOAD,
    });
    expect(comment.key).toBe("github.pull_request_review_comment.created");
    expect(comment.occurredAt).toBe("2026-07-05T12:05:00Z");

    const thread = findTrigger("pull_request_review_thread").toEvent({
      eventType: "pull_request_review_thread",
      deliveryId: "d-review-thread",
      payload: REVIEW_THREAD_PAYLOAD,
    });
    expect(thread.key).toBe("github.pull_request_review_thread.resolved");
    // No thread timestamp exists, so the PR's own timestamp is the fallback.
    expect(thread.occurredAt).toBe("2026-07-05T13:00:00Z");
  });

  it("catalogs the documented actions for each review family", () => {
    const keysOf = (id: string) => githubTriggerDefs.find((t) => t.id === id)!.catalog.map((e) => e.key);

    expect(keysOf("github.pull_request_review")).toEqual([
      "github.pull_request_review.submitted",
      "github.pull_request_review.edited",
      "github.pull_request_review.dismissed",
    ]);
    expect(keysOf("github.pull_request_review_comment")).toEqual([
      "github.pull_request_review_comment.created",
      "github.pull_request_review_comment.edited",
      "github.pull_request_review_comment.deleted",
    ]);
    expect(keysOf("github.pull_request_review_thread")).toEqual([
      "github.pull_request_review_thread.resolved",
      "github.pull_request_review_thread.unresolved",
    ]);
  });

  it("declares review_state and pr_number filters on pull_request_review", () => {
    const entry = catalogEntry("github.pull_request_review", "github.pull_request_review.submitted");
    const byField = new Map(entry.filters.map((f) => [f.field, f.path]));

    expect(byField.get("repo")).toBe("repository.full_name");
    expect(byField.get("sender")).toBe("sender.login");
    expect(byField.get("review_state")).toBe("review.state");
    expect(byField.get("pr_number")).toBe("pull_request.number");
  });

  it("declares a path filter on pull_request_review_comment for folder scoping", () => {
    const entry = catalogEntry(
      "github.pull_request_review_comment",
      "github.pull_request_review_comment.created",
    );
    const byField = new Map(entry.filters.map((f) => [f.field, f.path]));

    expect(byField.get("path")).toBe("comment.path");
    expect(byField.get("pr_number")).toBe("pull_request.number");
  });

  it("resolves every declared filter path to a scalar on a real payload", () => {
    const cases: [string, string, unknown][] = [
      ["github.pull_request_review", "github.pull_request_review.submitted", REVIEW_SUBMITTED_PAYLOAD],
      [
        "github.pull_request_review_comment",
        "github.pull_request_review_comment.created",
        REVIEW_COMMENT_PAYLOAD,
      ],
      [
        "github.pull_request_review_thread",
        "github.pull_request_review_thread.resolved",
        REVIEW_THREAD_PAYLOAD,
      ],
    ];

    for (const [triggerId, key, payload] of cases) {
      for (const filter of catalogEntry(triggerId, key).filters) {
        const resolved = resolveDotPath(payload, filter.path);
        expect(
          isFilterableScalar(resolved),
          `${key} filter "${filter.field}" path "${filter.path}" resolved to ${JSON.stringify(resolved)}`,
        ).toBe(true);
      }
    }
  });
});
