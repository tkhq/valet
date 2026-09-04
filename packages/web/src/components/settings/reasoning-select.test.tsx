// @vitest-environment jsdom
/**
 * ReasoningSelect (model-selector-overhaul, Task 15): a small labeled
 * <select> offering "Inherit" (configurable label) plus every reasoning
 * level up to the org's configured max. Shared by the per-assistant editor,
 * the personal default, and the team-defaults editor.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GetOrgReasoningResponse } from "@valet/api/wire";

let orgReasoningData: GetOrgReasoningResponse = {};

vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useOrgReasoning: () => ({ data: orgReasoningData, isLoading: false, error: null }),
  };
});

import { ReasoningSelect } from "./reasoning-select";

beforeEach(() => {
  orgReasoningData = {};
});

describe("ReasoningSelect", () => {
  it("defaults to the empty Inherit option when value is null", () => {
    render(<ReasoningSelect value={null} onChange={vi.fn()} />);
    expect(screen.getByLabelText("Reasoning")).toHaveProperty("value", "");
    expect(screen.getByText("Inherit")).toBeTruthy();
  });

  it("supports a configurable empty-option label", () => {
    render(<ReasoningSelect value={null} onChange={vi.fn()} emptyLabel="Team default" />);
    expect(screen.getByText("Team default")).toBeTruthy();
  });

  it("offers every level when the org has no configured max", () => {
    render(<ReasoningSelect value={null} onChange={vi.fn()} />);
    const select = screen.getByLabelText("Reasoning") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(["", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("caps the offered levels at the org max", () => {
    orgReasoningData = { max: "medium" };
    render(<ReasoningSelect value={null} onChange={vi.fn()} />);
    const select = screen.getByLabelText("Reasoning") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(["", "minimal", "low", "medium"]);
  });

  it("selecting a level calls onChange with that level", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ReasoningSelect value={null} onChange={onChange} />);

    await user.selectOptions(screen.getByLabelText("Reasoning"), "high");
    expect(onChange).toHaveBeenCalledWith("high");
  });

  it("selecting the empty option calls onChange with null, not an empty string", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ReasoningSelect value="high" onChange={onChange} />);

    await user.selectOptions(screen.getByLabelText("Reasoning"), "");
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
