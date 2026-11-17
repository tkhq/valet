// @vitest-environment jsdom
/**
 * ApiKeyPolicySection: the personal-keys switch and the maximum key
 * lifetime select on Organization · Policies. "No limit" stores null, and
 * only an org admin can change either control.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const patchMutate = vi.fn();

let orgData: {
  callerRole: "admin" | "member";
  allowPersonalApiKeys?: boolean;
  maxApiKeyLifetimeDays?: number | null;
} = { callerRole: "admin" };

vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useOrg: () => ({ data: orgData, isLoading: false, error: null }),
    usePatchOrgSettings: () => ({ mutate: patchMutate, isPending: false }),
  };
});

import { ApiKeyPolicySection } from "./api-key-policy-section";

beforeEach(() => {
  vi.clearAllMocks();
  orgData = { callerRole: "admin" };
});

describe("ApiKeyPolicySection", () => {
  it("defaults to personal keys on and no limit", () => {
    render(<ApiKeyPolicySection />);
    expect(screen.getByRole("switch", { name: "Members can create personal API keys" }).getAttribute("aria-checked")).toBe("true");
    const select = screen.getByLabelText("Maximum key lifetime");
    expect(select).toHaveProperty("value", "none");
    expect(Array.from(select.querySelectorAll("option")).map((o) => o.textContent)).toEqual([
      "No limit",
      "30 days",
      "90 days",
      "1 year",
    ]);
  });

  it("stores a maximum in days, and No limit as null", async () => {
    orgData = { callerRole: "admin", maxApiKeyLifetimeDays: 365 };
    render(<ApiKeyPolicySection />);
    const select = screen.getByLabelText("Maximum key lifetime");
    await userEvent.selectOptions(select, "30");
    expect(patchMutate).toHaveBeenLastCalledWith({ maxApiKeyLifetimeDays: 30 }, expect.anything());
    await userEvent.selectOptions(select, "none");
    expect(patchMutate).toHaveBeenLastCalledWith({ maxApiKeyLifetimeDays: null }, expect.anything());
  });

  it("turns personal keys off", async () => {
    render(<ApiKeyPolicySection />);
    await userEvent.click(screen.getByRole("switch", { name: "Members can create personal API keys" }));
    expect(patchMutate).toHaveBeenLastCalledWith({ allowPersonalApiKeys: false }, expect.anything());
  });

  it("is read-only for a member", () => {
    orgData = { callerRole: "member", allowPersonalApiKeys: false, maxApiKeyLifetimeDays: 90 };
    render(<ApiKeyPolicySection />);
    expect(screen.getByRole("switch", { name: "Members can create personal API keys" })).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Maximum key lifetime")).toHaveProperty("disabled", true);
    expect(screen.getByText("Only an organization admin can change these settings.")).toBeTruthy();
  });
});
