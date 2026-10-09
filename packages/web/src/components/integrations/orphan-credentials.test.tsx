// @vitest-environment jsdom
/**
 * Integrations is the one place a person manages service credentials, so a
 * credential no listed plugin covers still gets a Revoke control there
 * (settings-redesign spec, "One place per thing").
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CredentialSummary, PluginSummary } from "@valet/api/wire";
import { ApiError } from "~/api/client";

const disconnectMutate = vi.fn(
  (_vars: { service: string }, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.(),
);
let disconnectState: { isPending: boolean; error: Error | null; variables?: { service: string } } = {
  isPending: false,
  error: null,
};
let credentials: CredentialSummary[] = [];

vi.mock("~/api/integrations", () => ({
  useCredentials: () => ({ data: { credentials }, isLoading: false, error: null }),
  useDisconnectCredential: () => ({ mutate: disconnectMutate, ...disconnectState, reset: vi.fn() }),
}));

import { OrphanCredentials, orphanCredentials } from "./orphan-credentials";

function cred(service: string, extra: Partial<CredentialSummary> = {}): CredentialSummary {
  return { service, type: "api_key", connectedAt: "2026-01-02T00:00:00Z", ...extra };
}

function plugin(name: string, services: string[]): PluginSummary {
  return {
    name,
    version: "1.0.0",
    actionCount: 0,
    services: services.map((service) => ({
      service, type: "api_key" as const, configKeys: [], connected: false, connect: "manual" as const, actions: [],
    })),
  };
}

const plugins = [plugin("github", ["github"]), plugin("notion", ["notion"])];

beforeEach(() => {
  vi.clearAllMocks();
  disconnectState = { isPending: false, error: null };
  credentials = [];
});

describe("orphanCredentials", () => {
  it("keeps credentials no listed service covers, and never the 1Password token", () => {
    const rows = [cred("github"), cred("notion"), cred("legacy-crm"), cred("onepassword")];
    expect(orphanCredentials(rows, plugins).map((row) => row.service)).toEqual(["legacy-crm"]);
  });
});

describe("OrphanCredentials", () => {
  it("renders nothing when every credential has a row", () => {
    credentials = [cred("notion")];
    const { container } = render(<OrphanCredentials plugins={plugins} />);
    expect(container.textContent).toBe("");
  });

  it("revoke asks in-page, then deletes that credential", async () => {
    credentials = [cred("legacy-crm"), cred("old-tool")];
    render(<OrphanCredentials plugins={plugins} />);

    fireEvent.click(screen.getByRole("button", { name: "Revoke Old tool" }));
    expect(disconnectMutate).not.toHaveBeenCalled();
    const dialogs = await screen.findAllByRole("dialog");
    expect(dialogs).toHaveLength(1);
    expect(within(dialogs[0]!).getByText("Revoke Old tool?")).toBeTruthy();

    fireEvent.click(within(dialogs[0]!).getByRole("button", { name: "Revoke" }));
    expect(disconnectMutate.mock.calls[0]?.[0]).toEqual({ service: "old-tool" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says the 1Password item survives on a reference-backed row", async () => {
    credentials = [cred("legacy-crm", { onepasswordRef: "op://Vault One/Item One/credential" })];
    render(<OrphanCredentials plugins={plugins} />);
    expect(screen.getByText("op://Vault One/Item One/credential")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Revoke Legacy crm" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/The item in 1Password is not deleted/)).toBeTruthy();
  });

  it("shows a refusal only in the dialog of the row it was fired for", async () => {
    const refusal = "A team workflow uses this credential. Remove the delegation, then revoke.";
    disconnectState = {
      isPending: false,
      error: new ApiError(409, "DELETE /credentials/legacy-crm → 409", { error: refusal }),
      variables: { service: "legacy-crm" },
    };
    credentials = [cred("legacy-crm"), cred("old-tool")];
    render(<OrphanCredentials plugins={plugins} />);

    fireEvent.click(screen.getByRole("button", { name: "Revoke Legacy crm" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(refusal)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Revoke Old tool" }));
    const next = await screen.findByRole("dialog");
    expect(within(next).queryByText(refusal)).toBeNull();
  });
});
