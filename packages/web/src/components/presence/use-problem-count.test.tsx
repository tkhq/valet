// @vitest-environment jsdom
/**
 * The rail's Activity count (spec Part F step 4): lines of presence with a
 * problem, routines the scheduler turned off, and Activity rows with a dead
 * delivery in the last day. The query hooks are mocked; the sum is the test.
 */
import { renderHook } from "@testing-library/react";
import type {
  EventDeliveryWire,
  EventLogItem,
  EventSubscriptionWire,
  PresencePlaceWire,
  WorkflowTriggerItem,
} from "@valet/api/wire";
import { describe, expect, it, vi } from "vitest";

const NOW = Date.now();

function rule(id: string, over: Partial<EventSubscriptionWire> = {}): EventSubscriptionWire {
  return {
    id, name: id, ownerType: "user", ownerId: "u-001", eventKeys: [], filters: [],
    target: { kind: "assistant" }, enabled: true, createdBy: "u-001", createdAt: 1, updatedAt: 1, ...over,
  };
}

function routine(id: string, disabledReason?: string): WorkflowTriggerItem {
  return {
    kind: "schedule", id, name: id, enabled: disabledReason === undefined,
    detail: {
      cron: "0 9 * * *", timezone: "UTC", targetKind: "assistant", prompt: "Hi.", nextFireAt: NOW, lastFiredAt: null,
      ownerType: "user", ownerId: "u-001", ...(disabledReason !== undefined ? { disabledReason } : {}),
    },
  };
}

function delivery(status: EventDeliveryWire["status"]): EventDeliveryWire {
  return { id: `d-${status}`, subscriptionId: "R1", status, attempts: 1, lastError: null, deliveredAt: null };
}

function logItem(id: string, at: number, deliveries: EventDeliveryWire[]): EventLogItem {
  return {
    kind: "event", id, at, status: "failed", service: "slack", eventKey: "slack.message", summary: id, actor: null,
    reason: null, detail: null, deliveryCount: deliveries.length, deliveries,
  };
}

const PLACES: PresencePlaceWire[] = [
  { subject: "slack:T1", label: "Slack", service: "slack", parent: null, listenerCount: 0, activeThreadCount: 0, lastActivityAt: null },
  { subject: "slack:T1/C900", label: "#incidents", service: "slack", parent: "slack:T1", listenerCount: 2, activeThreadCount: 0, lastActivityAt: null },
  { subject: "github:acme/api", label: "acme/api", service: "github", parent: null, listenerCount: 1, activeThreadCount: 0, lastActivityAt: null },
];

const RULES = [
  rule("R1", { filters: [{ field: "channel", op: "eq", value: "C900" }], problem: "Pick another thread for this line in Presence." }),
  rule("R2", { filters: [{ field: "repo", op: "eq", value: "acme/api" }] }),
  rule("R3", { filters: [], problem: "Pick another thread." }),
];
const TRIGGERS = [routine("S1"), routine("S2", "The pinned thread is archived."), { kind: "event", id: "E1", workflowId: "wf-1", name: "E1", enabled: true, detail: { eventKeys: [], filters: [] } } satisfies WorkflowTriggerItem];
const LOG = [
  logItem("ev-dead", NOW - 60_000, [delivery("delivered"), delivery("dead")]),
  logItem("ev-old-dead", NOW - 2 * 24 * 60 * 60 * 1000, [delivery("dead")]),
  logItem("ev-failed", NOW - 60_000, [delivery("failed")]),
];

const owner = { ownerType: "user" as const, ownerId: "u-001" };
const logCalls: Array<{ problems: boolean }> = [];

vi.mock("~/lib/use-list-owner", () => ({ useListOwner: () => owner }));
vi.mock("~/api/events", () => ({
  useEventSubscriptions: () => ({ data: { subscriptions: RULES } }),
  useEventLog: (params: { problems: boolean }) => {
    logCalls.push(params);
    return { data: { pages: [{ items: LOG.slice(0, 1) }, { items: LOG.slice(1) }] } };
  },
}));
vi.mock("~/api/workflows", () => ({ useWorkflowTriggers: () => ({ data: { triggers: TRIGGERS } }) }));
vi.mock("~/api/presence", () => ({ usePresencePlaces: () => ({ data: { places: PLACES } }) }));

import { problemCount, useProblemCount } from "./use-problem-count";

describe("useProblemCount", () => {
  it("sums lines with a problem, routines turned off, and dead deliveries in the last day", () => {
    const { result } = renderHook(() => useProblemCount());
    // R1 and R3, S2, and ev-dead. ev-old-dead is older than a day; ev-failed has no dead delivery.
    expect(result.current.count).toBe(4);
    expect([...result.current.problemPlaces]).toEqual(["slack:T1/C900"]);
    expect(logCalls.at(-1)?.problems).toBe(true);
  });
});

describe("problemCount", () => {
  it("counts zero with no problem", () => {
    expect(problemCount({ rules: [rule("R2")], triggers: [routine("S1")], log: [], places: PLACES, now: NOW })).toEqual({
      count: 0,
      problemPlaces: new Set(),
    });
  });

  it("does not count an empty problem or an empty disabledReason", () => {
    const result = problemCount({ rules: [rule("R4", { problem: "" })], triggers: [routine("S3", "")], log: [], places: PLACES, now: NOW });
    expect(result.count).toBe(0);
  });
});
