// @vitest-environment jsdom
/**
 * Disconnect destroys a credential, so it asks in a `ConfirmDialog` and never
 * in `window.confirm`: any scripted client auto-accepts the native prompt,
 * which makes it no confirmation at all.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { PluginServiceSummary, PluginSummary } from "@valet/api/wire";

const disconnectMutate = vi.fn();
let disconnectPending = false;
let disconnectError: Error | null = null;
// Clears like the real `reset()`: a `vi.fn()` that only records the call
// cannot tell a dialog that dropped the refusal from one that still shows it.
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

  it("asks in a dialog, naming the cost and the way back, and deletes nothing yet", () => {
    const confirmSpy = nativeConfirm();
    render(<IntegrationRow plugin={PLUGIN} />);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect Linear" }));

    const dialog = screen.getByRole("dialog");
    expect(screen.getByText("Disconnect Linear?")).toBeTruthy();
    expect(dialog.textContent).toContain("deletes the saved Linear credential");
    expect(dialog.textContent).toContain("until you connect it again");
    expect(disconnectMutate).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("deletes the credential when the dialog is confirmed", async () => {
    render(<IntegrationRow plugin={PLUGIN} />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Linear" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(disconnectMutate).toHaveBeenCalledTimes(1));
    // The argument the pre-dialog click passed, plus the close-on-success
    // callback the dialog adds.
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

    // Production order: the refusal answers the request the open dialog sent.
    disconnectError = new Error("Linear rejected the request");
    rerender(<IntegrationRow plugin={PLUGIN} />);

    expect(screen.getByRole("dialog").textContent).toContain("Linear rejected the request");
  });

  it("reopening after a refusal starts with no error", () => {
    // React Query holds `error` until the next mutate, so a refused attempt is
    // still on the mutation. Reopening must not read as a fresh failure of a
    // request the person has not made yet.
    disconnectError = new Error("Linear rejected the request");
    render(<IntegrationRow plugin={PLUGIN} />);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect Linear" }));

    expect(screen.getByRole("dialog").textContent).not.toContain("Linear rejected the request");
    expect(disconnectReset).toHaveBeenCalledTimes(1);
  });

  it("reports the request in flight inside the dialog", () => {
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
