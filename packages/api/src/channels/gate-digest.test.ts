import { describe, expect, it } from "vitest";
import { digestGate } from "./gate-digest.js";

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
    ]);
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
    expect(digest.fields).toHaveLength(11);
    expect(digest.fields?.at(-1)).toEqual({ label: "More", value: "+3 more parameters in Valet" });
  });

  it("omits the body when the gate carries no summary, rather than dumping JSON", () => {
    const digest = digestGate({ ...TOOL_GATE, context: { ...TOOL_GATE.context, summary: "  " } });
    expect(digest.body).toBeUndefined();
    expect(digest.fields?.[0]).toEqual({ label: "Tool", value: "`github.create_pr`" });
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
