/** The events log (`GET /api/events/log`) and one event's detail with many
 * deliveries (`GET /api/events/:id`). */
import type {
  EventDeliveryWire,
  EventLogItem,
  EventLogResponse,
  EventLogStatus,
  GetEventResponse,
  ListEventSubscriptionsResponse,
} from "@valet/api/wire";
import { HEX_300, MINUTE, NOW, STRING_2000, TITLE_400, URL_300, deepJson, memberId, unbroken } from "./common";
import { stressTitle } from "./approvals";

const STATUSES: EventLogStatus[] = ["delivered", "pending", "failed", "skipped", "filtered", "no_match", "rejected"];

export const EVENT_LOG_COUNT = 120;
export const EVENT_LOG_PAGE_SIZE = 40;

function logItem(i: number): EventLogItem {
  // Runs of identical problems fold into one row with a count.
  const problem = i % 4 === 3 || (i >= 60 && i < 66);
  return {
    kind: problem ? "problem" : "event",
    id: `log-${i}`,
    at: NOW - i * 9 * MINUTE,
    status: STATUSES[i % STATUSES.length]!,
    service: i % 5 === 0 ? `service-${unbroken("enterprise", 50)}` : "github",
    eventKey: i % 3 === 0 ? `pull_request.${unbroken("review_requested_", 60)}` : "issues.opened",
    summary: i % 7 === 6 ? null : stressTitle(i),
    actor: i % 2 === 0 ? `${memberId(i % 20)}@${unbroken("subsidiary", 30)}.example.com` : null,
    reason: problem ? (i >= 60 && i < 66 ? "signature_invalid" : `reason_${unbroken("unexpected_payload_", 40)}`) : null,
    detail: problem ? (i >= 60 && i < 66 ? "Signature mismatch" : `${URL_300} ${STRING_2000.slice(0, 400)}`) : i % 6 === 0 ? `${HEX_300}` : null,
    deliveryCount: i * 37,
  };
}

/** Every log row, newest first. The resolver pages and filters this. */
export const stressEventLogItems: EventLogItem[] = Array.from({ length: EVENT_LOG_COUNT }, (_, i) => logItem(i));

/** One page of the log for a filter, a search, and a cursor. */
export function eventLogPage(options: { problems: boolean; q: string; cursor: string | undefined; diagnostics: boolean }): EventLogResponse {
  const q = options.q.toLowerCase();
  const matching = stressEventLogItems.filter((item) =>
    (!options.problems || item.kind === "problem")
    && (!q || [item.summary, item.eventKey, item.detail, item.reason].some((text) => text?.toLowerCase().includes(q))));
  const start = options.cursor ? Number(options.cursor.replace("log-page-", "")) * EVENT_LOG_PAGE_SIZE : 0;
  const page = Math.floor(start / EVENT_LOG_PAGE_SIZE);
  const end = start + EVENT_LOG_PAGE_SIZE;
  return {
    items: matching.slice(start, end),
    nextCursor: end < matching.length ? `log-page-${page + 1}` : null,
    lastEventAt: options.diagnostics ? NOW - MINUTE : null,
    windowDays: 30,
  };
}

const DELIVERY_STATUSES: EventDeliveryWire["status"][] = ["delivered", "pending", "failed", "dead", "skipped"];

export const EVENT_DELIVERY_COUNT = 60;

export const stressEventDetail: GetEventResponse = {
  event: {
    id: "event-stress",
    service: `service-${unbroken("enterprise", 50)}`,
    eventKey: `pull_request.${unbroken("review_requested_", 60)}`,
    summary: TITLE_400,
    refs: {
      repository: URL_300,
      commit: HEX_300,
      pull_request: "#123456789",
      ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`ref_${unbroken("label", 30)}_${i}`, `value-${i}`])),
    },
    actor: { externalId: `external-${HEX_300.slice(0, 80)}`, login: `bot-${unbroken("automation", 60)}` },
    occurredAt: NOW - 3 * MINUTE,
    receivedAt: NOW - 2 * MINUTE,
    payload: { action: "review_requested", body: STRING_2000, nested: deepJson(9) },
  },
  deliveries: Array.from({ length: EVENT_DELIVERY_COUNT }, (_, i): EventDeliveryWire => {
    const status = DELIVERY_STATUSES[i % DELIVERY_STATUSES.length]!;
    return {
      id: `delivery-${i}`,
      subscriptionId: `subscription-${HEX_300.slice(0, 48)}-${i}`,
      status,
      attempts: i % 9,
      lastError: status === "failed" || status === "dead" ? `POST ${URL_300} → 502. ${STRING_2000.slice(0, 900)}`
        : status === "skipped" ? `Skipped: ${TITLE_400}`
        : null,
      deliveredAt: status === "delivered" ? NOW - i * MINUTE : null,
      nextAttemptAt: status === "pending" ? NOW + i * MINUTE : null,
      subscriptionName: i % 4 === 3 ? undefined : stressTitle(i),
    };
  }),
};

export const stressEventSubscriptions: ListEventSubscriptionsResponse = {
  subscriptions: Array.from({ length: 6 }, (_, i) => ({
    id: `subscription-${i}`,
    name: stressTitle(i),
    ownerType: "user",
    ownerId: memberId(0),
    eventKeys: [`pull_request.${unbroken("review_requested_", 60)}`],
    filters: [],
    target: { kind: "orchestrator" },
    enabled: i % 2 === 0,
    createdBy: memberId(0),
    createdAt: NOW - i * MINUTE,
    updatedAt: NOW - i * MINUTE,
  })),
};
