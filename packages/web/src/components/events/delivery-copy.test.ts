/**
 * The delivery sentences are pure, so they are tested without a DOM. Each
 * case here is a state a reader has to tell apart: still coming, over, or
 * never started.
 */
import { describe, expect, it } from "vitest";
import type { EventDeliveryWire, EventSubscriptionWire } from "@valet/api/wire";
import {
  deliveryStatusLine,
  redeliverConfirmDescription,
  redeliverResultText,
  retryPhrase,
  scheduledRetryCount,
  subscriptionsMatchingKey,
} from "./delivery-copy";

const NOW = 1_723_200_000_000;

function delivery(over: Partial<EventDeliveryWire>): EventDeliveryWire {
  return {
    id: "d1",
    subscriptionId: "sub_1",
    subscriptionName: "PR alerts",
    status: "pending",
    attempts: 0,
    lastError: null,
    deliveredAt: null,
    nextAttemptAt: null,
    ...over,
  };
}

function subscription(over: Partial<EventSubscriptionWire>): EventSubscriptionWire {
  return {
    id: "sub_1",
    name: "PR alerts",
    ownerType: "user",
    ownerId: "u1",
    eventKeys: ["github.pull_request.opened"],
    filters: [],
    target: { kind: "orchestrator" },
    enabled: true,
    createdBy: "u1",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe("retryPhrase", () => {
  it("rounds down so it never over-promises", () => {
    expect(retryPhrase(0)).toBe("now");
    expect(retryPhrase(-5_000)).toBe("now");
    expect(retryPhrase(30_000)).toBe("in less than a minute");
    expect(retryPhrase(60_000)).toBe("in 1 minute");
    expect(retryPhrase(8 * 60_000 + 45_000)).toBe("in 8 minutes");
    expect(retryPhrase(60 * 60_000)).toBe("in 1 hour");
    expect(retryPhrase(150 * 60_000)).toBe("in 2 hours");
  });
});

describe("deliveryStatusLine", () => {
  it("tells a retrying delivery apart from one that gave up", () => {
    const retrying = deliveryStatusLine(
      delivery({ status: "failed", attempts: 2, nextAttemptAt: NOW + 8 * 60_000 }),
      NOW,
    );
    expect(retrying).toBe("Retries in 8 minutes, after 2 attempts.");

    const dead = deliveryStatusLine(delivery({ status: "dead", attempts: 4 }), NOW);
    expect(dead).toBe("Gave up after 4 attempts. To send it again, press Redeliver.");
  });

  it("describes a queued first attempt without a countdown", () => {
    expect(deliveryStatusLine(delivery({ status: "pending", nextAttemptAt: NOW }), NOW)).toBe(
      "Waiting for the first attempt.",
    );
  });

  it("says what is certain when the server sends no next attempt", () => {
    expect(deliveryStatusLine(delivery({ status: "failed", attempts: 1 }), NOW)).toBe(
      "Retry scheduled after 1 attempt.",
    );
  });

  it("reports the attempt count for a delivered row", () => {
    expect(deliveryStatusLine(delivery({ status: "delivered", attempts: 1, deliveredAt: NOW }), NOW)).toBe(
      "1 attempt",
    );
  });
});

describe("subscriptionsMatchingKey", () => {
  it("matches exact keys and trailing wildcards, and skips disabled rows", () => {
    const subs = [
      subscription({ id: "exact" }),
      subscription({ id: "wildcard", eventKeys: ["github.pull_request.*"] }),
      subscription({ id: "other", eventKeys: ["linear.issue.create"] }),
      subscription({ id: "off", enabled: false }),
    ];
    expect(subscriptionsMatchingKey(subs, "github.pull_request.opened").map((s) => s.id)).toEqual([
      "exact",
      "wildcard",
    ]);
  });
});

describe("scheduledRetryCount", () => {
  it("counts only the deliveries the dispatcher still acts on", () => {
    expect(
      scheduledRetryCount([
        delivery({ id: "a", status: "pending" }),
        delivery({ id: "b", status: "failed" }),
        delivery({ id: "c", status: "delivered" }),
        delivery({ id: "d", status: "dead" }),
      ]),
    ).toBe(2);
  });
});

describe("redeliverConfirmDescription", () => {
  it("names how many subscriptions and runs the press starts", () => {
    expect(redeliverConfirmDescription(2, 0)).toBe(
      "This event matches up to 2 enabled subscriptions. Each match creates one delivery, so this can start up to 2 runs.",
    );
  });

  it("warns that a scheduled retry can run the work twice", () => {
    expect(redeliverConfirmDescription(1, 1)).toContain("still scheduled to retry");
    expect(redeliverConfirmDescription(1, 1)).toContain("can run the same work twice");
  });

  it("names the corrective action when nothing matches", () => {
    expect(redeliverConfirmDescription(0, 0)).toContain("Subscriptions tab");
  });
});

describe("redeliverResultText", () => {
  it("reports a zero-created redelivery as a real outcome", () => {
    expect(redeliverResultText(0)).toContain("Nothing was queued");
    expect(redeliverResultText(0)).toContain("Enable or edit one on the Subscriptions tab");
    expect(redeliverResultText(2)).toBe("Queued 2 deliveries. The result appears in this list.");
    expect(redeliverResultText(1)).toBe("Queued 1 delivery. The result appears in this list.");
  });
});
