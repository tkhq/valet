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

/**
 * What `formatEditLintErrors` (packages/api/src/workflows/actions.ts) sends
 * when a patch is blocked by an error the workflow already held. It groups
 * the caller's own error above a sentence, and the inherited one below it.
 * The sentence is api prose, not a validator message.
 */
const PRE_EXISTING_ADVICE =
  "The workflow already held the error(s) below before this edit, so this edit did not cause them. " +
  "Fix them in the same call, or open the workflow in the editor and correct them first.";
const EDIT_REJECTION =
  "workflows.patch_workflow failed: workflow definition failed validation (fix these and retry):\n" +
  "- node llm-1: model is required\n" +
  "\n" +
  `${PRE_EXISTING_ADVICE}\n` +
  '- node "build": values.to reads "trigger.email", but a trigger payload carries only ' +
  "type, triggerId, timestamp, data, metadata";

function renderBody(text: string) {
  const args = {
    tool_id: "workflows.patch_workflow",
    params: { workflow_id: "wf_1", upsert_nodes: [{ id: "notify", type: "wait" }] },
  };
  const { Body } = pickRenderer("call_tool", args);
  expect(Body).toBeDefined();
  if (!Body) return;
  render(<Body args={args} result={{ text }} status="completed" toolName="call_tool" />);
}

describe("a patch the linter rejected", () => {
  it("shows each validator message verbatim, not a paraphrase", () => {
    renderBody(REJECTION);
    expect(screen.getByText("unknown edge target: notify")).toBeTruthy();
    expect(screen.getByText("node llm-1: model is required")).toBeTruthy();
  });

  it("says that nothing was saved, so the canvas is not suspected of being stale", () => {
    renderBody(REJECTION);
    expect(screen.getByText(/nothing saved/)).toBeTruthy();
    expect(screen.getByText(/2 issues/)).toBeTruthy();
  });
});

describe("a patch blocked by an error the workflow already held", () => {
  it("counts the validator's messages only, not the sentence about them", () => {
    renderBody(EDIT_REJECTION);
    expect(screen.getByText(/2 issues/)).toBeTruthy();
  });

  it("keeps the sentence out of the validator's own list", () => {
    renderBody(EDIT_REJECTION);
    const advice = screen.getByText(PRE_EXISTING_ADVICE);
    expect(advice.closest("li")).toBeNull();
    // Both validator messages stay in the list, and stay verbatim.
    expect(screen.getByText("node llm-1: model is required").closest("li")).toBeTruthy();
    expect(screen.getByText(/reads "trigger.email"/).closest("li")).toBeTruthy();
  });
});
