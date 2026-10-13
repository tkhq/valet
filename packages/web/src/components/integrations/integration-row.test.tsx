// @vitest-environment jsdom
/**
 * Disconnect destroys a credential, so it asks in a `ConfirmDialog` and never
 * in `window.confirm`: any scripted client auto-accepts the native prompt,
 * which makes it no confirmation at all.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { CredentialSummary, PluginServiceSummary, PluginSummary } from "@valet/api/wire";

const disconnectMutate = vi.fn();
let disconnectPending = false;
let disconnectError: Error | null = null;
// Clears like the real `reset()`: a `vi.fn()` that only records the call
// cannot tell a dialog that dropped the refusal from one that still shows it.
const disconnectReset = vi.fn(() => {
  disconnectError = null;
});

let credentials: CredentialSummary[] = [];

vi.mock("~/api/integrations", () => ({
  useDisconnectCredential: () => ({
    mutate: disconnectMutate,
    isPending: disconnectPending,
    error: disconnectError,
    reset: disconnectReset,
  }),
  useConnectCredential: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useCredentials: () => ({ data: { credentials }, isLoading: false, error: null }),
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

vi.mock("~/api/workflows", () => ({ useTriggerCatalog: () => ({ data: { catalog: [] } }) }));

import { IntegrationDetail } from "./integration-row";

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
    credentials = [];
    disconnectMutate.mockReset();
    disconnectReset.mockClear();
    disconnectPending = false;
    disconnectError = null;
  });

  it("does not offer Disconnect for an organization-provided Slack bot", () => {
    const orgSlack: PluginSummary = {
      ...PLUGIN,
      name: "slack",
      services: [{
        service: "slack",
        type: "bot_token",
        configKeys: ["accessToken"],
        connected: false,
        connect: "org",
        actions: [],
      }],
    };

    render(<IntegrationDetail plugin={orgSlack} />);

    expect(screen.queryByRole("button", { name: /Disconnect Slack/ })).toBeNull();
  });

  it("asks in a dialog, naming the cost and the way back, and deletes nothing yet", () => {
    const confirmSpy = nativeConfirm();
    render(<IntegrationDetail plugin={PLUGIN} />);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect Linear" }));

    const dialog = screen.getByRole("dialog");
    expect(screen.getByText("Disconnect Linear?")).toBeTruthy();
    expect(dialog.textContent).toContain("deletes the saved Linear credential");
    expect(disconnectMutate).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("says a 1Password reference leaves the 1Password item in place", () => {
    credentials = [{ service: "linear", type: "oauth2", connectedAt: "2026-01-01T00:00:00Z", onepasswordRef: "op://Work/Linear/token" }];
    render(<IntegrationDetail plugin={PLUGIN} />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Linear" }));
    const text = screen.getByRole("dialog").textContent ?? "";
    expect(text).toContain("deletes the stored Linear reference");
    expect(text).toContain("The item in 1Password is not deleted.");
  });

  it("deletes the credential when the dialog is confirmed", async () => {
    render(<IntegrationDetail plugin={PLUGIN} />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Linear" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(disconnectMutate).toHaveBeenCalledTimes(1));
    // The argument the pre-dialog click passed, plus the close-on-success
    // callback the dialog adds.
    expect(disconnectMutate).toHaveBeenCalledWith({ service: "linear" }, expect.anything());
  });

  it("deletes nothing when the dialog is cancelled", async () => {
    render(<IntegrationDetail plugin={PLUGIN} />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Linear" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(disconnectMutate).not.toHaveBeenCalled();
  });

  it("shows the server's error instead of swallowing it", async () => {
    const { rerender } = render(<IntegrationDetail plugin={PLUGIN} />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Linear" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(disconnectMutate).toHaveBeenCalledTimes(1));

    // Production order: the refusal answers the request the open dialog sent.
    disconnectError = new Error("Linear rejected the request");
    rerender(<IntegrationDetail plugin={PLUGIN} />);

    expect(screen.getByRole("dialog").textContent).toContain("Linear rejected the request");
  });

  it("reopening after a refusal starts with no error", () => {
    // React Query holds `error` until the next mutate, so a refused attempt is
    // still on the mutation. Reopening must not read as a fresh failure of a
    // request the person has not made yet.
    disconnectError = new Error("Linear rejected the request");
    render(<IntegrationDetail plugin={PLUGIN} />);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect Linear" }));

    expect(screen.getByRole("dialog").textContent).not.toContain("Linear rejected the request");
    expect(disconnectReset).toHaveBeenCalledTimes(1);
  });

  it("reports the request in flight inside the dialog", () => {
    const { rerender } = render(<IntegrationDetail plugin={PLUGIN} />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Linear" }));

    disconnectPending = true;
    rerender(<IntegrationDetail plugin={PLUGIN} />);

    expect(screen.getByRole("dialog").textContent).toContain("Disconnecting…");
  });

  it("keeps the tile's control disabled while the delete runs", () => {
    disconnectPending = true;
    render(<IntegrationDetail plugin={PLUGIN} />);

    const control = screen.getByRole("button", { name: "Disconnect Linear" });
    expect(control.hasAttribute("disabled")).toBe(true);
    expect(control.textContent).toContain("Disconnecting…");
  });
});
