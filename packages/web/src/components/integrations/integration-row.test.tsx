// @vitest-environment jsdom
/**
 * Disconnect is the one control on a service tile that destroys a
 * credential, so it asks first — in a `ConfirmDialog` and never in
 * `window.confirm`. The native prompt is auto-accepted by any scripted
 * client, which makes it no confirmation at all, so the first test asserts
 * that the click alone deletes nothing.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { PluginServiceSummary, PluginSummary } from "@valet/api/wire";

const disconnectMutate = vi.fn();
let disconnectPending = false;
let disconnectError: Error | null = null;
// React Query's own `reset()` drops the error the last attempt left behind, so
// the double drops it too. A `vi.fn()` that only records the call cannot tell a
// dialog that cleared the refusal from one that still shows it.
const disconnectReset = vi.fn(() => {
  disconnectError = null;
});

vi.mock("~/api/integrations", () => ({
  useDisconnectCredential: () => ({
    mutate: disconnectMutate,
    isPending: disconnectPending,
    error: disconnectError,
    reset: disconnectReset,
  }),
  useConnectCredential: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useCredentials: () => ({ data: { credentials: [] }, isLoading: false, error: null }),
  useDelegateCredential: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useRevokeDelegation: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
}));

vi.mock("~/api/repos", () => ({
  useConnectGithub: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useGithubOrgStatus: () => ({ data: undefined }),
}));

vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { id: "u1", name: "Signed In Person", orgRole: "member" } }),
  useTeams: () => ({ data: { teams: [] } }),
  useOrg: () => ({ data: undefined }),
}));

vi.mock("~/api/queries", () => ({
  useIdentityLinks: () => ({ data: undefined, isLoading: false }),
  useStartIdentityLink: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useDeliverIdentityLink: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useUnlinkIdentity: () => ({ mutate: vi.fn(), isPending: false, error: null , reset: vi.fn() }),
  useLinkMembers: () => ({ data: undefined, isLoading: false }),
}));

import { IntegrationRow } from "./integration-row";

const SERVICE: PluginServiceSummary = {
  service: "linear",
  type: "oauth2",
  configKeys: [],
  connected: true,
  connect: "oauth",
  actions: [],
};

const PLUGIN: PluginSummary = {
  name: "linear",
  version: "1.0.0",
  displayName: "Linear",
  description: "Issues and projects.",
  actionCount: 4,
  services: [SERVICE],
};

function nativeConfirm() {
  const spy = vi.fn(() => true);
  window.confirm = spy;
  return spy;
}

describe("IntegrationRow disconnect", () => {
  beforeEach(() => {
    disconnectMutate.mockReset();
    disconnectReset.mockClear();
    disconnectPending = false;
    disconnectError = null;
  });

  it("asks in a dialog and deletes nothing on the click alone", () => {
    const confirmSpy = nativeConfirm();
    render(<IntegrationRow plugin={PLUGIN} />);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect Linear" }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Disconnect Linear?")).toBeTruthy();
    expect(disconnectMutate).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("names what disconnecting costs and how to undo it", () => {
    render(<IntegrationRow plugin={PLUGIN} />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Linear" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("deletes the saved Linear credential");
    expect(dialog.textContent).toContain("until you connect it again");
  });

  it("deletes the credential when the dialog is confirmed", async () => {
    render(<IntegrationRow plugin={PLUGIN} />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Linear" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(disconnectMutate).toHaveBeenCalledTimes(1));
    // The same argument the pre-dialog click passed, plus the close-on-success
    // callback the dialog needs.
    expect(disconnectMutate).toHaveBeenCalledWith({ service: "linear" }, expect.anything());
  });

  it("deletes nothing when the dialog is cancelled", async () => {
    render(<IntegrationRow plugin={PLUGIN} />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Linear" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(disconnectMutate).not.toHaveBeenCalled();
  });

  it("shows the server's error instead of swallowing it", async () => {
    const { rerender } = render(<IntegrationRow plugin={PLUGIN} />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Linear" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(disconnectMutate).toHaveBeenCalledTimes(1));

    // The refusal lands the way it does in production: after the request the
    // open dialog sent, not before the dialog opened.
    disconnectError = new Error("Linear rejected the request");
    rerender(<IntegrationRow plugin={PLUGIN} />);

    expect(screen.getByRole("dialog").textContent).toContain("Linear rejected the request");
  });

  it("reopening after a refusal starts with no error", () => {
    // A refused attempt is still on the mutation, because React Query holds
    // `error` until the next mutate. Opening the dialog again must not read as
    // a fresh failure of a request the person has not made yet.
    disconnectError = new Error("Linear rejected the request");
    render(<IntegrationRow plugin={PLUGIN} />);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect Linear" }));

    expect(screen.getByRole("dialog").textContent).not.toContain("Linear rejected the request");
    expect(disconnectReset).toHaveBeenCalledTimes(1);
  });

  it("reports the request in flight, which window.confirm could not", () => {
    const { rerender } = render(<IntegrationRow plugin={PLUGIN} />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Linear" }));

    disconnectPending = true;
    rerender(<IntegrationRow plugin={PLUGIN} />);

    expect(screen.getByRole("dialog").textContent).toContain("Disconnecting…");
  });

  it("keeps the tile's control disabled while the delete runs", () => {
    disconnectPending = true;
    render(<IntegrationRow plugin={PLUGIN} />);

    const control = screen.getByRole("button", { name: "Disconnect Linear" });
    expect(control.hasAttribute("disabled")).toBe(true);
    expect(control.textContent).toContain("Disconnecting…");
  });
});
