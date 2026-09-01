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
  BUNDLED_PERSONAS,
  LIVE_PERSONA_IDS,
  planHasLivePersona,
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

  it("BUNDLED_PERSONAS lists every bundled persona incl. live and coordination", () => {
    // Mirrors packages/plugin-security/src/lib/personas.ts BUNDLED_PERSONAS.
    const ids = BUNDLED_PERSONAS.map((p) => p.id).sort();
    expect(ids).toEqual([
      "architect",
      "attack-tree",
      "code-review",
      "dast",
      "exploit",
      "fuzz",
      "pivot-coordinator",
      "reconcile",
      "report",
      "sast",
      "threat-model",
      "verifier",
    ]);
    // Every persona carries a kind.
    for (const p of BUNDLED_PERSONAS) {
      expect(["source", "live", "coordination", "deliverable"]).toContain(p.kind);
    }
  });

  it("LIVE_PERSONA_IDS names exactly the target-running personas", () => {
    expect([...LIVE_PERSONA_IDS].sort()).toEqual(["dast", "exploit", "fuzz"]);
  });

  it("planHasLivePersona detects a live persona in the draft", () => {
    expect(planHasLivePersona([{ persona: "code-review" }, { persona: "sast" }])).toBe(false);
    expect(planHasLivePersona([{ persona: "code-review" }, { persona: "dast" }])).toBe(true);
    expect(planHasLivePersona([{ persona: "fuzz" }])).toBe(true);
    expect(planHasLivePersona([{ persona: "exploit" }])).toBe(true);
    expect(planHasLivePersona([])).toBe(false);
  });

  it("persona dropdown groups options by kind under optgroups", () => {
    render(<Host />);
    const persona = screen.getAllByLabelText("Persona")[0] as HTMLSelectElement;
    const groups = Array.from(persona.querySelectorAll("optgroup")).map((g) =>
      g.getAttribute("label"),
    );
    // The groups render in order source, live, coordination, deliverable.
    expect(groups.length).toBe(4);
    expect(groups[0]).toMatch(/Source-only/);
    expect(groups[1]).toMatch(/Live/);
    expect(groups[2]).toMatch(/Coordination/);
    expect(groups[3]).toMatch(/Deliverable/);
    // Every bundled persona surfaces as an <option>.
    const options = Array.from(persona.querySelectorAll("option")).map((o) => o.value);
    expect(options).toEqual(
      expect.arrayContaining([
        "code-review",
        "sast",
        "threat-model",
        "attack-tree",
        "dast",
        "fuzz",
        "exploit",
        "architect",
        "verifier",
        "pivot-coordinator",
        "report",
        "reconcile",
      ]),
    );
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
