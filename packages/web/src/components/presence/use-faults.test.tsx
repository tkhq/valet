// @vitest-environment jsdom
/**
 * The banner's faults (spec Part B step 2, Part F step 4): lines with a
 * problem, routines the scheduler turned off, and lines with a dead delivery
 * in the last day that do not already show and were not edited after it.
 * Each fault shows once, in that order. The query hooks are mocked; the
 * faults are the test.
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
import { PIN_UNAVAILABLE, PIN_UNAVAILABLE_LEGACY } from "./problem-badge";
import { line, routine } from "./test-fixtures";

const NOW = Date.now();

function rule(id: string, over: Partial<EventSubscriptionWire> = {}): EventSubscriptionWire {
  return line(id, { eventKeys: ["slack.app_mention"], ...over });
}

/** A routine named by its id. With a `disabledReason`, the scheduler turned it off. */
function namedRoutine(id: string, disabledReason?: string): WorkflowTriggerItem {
  return routine(id, {
    name: id,
    enabled: disabledReason === undefined,
    detail: { nextFireAt: NOW, ...(disabledReason !== undefined ? { disabledReason } : {}) },
  });
}

function delivery(status: EventDeliveryWire["status"], subscriptionId = "R1"): EventDeliveryWire {
  return { id: `d-${status}-${subscriptionId}`, subscriptionId, status, attempts: 3, lastError: null, deliveredAt: null };
}

function logItem(id: string, at: number, deliveries: EventDeliveryWire[]): EventLogItem {
  return {
    kind: "event", id, at, status: "failed", service: "github", eventKey: "github.check_run.completed", summary: id, actor: null,
    reason: null, detail: null, deliveryCount: deliveries.length, place: "acme/api#14", deliveries,
  };
}

const PLACES: PresencePlaceWire[] = [
  { subject: "slack:T1", label: "Slack", service: "slack", parent: null, listenerCount: 0, activeThreadCount: 0, lastActivityAt: null },
  { subject: "slack:T1/C900", label: "#incidents", service: "slack", parent: "slack:T1", listenerCount: 2, activeThreadCount: 0, lastActivityAt: null },
  { subject: "github:acme/api", label: "acme/api", service: "github", parent: null, listenerCount: 1, activeThreadCount: 0, lastActivityAt: null },
];

const RULES = [
  rule("R1", {
    filters: [{ field: "channel", op: "eq", value: "C900" }],
    target: { kind: "assistant", thread: { mode: "existing", sessionId: "s-u", threadId: "t-ci" } },
    problem: PIN_UNAVAILABLE,
  }),
  rule("R2", { eventKeys: ["github.check_run.completed"], filters: [{ field: "repo", op: "eq", value: "acme/api" }] }),
  rule("R3", { problem: "Reconnect Slack in Integrations." }),
];
const TRIGGERS = [
  namedRoutine("S1"),
  namedRoutine("S2", "The pinned thread is archived."),
  { kind: "event", id: "E1", workflowId: "wf-1", name: "E1", enabled: true, detail: { eventKeys: [], filters: [] } } satisfies WorkflowTriggerItem,
];
const LOG = [
  logItem("ev-dead", NOW - 60_000, [delivery("delivered"), delivery("dead")]),
  logItem("ev-r2", NOW - 30_000, [delivery("dead", "R2")]),
  logItem("ev-old-dead", NOW - 2 * 24 * 60 * 60 * 1000, [delivery("dead", "R9")]),
  logItem("ev-failed", NOW - 60_000, [delivery("failed", "R8")]),
];

const owner = { ownerType: "user" as const, ownerId: "u-001" };
const logCalls: Array<{ problems: boolean }> = [];

vi.mock("~/lib/use-list-owner", () => ({ useListOwner: () => owner }));
vi.mock("~/api/events", () => ({
  useEventSubscriptions: () => ({ data: { subscriptions: RULES }, isPending: false }),
  useEventLog: (params: { problems: boolean }) => {
    logCalls.push(params);
    return { data: { pages: [{ items: LOG.slice(0, 2) }, { items: LOG.slice(2) }] }, isPending: false };
  },
}));
vi.mock("~/api/workflows", () => ({ useWorkflowTriggers: () => ({ data: { triggers: TRIGGERS }, isPending: false }) }));
vi.mock("~/api/presence", () => ({ usePresencePlaces: () => ({ data: { places: PLACES }, isPending: false }) }));
vi.mock("~/api/rule", () => ({ usePinnedThreadTitles: () => ({ "t-ci": { title: "Platform CI" } }) }));

import { faultsOf, useFaults } from "./use-faults";

describe("useFaults", () => {
  it("lists lines, then routines, then dead deliveries, each fault once", () => {
    const { result } = renderHook(() => useFaults());
    // R1 and R3, S2, and R2's dead delivery. ev-dead is R1's fault, which
    // R1's problem already lists; ev-old-dead is older than a day;
    // ev-failed has no dead delivery.
    expect(result.current.faults.map((fault) => [fault.kind, fault.text])).toEqual([
      ["line", "Platform CI is archived. Pick another thread:"],
      ["line", "Reconnect Slack in Integrations."],
      ["routine", "S2 is off: The pinned thread is archived."],
      ["delivery", "Completed check in acme/api#14 → gave up after 3 attempts. To send it again, press Redeliver"],
    ]);
    // A dead delivery marks its line's place row too, so a collapsed group with only that fault stays open.
    expect([...result.current.faultedPlaces]).toEqual(["slack:T1/C900", "slack:T1", "github:acme/api"]);
    // Each line or delivery fault leads with its place: the place it names, else its service row.
    expect(result.current.faults.map((fault) => (fault.kind === "routine" ? null : fault.lead))).toEqual([
      "In #incidents,", "Everywhere in Slack,", null, "In acme/api,",
    ]);
    expect(result.current.isPending).toBe(false);
    expect(logCalls.at(-1)?.problems).toBe(true);
  });
});

describe("faultsOf", () => {
  const base = { triggers: [], places: PLACES, titles: {}, now: NOW };

  it("lists nothing with no problem, an empty problem, or an empty disabledReason", () => {
    expect(faultsOf({ ...base, rules: [rule("R2"), rule("R4", { problem: "" })], triggers: [namedRoutine("S1"), namedRoutine("S3", "")], log: [] }).faults).toEqual([]);
  });

  it("lists one fault once: a line's problem and the dead delivery that caused it", () => {
    const broken = rule("R4", { problem: PIN_UNAVAILABLE, updatedAt: 1 });
    const log = [logItem("ev-1", NOW - 60_000, [delivery("dead", "R4")]), logItem("ev-2", NOW - 30_000, [delivery("dead", "R4")])];
    const { faults } = faultsOf({ ...base, rules: [broken], log });
    expect(faults.map((fault) => fault.kind)).toEqual(["line"]);
    expect(faults[0]!.text).toBe("The pinned thread is archived. Pick another thread:");
  });

  // Review Focus 1: a dead letter stored before the pin text changed still reads as a pin problem.
  it("renders a line with the old pin text as a pin problem", () => {
    const broken = rule("R4", { problem: PIN_UNAVAILABLE_LEGACY, updatedAt: 1 });
    const { faults } = faultsOf({ ...base, rules: [broken], log: [] });
    expect(faults.map((fault) => fault.text)).toEqual(["The pinned thread is archived. Pick another thread:"]);
  });

  it("skips a dead delivery that a later delivery settled", () => {
    const quiet = rule("R5", { updatedAt: 1 });
    const settled: EventDeliveryWire = { ...delivery("dead", "R5"), supersededBy: "d-redo" };
    const log = [logItem("ev-1", NOW - 60_000, [{ ...delivery("delivered", "R5"), id: "d-redo" }, settled])];
    expect(faultsOf({ ...base, rules: [quiet], log })).toEqual({ faults: [], faultedPlaces: new Set() });
    // The same dead row without supersededBy is a fault.
    expect(faultsOf({ ...base, rules: [quiet], log: [logItem("ev-1", NOW - 60_000, [delivery("dead", "R5")])] }).faults).toHaveLength(1);
  });

  it("drops the fault when a pick fixes the line after its dead delivery", () => {
    const fixed = rule("R4", { updatedAt: NOW });
    const log = [logItem("ev-1", NOW - 60_000, [delivery("dead", "R4")])];
    expect(faultsOf({ ...base, rules: [fixed], log })).toEqual({ faults: [], faultedPlaces: new Set() });
  });

  it("lists a dead delivery once per line, with its event", () => {
    const quiet = rule("R5", { updatedAt: 1 });
    const log = [
      logItem("ev-2", NOW - 30_000, [delivery("dead", "R5"), delivery("dead", "R-other")]),
      logItem("ev-1", NOW - 60_000, [delivery("dead", "R5")]),
    ];
    const { faults } = faultsOf({ ...base, rules: [quiet], log });
    expect(faults.map((fault) => (fault.kind === "delivery" ? [fault.subscriptionId, fault.eventId] : []))).toEqual([
      ["R5", "ev-2"],
      ["R-other", "ev-2"],
    ]);
    // A line this list does not hold leads with the event's place.
    expect(faults.map((fault) => (fault.kind === "delivery" ? fault.lead : null))).toEqual(["Everywhere in Slack,", "In acme/api#14,"]);
  });
});
