// @vitest-environment jsdom
/**
 * Organization · 1Password. The page carries the org-wide token alone; a
 * personal token is a personal credential and lives on You · Connected
 * accounts. Mocks `~/api/onepassword`, `~/api/integrations` and
 * `~/api/settings`: these tests only care what the panel renders and which
 * mutation it fires.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OnePasswordSettingsResponse } from "@valet/api/wire";

const connectMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const disconnectMutate = vi.fn();

let orgData: { callerRole: "admin" | "member" } = { callerRole: "admin" };
let settingsData: OnePasswordSettingsResponse | undefined = {
  orgTokenConnected: false,
  personalTokenConnected: false,
};

vi.mock("~/api/settings", () => ({
  useOrg: () => ({ data: orgData, isLoading: false, error: null }),
}));

vi.mock("~/api/onepassword", () => ({
  useOnePasswordSettings: () => ({ data: settingsData, isLoading: false, error: null }),
}));

vi.mock("~/api/integrations", () => ({
  useConnectCredential: () => ({
    mutate: vi.fn(),
    mutateAsync: connectMutateAsync,
    isPending: false,
    error: null,
    reset: vi.fn(),
  }),
  useDisconnectCredential: () => ({
    mutate: disconnectMutate,
    isPending: false,
    error: null,
    reset: vi.fn(),
  }),
}));

import { OnePasswordPanel } from "./onepassword-panel";

describe("OnePasswordPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMutateAsync.mockResolvedValue({ ok: true });
    orgData = { callerRole: "admin" };
    settingsData = { orgTokenConnected: false, personalTokenConnected: false };
  });

  // The personal token moved to You · Connected accounts: setting one needs
  // no organization permission, so a member never has to open this page to
  // finish their own setup (TKAI-487).
  it("carries the organization token alone, and points at the personal one", () => {
    render(<OnePasswordPanel />);
    expect(screen.getByRole("group", { name: "Organization token" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Personal token" })).toBeNull();
    expect(screen.getByRole("link", { name: "Connected accounts" }).getAttribute("href")).toBe(
      "/settings/connected-accounts",
    );
  });

  it("admin with no token gets the connect control", () => {
    render(<OnePasswordPanel />);
    expect(screen.getByRole("button", { name: "Connect 1Password" })).toBeTruthy();
  });

  it("admin with a token connected gets the badge, Replace and Remove", () => {
    settingsData = { orgTokenConnected: true, personalTokenConnected: false };
    render(<OnePasswordPanel />);
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Replace" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove token" })).toBeTruthy();
  });

  // The bug report's state: an org token is connected and the reader is a
  // plain member. This used to render an empty panel.
  it("member sees the status and who can change it, and no controls", () => {
    orgData = { callerRole: "member" };
    settingsData = { orgTokenConnected: true, personalTokenConnected: false };
    render(<OnePasswordPanel />);
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(
      screen.getByText("Only an organization admin can connect or remove this token."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect 1Password" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove token" })).toBeNull();
  });

  it("member with no org token sees Not connected rather than an empty row", () => {
    orgData = { callerRole: "member" };
    render(<OnePasswordPanel />);
    expect(screen.getByText("Not connected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect 1Password" })).toBeNull();
  });

  it("connecting from this page saves at org scope", async () => {
    const user = userEvent.setup();
    render(<OnePasswordPanel />);
    await user.click(screen.getByRole("button", { name: "Connect 1Password" }));
    await user.type(screen.getByLabelText("Organization 1Password token"), "ops_org");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(connectMutateAsync).toHaveBeenCalledWith({
      service: "onepassword",
      body: { type: "service_account", apiKey: "ops_org", scope: "org" },
    });
  });

  it("removing asks first, then disconnects at org scope", async () => {
    const user = userEvent.setup();
    settingsData = { orgTokenConnected: true, personalTokenConnected: false };
    render(<OnePasswordPanel />);
    await user.click(screen.getByRole("button", { name: "Remove token" }));
    expect(disconnectMutate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Remove token", hidden: false }));
    expect(disconnectMutate).toHaveBeenCalledWith(
      { service: "onepassword", scope: "org" },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });
});
