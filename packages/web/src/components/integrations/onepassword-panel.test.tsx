// @vitest-environment jsdom
/**
 * Organization · 1Password panel. Mocks `~/api/onepassword`,
 * `~/api/integrations`, and `~/api/settings`: these tests only care what the
 * panel renders and which mutation it fires.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OnePasswordSettingsResponse } from "@valet/api/wire";
import { ApiError } from "~/api/client";

const putSettingsMutate = vi.fn();
const connectMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const connectMutate = vi.fn();
const disconnectMutate = vi.fn();

let orgData: { callerRole: "admin" | "member" } = { callerRole: "admin" };
let settingsData: OnePasswordSettingsResponse | undefined = {
  allowPersonal: false,
  orgTokenConnected: false,
  personalTokenConnected: false,
};

vi.mock("~/api/settings", () => ({
  useOrg: () => ({ data: orgData, isLoading: false, error: null }),
}));

vi.mock("~/api/onepassword", () => ({
  useOnePasswordSettings: () => ({ data: settingsData, isLoading: false, error: null }),
  usePutOnePasswordSettings: () => ({ mutate: putSettingsMutate, isPending: false, error: null }),
}));

vi.mock("~/api/integrations", () => ({
  useConnectCredential: () => ({
    mutate: connectMutate,
    mutateAsync: connectMutateAsync,
    isPending: false,
    error: null,
  }),
  useDisconnectCredential: () => ({ mutate: disconnectMutate, isPending: false }),
}));

import { OnePasswordPanel } from "./onepassword-panel";

describe("OnePasswordPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMutateAsync.mockResolvedValue({ ok: true });
    orgData = { callerRole: "admin" };
    settingsData = { allowPersonal: false, orgTokenConnected: false, personalTokenConnected: false };
    vi.stubGlobal("confirm", vi.fn(() => true));
  });

  it("member with no tokens sees the empty copy, not the org token card or toggle", () => {
    orgData = { callerRole: "member" };
    render(<OnePasswordPanel />);
    expect(
      screen.getByText("An admin can connect an organization 1Password token on this page."),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Organization 1Password token")).toBeNull();
    expect(screen.queryByLabelText("Allow personal tokens")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add from 1Password" })).toBeNull();
  });

  it("admin sees the token field and the allow-personal toggle", () => {
    render(<OnePasswordPanel />);
    expect(screen.getByLabelText("Organization 1Password token")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Allow personal tokens" })).toBeTruthy();
  });

  it("shows a Connected badge when the org token is already set", () => {
    settingsData = { allowPersonal: false, orgTokenConnected: true, personalTokenConnected: false };
    render(<OnePasswordPanel />);
    expect(screen.getByText("Connected")).toBeTruthy();
    // A connected token is state, not a form. The input appears behind
    // Replace, so two identical password boxes are never on screen at once.
    expect(screen.queryByLabelText("Organization 1Password token")).toBeNull();
    expect(screen.getByRole("button", { name: "Replace" })).toBeTruthy();
  });

  it("saving the org token fires the connect mutation with scope: org", async () => {
    const user = userEvent.setup();
    render(<OnePasswordPanel />);
    await user.type(screen.getByLabelText("Organization 1Password token"), "op-token-123");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(connectMutateAsync).toHaveBeenCalledWith({
        service: "onepassword",
        body: { type: "service_account", apiKey: "op-token-123", scope: "org" },
      }),
    );
  });

  it("shows an inline error when saving the org token fails", async () => {
    connectMutateAsync.mockRejectedValueOnce(
      new ApiError(400, "PUT /credentials/onepassword → 400", { error: "1Password resolution failed" }),
    );
    const user = userEvent.setup();
    render(<OnePasswordPanel />);
    await user.type(screen.getByLabelText("Organization 1Password token"), "bad-token");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("1Password resolution failed")).toBeTruthy();
  });

  it("toggling allow-personal fires the PUT mutation", () => {
    render(<OnePasswordPanel />);
    fireEvent.click(screen.getByRole("switch", { name: "Allow personal tokens" }));
    expect(putSettingsMutate).toHaveBeenCalledWith({ allowPersonal: true });
  });

  it("hides the personal token card when allowPersonal is false", () => {
    render(<OnePasswordPanel />);
    expect(screen.queryByLabelText("1Password personal token")).toBeNull();
  });

  it("shows the personal token card when allowPersonal is true", () => {
    settingsData = { allowPersonal: true, orgTokenConnected: false, personalTokenConnected: false };
    render(<OnePasswordPanel />);
    expect(screen.getByLabelText("1Password personal token")).toBeTruthy();
  });

  it("saving the personal token fires the connect mutation with no scope field", async () => {
    orgData = { callerRole: "member" };
    settingsData = { allowPersonal: true, orgTokenConnected: false, personalTokenConnected: false };
    const user = userEvent.setup();
    render(<OnePasswordPanel />);
    await user.type(screen.getByLabelText("1Password personal token"), "op-personal-token");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(connectMutateAsync).toHaveBeenCalledWith({
        service: "onepassword",
        body: { type: "service_account", apiKey: "op-personal-token" },
      }),
    );
  });
});
