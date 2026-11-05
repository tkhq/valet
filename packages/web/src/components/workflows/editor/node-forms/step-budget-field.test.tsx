// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { SessionNode } from "@valet/workflow";
import { StepBudgetField } from "./step-budget-field";

const node = (prompt: string, maxModelCalls?: number): SessionNode => ({ id: "research", type: "session", mode: "start", prompt, ...(maxModelCalls ? { maxModelCalls } : {}) });

describe("StepBudgetField", () => {
  it("suggests a foreach when one agent step handles every item in a list", () => {
    render(<StepBudgetField node={node("Deep-read every merged PR from the last 7 days.")} onChange={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toContain("use a foreach step that handles one item in each iteration");
  });

  it("points an agent step that asks for approval at a tool step", () => {
    render(<StepBudgetField node={node("DM the people lead that the project is ready for approval, then create it.", 40)} onChange={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toContain("Put the action that needs approval in a tool step");
  });

  it("shows no warning for bounded work and saves a new limit", () => {
    const onChange = vi.fn();
    render(<StepBudgetField node={node("Summarize the notes.", 40)} onChange={onChange} />);
    expect(screen.queryByRole("status")).toBeNull();
    const input = screen.getByLabelText("Model call limit") as HTMLInputElement;
    expect(input.value).toBe("40");
    fireEvent.change(input, { target: { value: "80" } });
    expect(onChange).toHaveBeenCalledWith({ maxModelCalls: 80 });
  });
});
