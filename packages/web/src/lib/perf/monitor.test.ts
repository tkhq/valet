import { describe, expect, it } from "vitest";
import { MEASUREMENT_CAPACITY, PerfMonitor, RingBuffer, type MonitorClock } from "./monitor";
import { budgetFor, DATA_BUDGETS, FEEDBACK_BUDGET_MS, LOADING_STATE_BUDGET_MS } from "./budgets";

/** A clock whose frames paint only when the test says so. */
function fakeClock() {
  let now = 0;
  let queue: (() => void)[] = [];
  const clock: MonitorClock = { now: () => now, afterPaint: (fn) => { queue.push(fn); } };
  return {
    clock,
    advance(ms: number) { now += ms; },
    /** Paints one frame `ms` later and runs what waited for it. */
    paint(ms = 16) {
      now += ms;
      const due = queue;
      queue = [];
      for (const fn of due) fn();
    },
  };
}

describe("RingBuffer", () => {
  it("keeps the newest items up to its capacity", () => {
    const ring = new RingBuffer<number>(3);
    for (let i = 0; i < 5; i++) ring.push(i);
    expect(ring.toArray()).toEqual([2, 3, 4]);
  });
});

describe("PerfMonitor", () => {
  it("times a press to the next paint", () => {
    const t = fakeClock();
    const monitor = new PerfMonitor(t.clock);
    t.advance(1000);
    monitor.press("button:Save", 1000, false);
    t.paint(40);
    expect(monitor.entries()).toEqual([{ kind: "interaction", flow: "button:Save", at: 1000, ms: 40, budget: FEEDBACK_BUDGET_MS }]);
  });

  it("takes the browser's event timing when it is longer", () => {
    const t = fakeClock();
    const monitor = new PerfMonitor(t.clock);
    monitor.press("button:Save", 0, false);
    t.paint(20);
    monitor.eventTiming(0, 64);
    monitor.eventTiming(0, 8);
    expect(monitor.entries()[0]?.ms).toBe(64);
  });

  it("times a navigation from the press that started it, to its route paint and its data", () => {
    const t = fakeClock();
    const monitor = new PerfMonitor(t.clock);
    monitor.press("a:Thread 3", 0, false);
    t.advance(30);
    monitor.navigationStart();
    monitor.navigationRendered("thread.open");
    monitor.queryLoading("messages");
    t.paint(50); // press and route paint at 80
    t.advance(100);
    monitor.querySettled("messages"); // at 180
    t.paint(20); // first quiet paint at 200
    t.paint();
    t.paint();
    t.paint();
    const byKind = Object.fromEntries(monitor.entries().map((m) => [m.kind, m]));
    expect(byKind.route).toMatchObject({ flow: "thread.open", at: 0, ms: 80, budget: LOADING_STATE_BUDGET_MS });
    expect(byKind.data).toMatchObject({ flow: "thread.open", at: 0, ms: 200, budget: DATA_BUDGETS["thread.open"] });
  });

  it("waits for a load that starts in the frames after the route paint", () => {
    const t = fakeClock();
    const monitor = new PerfMonitor(t.clock);
    monitor.navigationStart();
    monitor.navigationRendered("workflows.open");
    t.paint(50); // route at 50, settle check queued
    monitor.queryLoading("workflows");
    t.paint();
    t.paint();
    expect(monitor.entries().map((m) => m.kind)).toEqual(["route"]);
    t.advance(100);
    monitor.querySettled("workflows");
    t.paint();
    t.paint();
    t.paint();
    expect(monitor.entries().at(-1)).toMatchObject({ kind: "data", flow: "workflows.open" });
  });

  it("drops an unsettled flow when a newer one starts", () => {
    const t = fakeClock();
    const monitor = new PerfMonitor(t.clock);
    monitor.navigationStart();
    monitor.navigationRendered("presence.open");
    monitor.queryLoading("slow");
    t.paint();
    monitor.navigationStart();
    monitor.navigationRendered("integrations.open");
    monitor.querySettled("slow");
    for (let i = 0; i < 4; i++) t.paint();
    const data = monitor.entries().filter((m) => m.kind === "data").map((m) => m.flow);
    expect(data).toEqual(["integrations.open"]);
  });

  it("keeps a bounded number of measurements", () => {
    const t = fakeClock();
    const monitor = new PerfMonitor(t.clock);
    for (let i = 0; i < MEASUREMENT_CAPACITY + 10; i++) monitor.press("button:x", i, false);
    expect(monitor.entries()).toHaveLength(MEASUREMENT_CAPACITY);
  });
});

describe("budgetFor", () => {
  it("gives presses the feedback budget, navigations the loading-state budget, and data its flow's budget", () => {
    expect(budgetFor("interaction", "message.send")).toBe(FEEDBACK_BUDGET_MS);
    expect(budgetFor("route", "thread.open")).toBe(LOADING_STATE_BUDGET_MS);
    expect(budgetFor("data", "workflows.open")).toBe(DATA_BUDGETS["workflows.open"]);
    expect(budgetFor("data", "route:/usage")).toBe(LOADING_STATE_BUDGET_MS);
  });
});
