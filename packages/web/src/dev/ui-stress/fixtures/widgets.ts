/** Widgets as the assistant writes them with `show_widget`: the cards from
 * the generative-UI demo (transactions, meeting memory, a new event), a
 * status list, an activity grid, and charts, plus one at the catalog's limits. */
import type { WidgetSpec } from "@valet/api/widgets";
import { STRING_2000, TITLE_400 } from "./common";

export const transactionsWidget: WidgetSpec = {
  root: "card",
  elements: {
    card: { type: "Card", props: { title: "Transactions", subtitle: "Transportation · September" }, children: ["stat", "table"] },
    stat: { type: "Stat", props: { label: "Spent", value: "$538.70", detail: "3 transactions · $18.70 the month before", trend: "up" }, children: [] },
    table: {
      type: "Table",
      props: {
        columns: [{ key: "merchant", label: "Merchant" }, { key: "card", label: "Card" }, { key: "date", label: "Date" }, { key: "amount", label: "Amount", align: "right" }],
        rows: [
          { merchant: "Uber", card: "Travel ••4242", date: "4 Sep", amount: "$31.20" },
          { merchant: "Deutsche Bahn", card: "Travel ••4242", date: "8 Sep", amount: "$78.90" },
          { merchant: "United Airlines", card: "Travel ••4242", date: "19 Sep", amount: "$428.60" },
        ],
      },
      children: [],
    },
  },
};

export const meetingMemoryWidget: WidgetSpec = {
  root: "card",
  elements: {
    card: { type: "Card", props: { title: "Meeting memory", subtitle: "Fireflies · 2 meetings" }, children: ["q1", "rule", "q2"] },
    q1: { type: "Quote", props: { text: "The starter plan should feel generous enough to become the default. Paid tiers earn their price through collaboration.", speaker: "Teammate", time: "16 Oct · 14:22", source: "Product review", takeaway: "keep starter generous; monetize collaboration" }, children: [] },
    rule: { type: "Divider", props: {}, children: [] },
    q2: { type: "Quote", props: { text: "For dinner I'd book Prado on Thursday. It feels special without being formal.", speaker: "Teammate", time: "14 Oct · 09:10", source: "Lisbon trip planning", takeaway: "book Prado, Thursday" }, children: [] },
  },
};

export const eventWidget: WidgetSpec = {
  root: "card",
  elements: {
    card: { type: "Card", props: { title: "New event" }, children: ["event", "actions"] },
    event: { type: "Event", props: { title: "Teammate and me", start: "Tue 27 Oct, 16:00", end: "16:30", location: "Google Meet", attendees: ["Teammate", "You"], note: "Your 15:00 to 16:00 focus block stays." }, children: [] },
    actions: { type: "Stack", props: { direction: "row", gap: "sm" }, children: ["send", "change"] },
    send: { type: "Button", props: { label: "Send invite", reply: "Send the invite.", primary: true }, children: [] },
    change: { type: "Button", props: { label: "Pick another time", reply: "Find another time this week." }, children: [] },
  },
};

export const statusWidget: WidgetSpec = {
  root: "card",
  elements: {
    card: { type: "Card", props: { title: "Release checklist" }, children: ["progress", "list"] },
    progress: { type: "Progress", props: { label: "Done", value: 60, detail: "3 of 5" }, children: [] },
    list: {
      type: "List",
      props: {
        items: [
          { title: "Approve the migration", subtitle: "Waiting on you since 09:40", status: "needs_you" },
          { title: "Run the canary", status: "working", meta: "12m" },
          { title: "Tag v0.3.6", status: "done" },
          { title: "Push the hotfix", subtitle: "403 from GitHub", status: "failed" },
        ],
      },
      children: [],
    },
  },
};

export const activityWidget: WidgetSpec = {
  root: "card",
  elements: {
    card: { type: "Card", props: { title: "Valet this year" }, children: ["grid", "facts"] },
    grid: { type: "Heatmap", props: { values: Array.from({ length: 300 }, (_, i) => (i * 37 % 11 > 6 ? (i * 13) % 9 : 0)), label: "32 requests in the past week" }, children: [] },
    facts: { type: "KeyValue", props: { items: [{ label: "Sent", value: "1 email" }, { label: "Viewed", value: "3 emails" }, { label: "Blocked", value: "16 actions" }] }, children: [] },
  },
};

const weeks = ["Sep 15", "Sep 22", "Sep 29", "Oct 6", "Oct 13", "Oct 20"];
const weekly = (name: string, values: number[]) => ({ name, data: weeks.map((label, i) => ({ label, value: values[i]! })) });

/** Charts in Slack's data_visualization shape: grouped bars, lines, and a pie. */
export const chartsWidget: WidgetSpec = {
  root: "card",
  elements: {
    card: { type: "Card", props: { title: "Engineering this month" }, children: ["bars", "lines", "pie"] },
    bars: { type: "Chart", props: { title: "Merged pull requests per week", chart: {
      type: "bar", series: [weekly("Platform", [12, 15, 18, 9, 14, 16]), weekly("Web", [7, 9, 11, 14, 8, 12])],
      axis_config: { categories: weeks, y_label: "Pull requests" },
    } }, children: [] },
    lines: { type: "Chart", props: { title: "Daily model spend (USD)", chart: {
      type: "area", series: [weekly("Opus", [410, 520, 470, 610, 580, 640]), weekly("Sonnet", [120, 140, 135, 150, 160, 170])],
      axis_config: { categories: weeks },
    } }, children: [] },
    pie: { type: "Chart", props: { title: "Open issues by priority", chart: {
      type: "pie", segments: [{ label: "Urgent", value: 4 }, { label: "High", value: 11 }, { label: "Medium", value: 23 }, { label: "Low", value: 9 }],
    } }, children: [] },
  },
};

/** Long text everywhere a string goes: the cards must wrap, not overflow. */
export const stressWidget: WidgetSpec = {
  root: "card",
  elements: {
    card: { type: "Card", props: { title: TITLE_400, subtitle: TITLE_400 }, children: ["text", "badge", "kv"] },
    text: { type: "Text", props: { text: STRING_2000.slice(0, 600) }, children: [] },
    badge: { type: "Badge", props: { text: TITLE_400.slice(0, 60), tone: "warning" }, children: [] },
    kv: { type: "KeyValue", props: { items: [{ label: TITLE_400.slice(0, 80), value: STRING_2000.slice(0, 300) }] }, children: [] },
  },
};

export const galleryWidgets = [
  { label: "Transactions", spec: transactionsWidget },
  { label: "Meeting memory", spec: meetingMemoryWidget },
  { label: "New event with buttons", spec: eventWidget },
  { label: "Status list and progress", spec: statusWidget },
  { label: "Activity grid", spec: activityWidget },
  { label: "Charts", spec: chartsWidget },
  { label: "Long text", spec: stressWidget },
];
