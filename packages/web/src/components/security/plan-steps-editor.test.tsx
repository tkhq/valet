// @vitest-environment jsdom
/**
 * The controlled plan-steps editor (spec §Dynamic configuration): it renders
 * the value, add/remove/reorder/edit fire onChange, and the triad toggle rides
 * end to end into the wire input. No data fetching, no mutation.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import type { SecurityPlanCellWire } from "@valet/api/wire";
import {
  PlanStepsEditor,
  draftToInput,
  wireToDraft,
  type StepDraft,
} from "./plan-steps-editor";

const CELLS: SecurityPlanCellWire[] = [
  { ordinal: 1, persona: "code-review", name: "recon", goal: "Map the tree", reads: [], review: false },
  {
    ordinal: 2,
    persona: "code-review",
    name: "authz",
    goal: "Sweep authz",
    playbook: "authz",
    reads: [1],
    review: false,
  },
];

/** A tiny controlled host that owns the draft, mirroring the setup page. */
function Host({ onChange }: { onChange?: (next: StepDraft[]) => void }) {
  const [steps, setSteps] = useState<StepDraft[]>(() => CELLS.map(wireToDraft));
  return (
    <PlanStepsEditor
      value={steps}
      onChange={(next) => {
        setSteps(next);
        onChange?.(next);
      }}
    />
  );
}

describe("PlanStepsEditor", () => {
  it("renders the value as editable steps", () => {
    render(<Host />);
    const steps = screen.getAllByTestId("plan-step");
    expect(steps).toHaveLength(2);
    expect((within(steps[0]).getByLabelText("Goal") as HTMLTextAreaElement).value).toBe("Map the tree");
    expect((within(steps[1]).getByLabelText("Goal") as HTMLTextAreaElement).value).toBe("Sweep authz");
  });

  it("fires onChange with an added step", () => {
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId("plan-step")).toHaveLength(3);
  });

  it("removes a step", () => {
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "Remove step 2" }));
    expect(screen.getAllByTestId("plan-step")).toHaveLength(1);
  });

  it("reorders steps with move up", () => {
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "Move step 2 up" }));
    const steps = screen.getAllByTestId("plan-step");
    expect((within(steps[0]).getByLabelText("Goal") as HTMLTextAreaElement).value).toBe("Sweep authz");
  });

  it("shows an inline error when a step has no goal", () => {
    render(<Host />);
    const firstGoal = within(screen.getAllByTestId("plan-step")[0]).getByLabelText("Goal");
    fireEvent.change(firstGoal, { target: { value: "" } });
    expect(screen.getByTestId("plan-error")).toBeTruthy();
  });

  it("toggles the triad flag and it rides into the wire input", () => {
    let latest: StepDraft[] = [];
    render(<Host onChange={(next) => (latest = next)} />);
    const step2 = screen.getAllByTestId("plan-step")[1];
    const triad = within(step2).getByLabelText(/architect → worker → verifier triad/) as HTMLInputElement;
    expect(triad.checked).toBe(false);
    fireEvent.click(triad);
    // The draft now carries triad; draftToInput surfaces it on the wire.
    const input = draftToInput(latest);
    expect(input[1].triad).toBe(true);
    expect(input[0].triad).toBeUndefined();
  });
});
