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

  it("builds a signal from a VerifiedEvent via toSignal", () => {
    const trigger = findTrigger("pull_request");
    const { signal, dispatchId } = trigger.toSignal({
      eventType: "pull_request",
      deliveryId: "delivery-pr-4",
      payload: PULL_REQUEST_PAYLOAD,
    });

    expect(dispatchId).toBe("delivery-pr-4");
    expect(signal.kind).toBe("signal");
    expect(signal.signalType).toBe("github.pull_request");
    expect(signal.body).toBe(JSON.stringify(PULL_REQUEST_PAYLOAD));
    expect(signal.attributes).toEqual({ deliveryId: "delivery-pr-4", action: "opened" });
  });

  it("omits the action attribute when the payload has none", () => {
    const trigger = findTrigger("push");
    const pushPayload = { ref: "refs/heads/main", repository: { full_name: "acme/widgets" } };
    const { signal } = trigger.toSignal({
      eventType: "push",
      deliveryId: "delivery-push-1",
      payload: pushPayload,
    });

    expect(signal.attributes).toEqual({ deliveryId: "delivery-push-1" });
  });
});
