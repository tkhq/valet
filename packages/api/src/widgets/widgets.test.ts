import { describe, expect, it } from "vitest";
import { WIDGET_TOOL_DESCRIPTION, WIDGET_TOOL_NAME, widgetSpecProblems } from "./catalog.js";
import { buildWidgetTools } from "./tools.js";

const transactions = {
  root: "card",
  elements: {
    card: { type: "Card", props: { title: "Transactions" }, children: ["stat", "table"] },
    stat: { type: "Stat", props: { label: "Spent on transportation last month", value: "$538.70", detail: "$18.70 the month before" }, children: [] },
    table: {
      type: "Table",
      props: {
        columns: [{ key: "merchant", label: "Merchant" }, { key: "amount", label: "Amount", align: "right" }],
        rows: [{ merchant: "Uber", amount: "$31.20" }, { merchant: "United Airlines", amount: "$428.60" }],
      },
      children: [],
    },
  },
};

describe("widget catalog", () => {
  it("accepts a spec that uses its components", () => {
    expect(widgetSpecProblems(transactions)).toBeUndefined();
  });

  it("names a component it does not have, and a missing prop", () => {
    const problems = widgetSpecProblems({ root: "a", elements: { a: { type: "Chart", props: {}, children: [] } } });
    expect(problems).toContain("call show_widget again");
    expect(problems).toMatch(/elements\.a/);
    expect(widgetSpecProblems({ root: "a", elements: { a: { type: "Stat", props: { label: "x" }, children: [] } } })).toMatch(/value/);
  });

  it("names a child or root that is not in the spec", () => {
    expect(widgetSpecProblems({ root: "a", elements: { a: { type: "Card", props: {}, children: ["ghost"] } } })).toMatch(/ghost/);
    expect(widgetSpecProblems({ root: "nope", elements: { a: { type: "Divider", props: {}, children: [] } } })).toMatch(/nope/);
  });

  it("describes every component in the tool description", () => {
    for (const name of ["Card", "Stat", "Table", "Quote", "Event", "Heatmap", "Button"]) expect(WIDGET_TOOL_DESCRIPTION).toContain(`- ${name}(`);
    expect(WIDGET_TOOL_DESCRIPTION).toContain("Quote(text, speaker, time?, source?, takeaway?)");
  });
});

describe("show_widget", () => {
  const [tool] = buildWidgetTools();

  it("confirms a good spec and says not to repeat it", async () => {
    expect(tool!.name).toBe(WIDGET_TOOL_NAME);
    const result = await tool!.execute({ title: "Transactions", spec: transactions } as never, {} as never);
    expect(result.ok).toBeUndefined();
    expect(result.text).toContain("Don't repeat");
  });

  it("returns what to fix, as an action failure the model reads", async () => {
    const result = await tool!.execute({ spec: { root: "a", elements: { a: { type: "Chart", props: {}, children: [] } } } } as never, {} as never);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("call show_widget again");
  });
});
