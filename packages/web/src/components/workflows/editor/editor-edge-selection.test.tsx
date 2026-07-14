// @vitest-environment jsdom
/**
 * Carried Task 10 review minor (b): edge ids encode `fromOutput`
 * (`createEdgeId`), so editing an edge's fromOutput in the inspector
 * re-keys it in the next `toFlow()` snapshot. Before the fix,
 * `Editor.handleEdgeChange` left `selectedEdgeId` pointed at the old id —
 * `flow.edges.find` then returned `undefined` and the inspector silently
 * fell back to the "select a node or edge" placeholder mid-edit. This
 * verifies the selection is carried to the new id so the inspector stays
 * on the edge the user is actively editing.
 *
 * Selecting/clicking an edge through the real xyflow canvas isn't
 * reliably driveable in jsdom (see `canvas.test.tsx`'s note on
 * ResizeObserver-gated edge rendering), so `Canvas` is stubbed here with a
 * button per edge that calls the real `onSelectEdge` callback Editor
 * passes down — everything above that (the model mutation, the id
 * re-derivation, the inspector re-render) is the real production code.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { WorkflowDefinition } from "@valet/workflow";
import type { CanvasProps } from "./canvas";

vi.mock("./canvas", () => ({
  Canvas: ({ flow, onSelectEdge }: CanvasProps) => (
    <div>
      {flow.edges.map((edge) => (
        <button key={edge.id} onClick={() => onSelectEdge(edge.id)}>
          select-edge:{edge.id}
        </button>
      ))}
    </div>
  ),
}));

import { Editor } from "./editor";

function baseDefinition(): WorkflowDefinition {
  return {
    version: "dag/v1",
    nodes: [
      { id: "trigger", type: "trigger" },
      {
        id: "check",
        type: "if",
        conditions: [{ left: "trigger.ok", dataType: "boolean", operation: "eq", right: true }],
      },
      { id: "stop-a", type: "stop", outcome: "success" },
      { id: "stop-b", type: "stop", outcome: "failure" },
    ],
    edges: [
      { from: "trigger", to: "check" },
      { from: "check", to: "stop-a", fromOutput: "true" },
      { from: "check", to: "stop-b", fromOutput: "false" },
    ],
  };
}

describe("Editor — edge selection stays live across a fromOutput edit", () => {
  it("re-derives selectedEdgeId to the new edge id instead of going stale", () => {
    render(<Editor initialDefinition={baseDefinition()} onSave={vi.fn()} />);

    fireEvent.click(screen.getByText("select-edge:check:true->stop-a"));

    // Selected: the inspector shows the edge fields, not the placeholder.
    expect(screen.getByText("check → stop-a")).toBeTruthy();
    const fromOutputSelect = screen.getByLabelText("From output") as HTMLSelectElement;
    expect(fromOutputSelect.value).toBe("true");

    fireEvent.change(fromOutputSelect, { target: { value: "false" } });

    // The edge re-keyed from "check:true->stop-a" to "check:false->stop-a" —
    // the inspector must still be showing it, not the "select a node or
    // edge" fallback.
    expect(screen.getByText("check → stop-a")).toBeTruthy();
    expect(screen.queryByText("Select a node or edge to edit its settings.")).toBeNull();
    const updatedSelect = screen.getByLabelText("From output") as HTMLSelectElement;
    expect(updatedSelect.value).toBe("false");
  });
});
