// @vitest-environment jsdom
/**
 * You · Policies — "My policy overrides" (action-policies plan, Task 5):
 * one-of target enforcement on create, PUT-by-target upsert, DELETE-by-
 * target revoke, and the 400-loosen-past-org-policy error surfaced
 * verbatim (not swallowed into a toast) per the brief.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActionPolicyOverrideWire } from "@valet/api/wire";
import { ApiError } from "~/api/client";

const putMutate = vi.fn();
const deleteMutate = vi.fn();

let overridesData: { overrides: ActionPolicyOverrideWire[] } = { overrides: [] };

vi.mock("~/api/policies", async () => {
  const actual = await vi.importActual<typeof import("~/api/policies")>("~/api/policies");
  return {
    ...actual,
    useMyPolicyOverrides: () => ({ data: overridesData, isLoading: false, error: null }),
    usePutMyPolicyOverride: () => ({ mutate: putMutate, isPending: false }),
    useDeleteMyPolicyOverride: () => ({ mutate: deleteMutate, isPending: false }),
  };
});

// ServiceActionCombobox uses usePlugins internally; return empty catalog so
// any typed value is committed as free text.
vi.mock("~/api/integrations", () => ({
  usePlugins: () => ({ data: { plugins: [] }, isLoading: false }),
}));

import { PolicyOverridesSection } from "./policy-overrides-section";

beforeEach(() => {
  vi.clearAllMocks();
  overridesData = { overrides: [] };
});

describe("PolicyOverridesSection — create", () => {
  it("defaults to Service target and PUTs with only service set", async () => {
    const user = userEvent.setup();
    render(<PolicyOverridesSection />);

    // Click the combobox, type the service name, press Enter to commit (free-text)
    const serviceInput = screen.getByRole("combobox", { name: /service/i });
    await user.click(serviceInput);
    await user.keyboard("gmail{Enter}");
    await user.click(screen.getByRole("button", { name: "Save override" }));

    const call = putMutate.mock.calls[0][0];
    expect(call).toEqual({ service: "gmail", mode: "allow" });
  });

  it("switching to Action target sends actionId only", async () => {
    const user = userEvent.setup();
    render(<PolicyOverridesSection />);

    await user.click(screen.getByRole("radio", { name: "Action" }));
    // Click the combobox, type the action id, press Enter to commit (free-text)
    const actionInput = screen.getByRole("combobox", { name: /action id/i });
    await user.click(actionInput);
    await user.keyboard("gmail.send_email{Enter}");
    await user.click(screen.getByRole("button", { name: "Save override" }));

    const call = putMutate.mock.calls[0][0];
    expect(call).toEqual({ actionId: "gmail.send_email", mode: "allow" });
  });

  it("surfaces the API's loosen-past-org-policy error verbatim", async () => {
    const user = userEvent.setup();
    putMutate.mockImplementation((_body, opts) => {
      opts.onError(
        new ApiError(400, "PUT /api/me/policy-overrides → 400", {
          error: "override would loosen an org deny policy for this action",
        }),
      );
    });
    render(<PolicyOverridesSection />);

    const serviceInput = screen.getByRole("combobox", { name: /service/i });
    await user.click(serviceInput);
    await user.keyboard("gmail{Enter}");
    await user.click(screen.getByRole("button", { name: "Save override" }));

    expect(
      await screen.findByText("override would loosen an org deny policy for this action"),
    ).toBeTruthy();
  });
});

describe("PolicyOverridesSection — list + delete", () => {
  it("renders existing overrides and deletes by target, not by id", async () => {
    const user = userEvent.setup();
    overridesData = {
      overrides: [
        {
          id: "ov_1",
          service: "gmail",
          actionId: null,
          riskLevel: null,
          mode: "deny",
          paramMatchers: [],
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    };
    render(<PolicyOverridesSection />);

    expect(screen.getByText("service: gmail")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete override service: gmail" }));

    expect(deleteMutate).toHaveBeenCalledWith(
      { service: "gmail", actionId: undefined, riskLevel: undefined },
      expect.anything(),
    );
  });
});
