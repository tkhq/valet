import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Chart } from "@valet/shared";
import { ChartView, niceTicks } from "./chart-view";

const MAX = Number.MAX_VALUE;
const MIN = Number.MIN_VALUE;

/** The data's [min, max] at the edges of the float range: overflow at the top, underflow at the bottom. */
const EXTREMES: [name: string, low: number, high: number][] = [
  ["-MAX..MAX", -MAX, MAX],
  ["0..MAX", 0, MAX],
  ["-MAX..0", -MAX, 0],
  ["-MIN..MIN", -MIN, MIN],
  ["0..MIN", 0, MIN],
  ["-MIN..0", -MIN, 0],
  ["MIN..MAX", MIN, MAX],
  ["-MAX..-MIN", -MAX, -MIN],
];

function axisChart(type: "bar" | "line" | "area", values: number[]): Chart {
  const categories = values.map((_, i) => `p${i}`);
  return {
    title: "Extremes",
    chart: { type, series: [{ name: "A", data: values.map((value, i) => ({ label: categories[i]!, value })) }], axis_config: { categories } },
  };
}

const markup = (chart: Chart) => renderToStaticMarkup(createElement(ChartView, chart));

/** Each SVG attribute that holds NaN or Infinity, or a vertical position outside the 220px chart. */
function badAttributes(html: string): string[] {
  const bad: string[] = [];
  for (const [attr, name, value] of html.matchAll(/\s([\w-]+)="([^"]*)"/g)) {
    if (/NaN|Infinity/.test(value!)) bad.push(attr.trim());
    const vertical = name === "points" ? value!.split(" ").map((pair) => pair.split(",")[1]!) : ["y", "y1", "y2", "cy", "height"].includes(name!) ? [value!] : [];
    if (vertical.some((v) => !(Number(v) >= 0 && Number(v) <= 220))) bad.push(attr.trim());
  }
  return bad;
}

describe("niceTicks", () => {
  it("covers the data with round steps from zero", () => {
    expect(niceTicks(7, 18)).toEqual([0, 5, 10, 15, 20]);
    expect(niceTicks(120, 640)).toEqual([0, 200, 400, 600, 800]);
  });
  it("spans negative values and a flat series", () => {
    expect(niceTicks(-30, 45)).toEqual([-40, -20, 0, 20, 40, 60]);
    expect(niceTicks(0, 0)).toEqual([0, 1]);
  });
  it("ends for values near Number.MAX_VALUE", () => {
    expect(niceTicks(1, MAX)).toEqual([0, MAX]);
    expect(niceTicks(-MAX, 0)).toEqual([-MAX, 0]);
  });
  it.each(EXTREMES)("gives finite ascending ticks that cover %s", (_, low, high) => {
    const ticks = niceTicks(low, high);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks.every(Number.isFinite)).toBe(true);
    expect(ticks.every((t, i) => i === 0 || t > ticks[i - 1]!)).toBe(true);
    expect(ticks[0]).toBeLessThanOrEqual(Math.min(0, low));
    expect(ticks.at(-1)).toBeGreaterThanOrEqual(Math.max(0, high));
  });
});

describe("ChartView", () => {
  // The bare tick range [-MAX, MAX] made (v - lo) / (hi - lo) Infinity / Infinity.
  it("draws -MAX and MAX in one bar chart at the plot's bottom and top", () => {
    const html = markup(axisChart("bar", [-MAX, MAX]));
    expect(badAttributes(html)).toEqual([]);
    const tops = [...html.matchAll(/<rect [^>]*y="([^"]+)"[^>]*height="([^"]+)"/g)].map(([, y, h]) => [Number(y), Number(y) + Number(h)]);
    expect(tops).toEqual([[102, 196], [8, 102]]);
  });

  it.each(EXTREMES.flatMap(([name, low, high]) => (["bar", "line", "area"] as const).map((type) => [name, type, low, high] as const)))(
    "draws %s as a %s chart with finite positions inside the plot",
    (_, type, low, high) => {
      expect(badAttributes(markup(axisChart(type, [low, high, low / 2 + high / 2])))).toEqual([]);
    },
  );

  it.each([["MAX, MAX", MAX, MAX, "50%"], ["MIN, MIN", MIN, MIN, "50%"], ["MIN, MAX", MIN, MAX, "100%"]] as const)(
    "gives pie shares for %s without overflow",
    (_, a, b, share) => {
      const html = markup({ title: "Share", chart: { type: "pie", segments: [{ label: "a", value: a }, { label: "b", value: b }] } });
      expect(badAttributes(html)).toEqual([]);
      expect(html.match(/<title>b: [^<]*\((\d+%)\)<\/title>/)?.[1]).toBe(share);
    },
  );
});
