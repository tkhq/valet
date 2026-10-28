import { describe, expect, it } from "vitest";
import { planProgress, readThreadPlan, readTurnPlans, THREAD_PLAN_KEY } from "./thread-plan.js";

const items = [
  { text: "Read the failing test", status: "done" },
  { text: "Fix the parser", status: "in_progress" },
  { text: "Run the suite", status: "pending" },
] as const;

describe("readThreadPlan", () => {
  it("reads a stored plan and drops fields it does not know", () => {
    const stored = { items: items.map((item) => ({ ...item, extra: true })), updatedAt: 5 };
    expect(readThreadPlan({ [THREAD_PLAN_KEY]: stored })).toEqual({ items, updatedAt: 5 });
  });

  it.each([
    ["no metadata", undefined],
    ["no plan", { other: 1 }],
    ["a string", { plan: "steps" }],
    ["no items", { plan: { items: [], updatedAt: 1 } }],
    ["no time", { plan: { items } }],
    ["a bad time", { plan: { items, updatedAt: Number.NaN } }],
    ["an unknown status", { plan: { items: [{ text: "Ship", status: "blocked" }], updatedAt: 1 } }],
    ["blank text", { plan: { items: [{ text: "  ", status: "pending" }], updatedAt: 1 } }],
    ["long text", { plan: { items: [{ text: "x".repeat(201), status: "pending" }], updatedAt: 1 } }],
    ["too many items", { plan: { items: Array.from({ length: 21 }, () => ({ text: "Step", status: "pending" })), updatedAt: 1 } }],
    ["a null item", { plan: { items: [null], updatedAt: 1 } }],
  ])("returns undefined for %s", (_name, metadata) => {
    expect(readThreadPlan(metadata)).toBeUndefined();
  });
});

describe("planProgress", () => {
  it("counts done items and names the current one", () => {
    expect(planProgress({ items: [...items] })).toEqual({ done: 1, total: 3, current: "Fix the parser" });
  });

  it("names no current item when none is in progress", () => {
    expect(planProgress({ items: [{ text: "Ship", status: "done" }] })).toEqual({ done: 1, total: 1 });
  });
});

describe("turn plan metadata", () => {
  it("preserves optional IDs and turn correlation while accepting legacy plans", () => {
    const plan = { items: [{ id: "stable", text: "Step", status: "pending" }], turnId: "turn", updatedAt: 2 };
    expect(readThreadPlan({ plan })).toEqual(plan);
    expect(readThreadPlan({ plan: { items, updatedAt: 2 } })?.turnId).toBeUndefined();
  });
  it("reads a public title and drops invalid titles without losing the plan", () => {
    expect(readThreadPlan({ plan: { title: "Fix parser", items, updatedAt: 2 } })?.title).toBe("Fix parser");
    for (const title of [" ", "x".repeat(201), 42]) {
      expect(readThreadPlan({ plan: { title, items, updatedAt: 2 } })).toEqual({ items, updatedAt: 2 });
    }
  });
  it("bounds history to eight valid turn plans", () => {
    const history = Array.from({ length: 12 }, (_, index) => ({ turnId: String(index), items, updatedAt: index }));
    expect(readTurnPlans({ turnPlans: [null, ...history, { items, updatedAt: 20 }] }).map((plan) => plan.turnId)).toEqual(["4", "5", "6", "7", "8", "9", "10", "11"]);
  });
});
