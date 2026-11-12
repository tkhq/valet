import { describe, expect, it } from "vitest";
import { WIDGET_TOOL_DESCRIPTION, WIDGET_TOOL_NAME, widgetSpecProblems } from "./catalog.js";
import { Value } from "typebox/value";
import { buildHomeTools } from "../home/tools.js";
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
    const problems = widgetSpecProblems({ root: "a", elements: { a: { type: "Gauge", props: {}, children: [] } } });
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

  it("rejects direct and indirect cycles", () => {
    expect(widgetSpecProblems({ root: "a", elements: { a: { type: "Card", props: {}, children: ["a"] } } })).toMatch(/cycle/);
    expect(widgetSpecProblems({ root: "a", elements: {
      a: { type: "Card", props: {}, children: ["b"] }, b: { type: "Stack", props: {}, children: ["a"] },
    } })).toMatch(/cycle/);
  });

  it("bounds nesting and repeated subtree expansion", () => {
    const chain = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [String(i), { type: "Card", props: {}, children: i < 39 ? [String(i + 1)] : [] }]));
    expect(widgetSpecProblems({ root: "0", elements: chain })).toMatch(/nesting/);
    const doubling = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [String(i), { type: "Card", props: {}, children: i < 9 ? [String(i + 1), String(i + 1)] : [] }]));
    expect(widgetSpecProblems({ root: "0", elements: doubling })).toMatch(/expanded/);
  });

  it.each([{ statePath: "/rows" }, null])("rejects repeat instructions before rendering (%j)", repeat => {
    expect(widgetSpecProblems({ root: "a", state: { rows: Array(10).fill("row") }, elements: {
      a: { type: "Card", props: {}, children: ["b"], repeat },
      b: { type: "Text", props: { text: "Row" }, children: [] },
    } })).toMatch(/repeat/i);
  });
});

const chartCard = {
  root: "c",
  elements: { c: { type: "Chart", props: { title: "Merged PRs", chart: {
    type: "bar",
    series: [{ name: "Web", data: [{ label: "Oct 6", value: 7 }, { label: "Oct 13", value: 11 }] }],
    axis_config: { categories: ["Oct 6", "Oct 13"] },
  } }, children: [] } },
};

describe("Chart card", () => {
  it("accepts a chart in Slack's shape and refuses what Slack would refuse", () => {
    expect(widgetSpecProblems(chartCard)).toBeUndefined();
    const scatter = { ...chartCard, elements: { c: { ...chartCard.elements.c, props: { title: "x", chart: { type: "scatter" } } } } };
    expect(widgetSpecProblems(scatter)).toMatch(/elements\.c\.props: Set chart.type to pie, bar, area, or line/);
    expect(WIDGET_TOOL_DESCRIPTION).toContain("slack.reply_to_origin");
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

  it("tells a Slack turn to post charts with reply_to_origin", async () => {
    const result = await tool!.execute({ spec: chartCard } as never, { origin: { channelType: "slack", threadKey: "slack:C1:1.2" } } as never);
    expect(result.text).toContain("slack.reply_to_origin");
    expect(result.ok).toBeUndefined();
  });

  it("returns what to fix, as an action failure the model reads", async () => {
    const result = await tool!.execute({ spec: { root: "a", elements: { a: { type: "Gauge", props: {}, children: [] } } } } as never, {} as never);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("call show_widget again");
  });
});

describe("show_brief", () => {
  const brief = buildWidgetTools().find((tool) => tool.name === "show_brief");
  const args = {
    headline: "Morning. 1 in progress, 2 need you.",
    items: [
      { topic: "10 AM overlap", text: "Sales kickoff overlaps the walkthrough.", state: "needs_you" },
      { topic: "Composer hint", text: "Show the hint only while typing?", state: "needs_you", href: "https://github.com/example/app/pull/12" },
      { topic: "Sweep", text: "The action-item sweep is running.", state: "working", thread_id: "th-1" },
      { topic: "Notes", text: "Posted.", state: "done" },
    ],
  };

  it("ships beside show_widget, so every assistant thread can show a brief", () => {
    expect(brief).toBeDefined();
    // A personal assistant also loads the Home tools; two tools with one name would clash.
    expect(buildHomeTools(() => { throw new Error("unused"); }).map((tool) => tool.name)).not.toContain("show_brief");
    expect(brief!.description).toContain("what needs them, or for the status of several pieces of work");
    expect(brief!.description).toContain("Use a Markdown table or show_widget for other rows of data");
  });

  it("accepts web links and refuses another scheme", () => {
    expect(Value.Check(brief!.parameters, args)).toBe(true);
    const script = { ...args, items: [{ topic: "x", text: "y", state: "fyi", href: "javascript:alert(1)" }] };
    expect(Value.Check(brief!.parameters, script)).toBe(false);
  });

  it("confirms a web turn in one line", async () => {
    const result = await brief!.execute(args as never, {} as never);
    expect(result.text).toBe("Brief shown: Morning. 1 in progress, 2 need you. (4 items). The card is the answer: write nothing after it.");
  });

  it("gives a Slack turn the brief as Markdown to post", async () => {
    const result = await brief!.execute(args as never, { origin: { channelType: "slack", threadKey: "slack:C1:1.2" } } as never);
    expect(result.ok).toBeUndefined();
    expect(result.text).toContain("call_tool slack.reply_to_origin");
    expect(result.text.split(":\n\n")[1]).toBe([
      "**Morning. 1 in progress, 2 need you.**",
      "- 🟠 **10 AM overlap:** Sales kickoff overlaps the walkthrough.",
      "- 🟠 **Composer hint:** Show the hint only while typing? [Open](https://github.com/example/app/pull/12)",
      "- 🔵 **Sweep:** The action-item sweep is running.",
      "- 🟢 **Notes:** Posted.",
    ].join("\n"));
  });

  it("gives another channel the same text", async () => {
    const result = await brief!.execute(args as never, { origin: { channelType: "email", threadKey: "email:1" } } as never);
    expect(result.text).toContain("Answer there with this text instead");
    expect(result.text).toContain("- 🔵 **Sweep:** The action-item sweep is running.");
  });
});
