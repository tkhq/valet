// @vitest-environment jsdom
/**
 * Organization · 1Password panel. Mocks `~/api/onepassword`,
 * `~/api/integrations`, and `~/api/settings`: these tests only care what the
 * panel renders and which mutation it fires.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OnePasswordSettingsResponse } from "@valet/api/wire";
import { ApiError } from "~/api/client";

const putSettingsMutate = vi.fn();
const connectMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const connectMutate = vi.fn();
const disconnectMutate = vi.fn();
let disconnectError: Error | null = null;

let confirmSpy = vi.fn(() => true);
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
  useDisconnectCredential: () => ({
    mutate: disconnectMutate,
    isPending: false,
    error: disconnectError,
    reset: vi.fn(),
  }),
}));

import { OnePasswordPanel } from "./onepassword-panel";

describe("OnePasswordPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMutateAsync.mockResolvedValue({ ok: true });
    orgData = { callerRole: "admin" };
    settingsData = { allowPersonal: false, orgTokenConnected: false, personalTokenConnected: false };
    disconnectError = null;
    // Removal used to sit behind `window.confirm`, which browser automation
    // accepts on its own — no confirmation at all for a scripted client.
    // The stub returns true so a regression here fires the mutation and
    // fails the "opens the dialog" tests loudly instead of hanging.
    confirmSpy = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmSpy);
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

  // Replacing an already-connected token leaves `orgTokenConnected` true on
  // both sides of the save, so an effect keyed on it never re-runs. The form
  // used to stay open over a token that had already saved, with no Connected
  // badge, which reads as a save that did not happen.
  it("closes the Replace form and restores the badge after a successful replace", async () => {
    settingsData = { allowPersonal: false, orgTokenConnected: true, personalTokenConnected: false };
    const user = userEvent.setup();
    render(<OnePasswordPanel />);

    await user.click(screen.getByRole("button", { name: "Replace" }));
    await user.type(screen.getByLabelText("Organization 1Password token"), "op-token-new");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(connectMutateAsync).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.queryByLabelText("Organization 1Password token")).toBeNull();
      expect(screen.getByText("Connected")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Replace" })).toBeTruthy();
    });
  });

  // A failed replace must keep the form open so the value can be corrected.
  it("keeps the Replace form open when the save fails", async () => {
    settingsData = { allowPersonal: false, orgTokenConnected: true, personalTokenConnected: false };
    connectMutateAsync.mockRejectedValueOnce(
      new ApiError(400, "PUT /credentials/onepassword → 400", { error: "nope" }),
    );
    const user = userEvent.setup();
    render(<OnePasswordPanel />);

    await user.click(screen.getByRole("button", { name: "Replace" }));
    await user.type(screen.getByLabelText("Organization 1Password token"), "bad");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(screen.getByLabelText("Organization 1Password token")).toBeTruthy());
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
  // ── Removing a token ──────────────────────────────────────────────────
  // Both rows guarded the disconnect call with `window.confirm`: unstyled,
  // and auto-accepted by browser automation, so a scripted client had no
  // confirmation step at all. The dialog is the real gate — the row button
  // only opens it, and nothing leaves the client until the danger button
  // inside it is pressed.

  /** Admin, org token connected, personal row hidden: one Remove button. */
  function renderConnectedOrgToken() {
    settingsData = { allowPersonal: false, orgTokenConnected: true, personalTokenConnected: false };
    render(<OnePasswordPanel />);
  }

  /** Member, personal token connected, org row hidden: one Remove button. */
  function renderConnectedPersonalToken() {
    orgData = { callerRole: "member" };
    settingsData = { allowPersonal: true, orgTokenConnected: false, personalTokenConnected: true };
    render(<OnePasswordPanel />);
  }

  it("org token: Remove opens the confirm dialog and disconnects nothing", async () => {
    renderConnectedOrgToken();
    fireEvent.click(screen.getByRole("button", { name: "Remove token" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Remove the organization 1Password token?")).toBeTruthy();
    expect(disconnectMutate).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("org token: confirming disconnects with scope org", async () => {
    renderConnectedOrgToken();
    fireEvent.click(screen.getByRole("button", { name: "Remove token" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove token" }));

    expect(disconnectMutate).toHaveBeenCalledTimes(1);
    expect(disconnectMutate).toHaveBeenCalledWith(
      { service: "onepassword", scope: "org" },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("org token: cancelling the dialog disconnects nothing", async () => {
    renderConnectedOrgToken();
    fireEvent.click(screen.getByRole("button", { name: "Remove token" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(disconnectMutate).not.toHaveBeenCalled();
    expect(screen.getByText("Connected")).toBeTruthy();
  });

  // `confirm()` could not show why a removal failed; the dialog can.
  it("org token: the dialog shows the server's reason for a failed removal", async () => {
    disconnectError = new ApiError(403, "DELETE /credentials/onepassword → 403", {
      error: "Only an admin can remove the organization token. Ask an admin.",
    });
    renderConnectedOrgToken();
    fireEvent.click(screen.getByRole("button", { name: "Remove token" }));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Only an admin can remove the organization token. Ask an admin."),
    ).toBeTruthy();
  });

  it("personal token: Remove opens the confirm dialog and disconnects nothing", async () => {
    renderConnectedPersonalToken();
    fireEvent.click(screen.getByRole("button", { name: "Remove token" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Remove your personal 1Password token?")).toBeTruthy();
    expect(disconnectMutate).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("personal token: confirming disconnects with no scope field", async () => {
    renderConnectedPersonalToken();
    fireEvent.click(screen.getByRole("button", { name: "Remove token" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove token" }));

    expect(disconnectMutate).toHaveBeenCalledTimes(1);
    expect(disconnectMutate).toHaveBeenCalledWith(
      { service: "onepassword" },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("personal token: cancelling the dialog disconnects nothing", async () => {
    renderConnectedPersonalToken();
    fireEvent.click(screen.getByRole("button", { name: "Remove token" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(disconnectMutate).not.toHaveBeenCalled();
    expect(screen.getByText("Connected")).toBeTruthy();
  });
});
