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
});
