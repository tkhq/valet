import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "../editor-model";
import { buildSteps, humanize, modelLabel, pathLabel } from "./steps-model";

const names = { service: (s: string) => s[0]!.toUpperCase() + s.slice(1), model: modelLabel };

const digest: WorkflowDefinition = {
  version: "dag/v1",
  nodes: [
    { id: "post", type: "tool", service: "slack", action: "send_message", params: { text: "{{ nodes.summarize.result.output.digest }}" } },
    { id: "start", type: "trigger", dataSchema: { since: { type: "string", label: "Since" } } },
    { id: "summarize", type: "llm", model: "claude-sonnet-4-5", prompt: "Notes since {{ trigger.data.since }}",
      outputSchema: { type: "object", properties: { digest: { type: "string" } } } },
    { id: "is_ok", type: "if", conditions: [{ left: "nodes.summarize.result.output.ok", dataType: "boolean", operation: "equals", right: true }] },
    { id: "held", type: "stop", outcome: "success" },
  ],
  edges: [
    { from: "start", to: "summarize" },
    { from: "summarize", to: "is_ok" },
    { from: "is_ok", to: "post", fromOutput: "true" },
    { from: "is_ok", to: "held", fromOutput: "false" },
  ],
} as WorkflowDefinition;

describe("buildSteps", () => {
  it("numbers steps in run order and says what each does, reads, and where it goes", () => {
    const steps = buildSteps(digest, names);
    expect(steps.map((s) => [s.number, s.title])).toEqual([[1, "Start"], [2, "Summarize"], [3, "Is ok"], [4, "Post"], [5, "Held"]]);
    expect(steps[0]!.summary).toBe("Starts the workflow with Since");
    expect(steps[1]).toMatchObject({ summary: "Asks Claude Sonnet 4.5 · returns Digest", reads: ["Since (input)"] });
    expect(steps[2]).toMatchObject({ summary: "Checks Summarize › ok equals true", next: ["Yes → step 4", "No → step 5"] });
    expect(steps[3]).toMatchObject({ summary: "Slack · Send message", reads: ["Summarize (step 2)"], next: [] });
  });

  it("keeps a step that a cycle leaves unordered instead of hiding it", () => {
    const loop = { version: "dag/v1", nodes: [{ id: "a", type: "set", values: {} }, { id: "b", type: "set", values: {} }],
      edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] } as WorkflowDefinition;
    expect(buildSteps(loop, names).map((s) => s.title)).toEqual(["A", "B"]);
  });
});

describe("labels", () => {
  it("reads ids, paths, and model ids as words", () => {
    expect(humanize("fetch_meetings")).toBe("Fetch meetings");
    expect(pathLabel("nodes.check.result.output.ok")).toBe("Check › ok");
    expect(pathLabel("trigger.data.since")).toBe("Since");
    expect(modelLabel("anthropic:claude-opus-4-1")).toBe("Claude Opus 4.1");
  });
});
