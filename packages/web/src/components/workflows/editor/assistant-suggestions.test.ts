/**
 * The openings the assistant panel offers above its composer. The point of
 * them is that they name steps from the workflow on screen — a generic
 * "ask me anything" would be the empty state this replaced.
 */
import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "@valet/workflow";
import { MAX_SUGGESTIONS, workflowSuggestions } from "./assistant-suggestions";

function definition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    version: "dag/v1",
    nodes: [
      { id: "trigger", type: "trigger" },
      { id: "draft", type: "llm", model: "claude-haiku", prompt: "write it" },
      { id: "done", type: "stop", outcome: "success" },
    ],
    edges: [
      { from: "trigger", to: "draft" },
      { from: "draft", to: "done" },
    ],
    ...overrides,
  };
}

describe("workflowSuggestions", () => {
  it("names real step ids from this workflow, and the workflow id", () => {
    const suggestions = workflowSuggestions(definition(), "wf_42");
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.every((s) => s.prompt.includes("wf_42"))).toBe(true);
    expect(suggestions.some((s) => s.prompt.includes("draft"))).toBe(true);
  });

  it("leads with a step that nothing reaches", () => {
    const orphaned = definition({
      nodes: [
        { id: "trigger", type: "trigger" },
        { id: "draft", type: "llm", model: "claude-haiku", prompt: "write it" },
        { id: "stranded", type: "wait", mode: "duration", duration: "5s" },
        { id: "done", type: "stop", outcome: "success" },
      ],
    });
    const first = workflowSuggestions(orphaned, "wf_42")[0];
    expect(first?.label).toBe('Wire up "stranded"');
    expect(first?.prompt).toContain("never reached");
  });

  it("offers to finish a step that has nothing after it", () => {
    const dangling = definition({ edges: [{ from: "trigger", to: "draft" }] });
    const labels = workflowSuggestions(dangling, "wf_42").map((s) => s.label);
    expect(labels).toContain('Finish "draft"');
  });

  it("does not ask to finish a stop node, which correctly ends a branch", () => {
    const labels = workflowSuggestions(definition(), "wf_42").map((s) => s.label);
    expect(labels).not.toContain('Finish "done"');
  });

  it("offers a branch only while the workflow has no if node", () => {
    const withIf = definition({
      nodes: [
        { id: "trigger", type: "trigger" },
        {
          id: "check",
          type: "if",
          conditions: [{ left: "x", dataType: "string", operation: "equals", right: "y" }],
        },
        { id: "done", type: "stop", outcome: "success" },
      ],
      edges: [
        { from: "trigger", to: "check" },
        { from: "check", to: "done", fromOutput: "true" },
      ],
    });
    expect(workflowSuggestions(definition(), "wf_42").map((s) => s.label)).toContain(
      "Add a branch",
    );
    expect(workflowSuggestions(withIf, "wf_42").map((s) => s.label)).not.toContain(
      "Add a branch",
    );
  });

  it("still offers something for a workflow that is only a trigger", () => {
    const bare = definition({
      nodes: [{ id: "trigger", type: "trigger" }],
      edges: [],
    });
    const suggestions = workflowSuggestions(bare, "wf_42");
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.some((s) => s.prompt.includes("trigger"))).toBe(true);
  });

  it("caps the list so the panel header stays readable", () => {
    const busy = definition({
      nodes: [
        { id: "trigger", type: "trigger" },
        { id: "a", type: "wait", mode: "duration", duration: "1s" },
        { id: "b", type: "wait", mode: "duration", duration: "1s" },
        { id: "c", type: "wait", mode: "duration", duration: "1s" },
        { id: "d", type: "wait", mode: "duration", duration: "1s" },
      ],
      edges: [],
    });
    expect(workflowSuggestions(busy, "wf_42").length).toBe(MAX_SUGGESTIONS);
  });
});
