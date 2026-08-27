// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { SpendChart, isLabeledBar } from "./SpendChart";

describe("isLabeledBar", () => {
  it("always labels the most recent (last) bar", () => {
    for (const count of [1, 2, 7, 8, 30]) {
      expect(isLabeledBar(count - 1, count)).toBe(true);
    }
  });

  it("never labels two adjacent bars (so labels cannot overlap)", () => {
    const count = 30;
    for (let i = 0; i < count - 1; i++) {
      expect(isLabeledBar(i, count) && isLabeledBar(i + 1, count)).toBe(false);
    }
  });

  it("thins to every other bar, anchored to the end", () => {
    const count = 8;
    const labeled = Array.from({ length: count }, (_, i) => i).filter((i) => isLabeledBar(i, count));
    expect(labeled).toEqual([1, 3, 5, 7]);
  });
});

describe("SpendChart", () => {
  const buckets = Array.from({ length: 8 }, (_, i) => ({ dayMs: 1_700_000_000_000 + i * 86_400_000, costUsd: i }));

  it("draws every bar but thins the labels so they do not collide", () => {
    const { container } = render(<SpendChart buckets={buckets} />);
    const rects = container.querySelectorAll("svg[aria-label='Daily spend chart'] rect");
    const labels = container.querySelectorAll("svg[aria-label='Daily spend chart'] text");
    expect(rects.length).toBe(8); // one bar per bucket
    expect(labels.length).toBeLessThan(rects.length); // fewer labels than bars
    expect(labels.length).toBe(4); // every other bar
    // Every bar keeps a hover tooltip regardless of whether it shows a label.
    expect(container.querySelectorAll("svg[aria-label='Daily spend chart'] title").length).toBe(8);
  });

  it("renders a flat baseline (zero-height bars) when every day is zero spend", () => {
    const zero = [0, 1, 2].map((i) => ({ dayMs: 1_700_000_000_000 + i * 86_400_000, costUsd: 0 }));
    const { container } = render(<SpendChart buckets={zero} />);
    const rects = container.querySelectorAll("svg[aria-label='Daily spend chart'] rect");
    expect(rects.length).toBe(3);
    // No 2px stub bars for zero spend: every bar is flat.
    for (const rect of rects) expect(rect.getAttribute("height")).toBe("0");
  });

  it("fills the width responsively: SVG is 100% wide and bars are positioned by percentage", () => {
    const { container } = render(<SpendChart buckets={buckets} />);
    const svg = container.querySelector("svg[aria-label='Daily spend chart']");
    expect(svg?.getAttribute("width")).toBe("100%");
    const rects = container.querySelectorAll("svg[aria-label='Daily spend chart'] rect");
    // Every bar's x is a percentage of the width, so few bars spread out instead
    // of bunching at the left edge.
    for (const rect of rects) expect(rect.getAttribute("x")).toMatch(/%$/);
  });

  it("labels the bucket's UTC day, not the viewer's local-timezone day", () => {
    // dayMs is a UTC midnight (byDay floors created_at to a UTC day). Aug 26
    // 00:00 UTC is still Aug 25 in any timezone west of UTC, so a local-time
    // label would read "25". The label must read the UTC day, "26".
    const dayMs = Date.UTC(2024, 7, 26);
    const { container } = render(<SpendChart buckets={[{ dayMs, costUsd: 5 }]} />);
    const label = container.querySelector("svg[aria-label='Daily spend chart'] text")?.textContent ?? "";
    expect(label).toMatch(/\b26\b/);
  });
});
