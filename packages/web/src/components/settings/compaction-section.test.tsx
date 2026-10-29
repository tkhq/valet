// @vitest-environment jsdom
/**
 * CompactionSection: one select over the compaction window presets. The empty
 * option stores null (Valet default), "Model limit" stores 0, a stored value
 * outside the presets still shows, and only an org admin can change it.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const patchMutate = vi.fn();

let orgData: { callerRole: "admin" | "member"; compactionWindowTokens?: number | null } = { callerRole: "admin" };

vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useOrg: () => ({ data: orgData, isLoading: false, error: null }),
    usePatchOrgSettings: () => ({ mutate: patchMutate, isPending: false }),
  };
});

import { CompactionSection } from "./compaction-section";

beforeEach(() => {
  vi.clearAllMocks();
  orgData = { callerRole: "admin" };
});

describe("CompactionSection", () => {
  it("shows the Valet default when the org never set a window", () => {
    render(<CompactionSection />);
    expect(screen.getByLabelText("Compaction window")).toHaveProperty("value", "");
  });

  it("stores a preset as a token count, the default as null, and the model limit as 0", async () => {
    orgData = { callerRole: "admin", compactionWindowTokens: 300_000 };
    render(<CompactionSection />);
    const select = screen.getByLabelText("Compaction window");

    await userEvent.selectOptions(select, "150000");
    expect(patchMutate).toHaveBeenLastCalledWith({ compactionWindowTokens: 150_000 }, expect.anything());
    await userEvent.selectOptions(select, "");
    expect(patchMutate).toHaveBeenLastCalledWith({ compactionWindowTokens: null }, expect.anything());
    await userEvent.selectOptions(select, "0");
    expect(patchMutate).toHaveBeenLastCalledWith({ compactionWindowTokens: 0 }, expect.anything());
  });

  it("shows a stored window that is not a preset", () => {
    orgData = { callerRole: "admin", compactionWindowTokens: 250_000 };
    render(<CompactionSection />);
    expect(screen.getByLabelText("Compaction window")).toHaveProperty("value", "250000");
    expect(screen.getByRole("option", { name: "250k tokens" })).toBeTruthy();
  });

  it("is read-only for a member", () => {
    orgData = { callerRole: "member", compactionWindowTokens: null };
    render(<CompactionSection />);
    expect(screen.getByLabelText("Compaction window")).toHaveProperty("disabled", true);
    expect(screen.getByText(/Only an org admin can change this/)).toBeTruthy();
  });
});
