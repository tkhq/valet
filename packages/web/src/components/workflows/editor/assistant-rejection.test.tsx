// @vitest-environment jsdom
/**
 * A patch the linter rejects has to reach the builder in the validator's own
 * words. The api runs the patch and the linter before it writes anything, so
 * a rejection changes nothing and mints no version — but somebody who cannot
 * read WHY it was rejected cannot fix the workflow.
 *
 * The panel renders these through the shared workflow tool renderer, which
 * already claims `call_tool` with a `workflows.` tool_id. A PATCH is the new
 * case: unlike a save it carries no `params.definition`, so the attempted-DAG
 * preview has nothing to draw and the bullets have to stand on their own.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { pickRenderer } from "~/components/session/tool-renderers";

const REJECTION =
  "workflows.patch_workflow failed: workflow definition failed validation (fix these and retry):\n" +
  "- unknown edge target: notify\n" +
  "- node llm-1: model is required";

describe("a patch the linter rejected", () => {
  function renderBody() {
    const args = {
      tool_id: "workflows.patch_workflow",
      params: { workflow_id: "wf_1", upsert_nodes: [{ id: "notify", type: "wait" }] },
    };
    const { Body } = pickRenderer("call_tool", args);
    expect(Body).toBeDefined();
    if (!Body) return;
    render(
      <Body args={args} result={{ text: REJECTION }} status="completed" toolName="call_tool" />,
    );
  }

  it("shows each validator message verbatim, not a paraphrase", () => {
    renderBody();
    expect(screen.getByText("unknown edge target: notify")).toBeTruthy();
    expect(screen.getByText("node llm-1: model is required")).toBeTruthy();
  });

  it("says that nothing was saved, so the canvas is not suspected of being stale", () => {
    renderBody();
    expect(screen.getByText(/nothing saved/)).toBeTruthy();
    expect(screen.getByText(/2 issues/)).toBeTruthy();
  });
});
