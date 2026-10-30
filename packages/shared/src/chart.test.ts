import { describe, expect, it } from "vitest";
import { chartAsMarkdown, chartProblem, readChart, type Chart } from "./chart.js";

const line: Chart = {
  title: "Support tickets opened",
  chart: {
    type: "line",
    series: [
      { name: "Email", data: [{ label: "Mon", value: 40 }, { label: "Tue", value: 52 }] },
      { name: "Chat", data: [{ label: "Mon", value: 25 }, { label: "Tue", value: 31 }] },
    ],
    axis_config: { categories: ["Mon", "Tue"], x_label: "Day", y_label: "Tickets" },
  },
};
const pie: Chart = { title: "Issues by priority", chart: { type: "pie", segments: [{ label: "High", value: 11 }, { label: "Low", value: 9 }] } };

describe("chartProblem", () => {
  it("accepts Slack's documented shapes", () => {
    expect(chartProblem(line)).toBeUndefined();
    expect(chartProblem(pie)).toBeUndefined();
    expect(readChart(line)).toBe(line);
  });

  it("enforces Slack's limits with a fix in each message", () => {
    expect(chartProblem({ ...line, title: "x".repeat(51) })).toMatch(/1 to 50 characters/);
    expect(chartProblem({ title: "t", chart: { type: "scatter" } })).toMatch(/pie, bar, area, or line/);
    const many = Array.from({ length: 21 }, (_, i) => `d${i}`);
    expect(chartProblem({ title: "t", chart: { type: "bar", series: [], axis_config: { categories: many } } })).toMatch(/Aggregate/);
    expect(chartProblem({ title: "t", chart: { type: "pie", segments: [{ label: "a", value: 0 }] } })).toMatch(/greater than 0/);
    expect(readChart({ title: "t" })).toBeUndefined();
  });

  it("needs every series to cover every category once", () => {
    const missing = { ...line, chart: { ...line.chart, series: [{ name: "Email", data: [{ label: "Mon", value: 1 }] }] } };
    expect(chartProblem(missing)).toMatch(/one point for each category/);
    const stray = { ...line, chart: { ...line.chart, series: [{ name: "Email", data: [{ label: "Mon", value: 1 }, { label: "Sun", value: 2 }] }] } };
    expect(chartProblem(stray)).toMatch(/axis_config.categories/);
    const email = { name: "Email", data: [{ label: "Mon", value: 1 }, { label: "Tue", value: 2 }] };
    const twice = { ...line, chart: { ...line.chart, series: [email, email] } };
    expect(chartProblem(twice)).toMatch(/unique/);
  });

  it("writes a Markdown table fallback", () => {
    expect(chartAsMarkdown(line)).toBe([
      "**Support tickets opened**", "", "| Day | Email | Chat |", "| --- | ---: | ---: |", "| Mon | 40 | 25 |", "| Tue | 52 | 31 |",
    ].join("\n"));
    expect(chartAsMarkdown(pie)).toContain("| High | 11 |");
  });
});
