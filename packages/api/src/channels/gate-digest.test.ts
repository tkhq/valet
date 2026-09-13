import { describe, expect, it } from "vitest";
import { digestGate, safeChannelActions } from "./gate-digest.js";

const TOOL_GATE = {
  type: "approval" as const,
  title: "Approve Create PR?",
  body: 'Open a PR\n\ntool_id=github.create_pr\nargs={"title":"fix"}',
  context: {
    riskLevel: "high",
    service: "github",
    tool_id: "github.create_pr",
    args: { repo: "tkhq/tk-brain", title: "fix", draft: false },
    summary: "Open a PR on tk-brain",
  },
};

describe("digestGate", () => {
  it("replaces a tool gate's JSON body with the summary and labeled fields", () => {
    const digest = digestGate(TOOL_GATE);
    expect(digest.title).toBe("Approve Create PR?");
    expect(digest.body).toBe("Open a PR on tk-brain");
    expect(digest.body).not.toContain("args=");
    expect(digest.fields).toEqual([
      { label: "Tool", value: "`github.create_pr`" },
      { label: "Risk", value: "high" },
      { label: "repo", value: "tkhq/tk-brain" },
      { label: "title", value: "fix" },
      { label: "draft", value: "false" },
      { label: "Review", value: "Incomplete. Reject and ask the agent to retry with a smaller request." },
    ]);
    expect(digest.reviewIncomplete).toBe(true);
  });

  it("renders structured arg values as bounded single-line JSON", () => {
    const digest = digestGate({
      ...TOOL_GATE,
      context: { ...TOOL_GATE.context, args: { labels: ["bug", "p1"], long: "x".repeat(300) } },
    });
    expect(digest.fields).toContainEqual({ label: "labels", value: '`["bug","p1"]`' });
    const long = digest.fields?.find((f) => f.label === "long");
    expect(long?.value.length).toBeLessThanOrEqual(120);
    expect(long?.value.endsWith("…")).toBe(true);
  });

  it("caps arg fields and reports the overflow", () => {
    const args = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, i]));
    const digest = digestGate({ ...TOOL_GATE, context: { ...TOOL_GATE.context, args } });
    // Tool + Risk + 8 args + overflow note.
    expect(digest.fields).toHaveLength(12);
    expect(digest.fields).toContainEqual({ label: "More", value: "+3 more parameters in Valet" });
    expect(digest.reviewIncomplete).toBe(true);
  });

  it("falls back to naming the tool when the gate carries no summary, rather than dumping JSON or going blank", () => {
    const digest = digestGate({ ...TOOL_GATE, context: { ...TOOL_GATE.context, summary: "  " } });
    expect(digest.body).toBe("Requested: `github.create_pr`");
    expect(digest.fields?.[0]).toEqual({ label: "Tool", value: "`github.create_pr`" });
  });

  it("swaps embedded backticks in JSON values so they cannot break the code span", () => {
    const digest = digestGate({
      ...TOOL_GATE,
      context: { ...TOOL_GATE.context, args: { cmd: ["echo `whoami`"] } },
    });
    expect(digest.fields).toContainEqual({ label: "cmd", value: '`["echo ʼwhoamiʼ"]`' });
  });

  it("bounds arg labels so a runaway key cannot blow a transport's field cap", () => {
    const digest = digestGate({
      ...TOOL_GATE,
      context: { ...TOOL_GATE.context, args: { ["k".repeat(200)]: 1 } },
    });
    const label = digest.fields?.find((field) => field.label.startsWith("k"))?.label ?? "";
    expect(label.length).toBeLessThanOrEqual(60);
    expect(label.endsWith("…")).toBe(true);
  });

  it("marks a truncated preview incomplete when an early long field hides recipient and amount", () => {
    const argsPreview = JSON.stringify({ note: "x".repeat(500), recipient: "later@example.test", amount: 2500 });
    const digest = digestGate({
      ...TOOL_GATE,
      context: { ...TOOL_GATE.context, args: undefined, argsPreview },
    });
    expect(digest.fields?.find((field) => field.label === "Parameters")?.value).not.toContain("recipient");
    expect(digest.reviewIncomplete).toBe(true);
    expect(safeChannelActions({ ...TOOL_GATE, actions: [
      { id: "approve", label: "Approve", approves: true },
      { id: "deny", label: "Reject" },
    ] }, digest.reviewIncomplete === true).map((action) => action.id)).toEqual(["deny"]);
    expect(digest.fields).toContainEqual({
      label: "Review",
      value: "Incomplete. Reject and ask the agent to retry with a smaller request.",
    });
  });

  it("passes a gate without tool context through untouched (ask_approval)", () => {
    const digest = digestGate({
      type: "approval",
      title: "Delete the staging database?",
      body: "This cannot be undone.",
      context: undefined,
    });
    expect(digest).toEqual({ title: "Delete the staging database?", body: "This cannot be undone." });
  });

  it("passes non-approval gates through untouched", () => {
    const digest = digestGate({
      type: "question",
      title: "Which region?",
      body: "Pick one.",
      context: { tool_id: "irrelevant" },
    });
    expect(digest).toEqual({ title: "Which region?", body: "Pick one." });
  });
});
