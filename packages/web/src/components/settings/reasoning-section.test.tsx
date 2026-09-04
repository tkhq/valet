// @vitest-environment jsdom
/**
 * ReasoningSection (model-selector-overhaul, Task 13): two selects over
 * `REASONING_LEVELS` with an "Inherit"/"No cap" empty option; each change
 * issues its own `PatchOrgReasoningRequest` field, and default options
 * above the chosen max render disabled.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OrgReasoningSettings } from "@valet/api/wire";

const patchMutate = vi.fn();

let reasoningData: OrgReasoningSettings = {};

vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useOrgReasoning: () => ({ data: reasoningData, isLoading: false, error: null }),
    usePatchOrgReasoning: () => ({ mutate: patchMutate, isPending: false }),
  };
});

import { ReasoningSection } from "./reasoning-section";

beforeEach(() => {
  vi.clearAllMocks();
  reasoningData = {};
});

describe("ReasoningSection", () => {
  it("defaults both selects to the empty (Inherit / No cap) option", () => {
    render(<ReasoningSection />);

    expect(screen.getByLabelText("Default")).toHaveProperty("value", "");
    expect(screen.getByLabelText("Max")).toHaveProperty("value", "");
  });

  it("changing Default sends { default: value }", async () => {
    const user = userEvent.setup();
    render(<ReasoningSection />);

    await user.selectOptions(screen.getByLabelText("Default"), "high");

    expect(patchMutate).toHaveBeenCalledWith({ default: "high" }, expect.anything());
  });

  it("changing Max sends { max: value }", async () => {
    const user = userEvent.setup();
    render(<ReasoningSection />);

    await user.selectOptions(screen.getByLabelText("Max"), "medium");

    expect(patchMutate).toHaveBeenCalledWith({ max: "medium" }, expect.anything());
  });

  it("resetting a select to the empty option sends null", async () => {
    reasoningData = { default: "high" };
    const user = userEvent.setup();
    render(<ReasoningSection />);

    await user.selectOptions(screen.getByLabelText("Default"), "");

    expect(patchMutate).toHaveBeenCalledWith({ default: null }, expect.anything());
  });

  it("disables Default options above the chosen Max", () => {
    reasoningData = { max: "medium" };
    render(<ReasoningSection />);

    const defaultSelect = screen.getByLabelText("Default") as HTMLSelectElement;
    const options = Array.from(defaultSelect.options);
    const high = options.find((o) => o.value === "high");
    const medium = options.find((o) => o.value === "medium");
    const minimal = options.find((o) => o.value === "minimal");

    expect(high?.disabled).toBe(true);
    expect(medium?.disabled).toBe(false);
    expect(minimal?.disabled).toBe(false);
  });
});
