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

  it("uses the bare event key when the payload has no action", () => {
    const pushDef = githubTriggerDefs.find((t) => t.id === "github.push")!;
    const event = pushDef.toEvent({ eventType: "push", deliveryId: "d2", payload: { repository: { full_name: "a/b" } } });
    expect(event.key).toBe("github.push");
  });

  it("declares a catalog with repo filter on every def", () => {
    for (const def of githubTriggerDefs) {
      expect(def.catalog.length).toBeGreaterThan(0);
      expect(def.catalog[0].filters.some((f) => f.field === "repo")).toBe(true);
    }
  });
});
