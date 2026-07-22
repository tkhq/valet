// @vitest-environment jsdom
/**
 * `/settings/connected-accounts` — Telegram identity linking (Task 11).
 * Mocks `~/api/queries` the same way `-settings.sections.test.tsx` mocks it
 * for the notifications toggle: these tests only care what the page renders
 * and which mutation it fires, not that TanStack Query itself resolves
 * anything.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  CredentialSummary,
  GetGithubAppResponse,
  IdentityLinkStatus,
  ListOpItemsResponse,
  ListOpVaultsResponse,
  OnePasswordSettingsResponse,
  OpItemDetailResponse,
} from "@valet/api/wire";
import { ApiError } from "~/api/client";

const startMutateAsync = vi.fn();
const setNotifyMutate = vi.fn();
const unlinkMutate = vi.fn();
const connectGithubMutateAsync = vi.fn();
const disconnectGithubMutate = vi.fn();
const disconnectCredentialMutate = vi.fn();
const connectCredentialMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const connectCredentialMutate = vi.fn();

let linksData: { links: IdentityLinkStatus[] } | undefined;
let isLoading = false;
let isError = false;
let credentialsData: { credentials: CredentialSummary[] } | undefined = { credentials: [] };
let credentialsLoading = false;
let credentialsError = false;
let githubAppData: GetGithubAppResponse | undefined;
let onePasswordSettingsData: OnePasswordSettingsResponse | undefined = {
  allowPersonal: false,
  orgTokenConnected: false,
  personalTokenConnected: false,
};
let opVaultsData: ListOpVaultsResponse = { vaults: [{ id: "v1", title: "Vault One" }] };
let opItemsData: ListOpItemsResponse = { items: [{ id: "i1", title: "Item One", vaultId: "v1" }] };
let opItemDetailData: OpItemDetailResponse = {
  id: "i1",
  title: "Item One",
  fields: [{ id: "f1", title: "credential", fieldType: "CONCEALED" }],
};

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
}));

vi.mock("~/api/queries", () => ({
  useIdentityLinks: () => ({ data: linksData, isLoading, error: isError ? new Error("boom") : null }),
  useStartIdentityLink: () => ({ mutateAsync: startMutateAsync, isPending: false }),
  useSetLinkNotify: () => ({ mutate: setNotifyMutate }),
  useUnlinkIdentity: () => ({ mutate: unlinkMutate, isPending: false }),
}));

vi.mock("~/api/repos", () => ({
  useConnectGithub: () => ({ mutateAsync: connectGithubMutateAsync, isPending: false }),
  useDisconnectGithub: () => ({ mutate: disconnectGithubMutate, isPending: false }),
}));

vi.mock("~/api/integrations", () => ({
  useCredentials: () => ({
    data: credentialsData,
    isLoading: credentialsLoading,
    error: credentialsError ? new Error("boom") : null,
  }),
  useDisconnectCredential: () => ({ mutate: disconnectCredentialMutate, isPending: false }),
  useConnectCredential: () => ({
    mutate: connectCredentialMutate,
    mutateAsync: connectCredentialMutateAsync,
    isPending: false,
    error: null,
  }),
}));

vi.mock("~/api/settings", () => ({
  useGithubApp: () => ({ data: githubAppData, isLoading: false, error: null }),
}));

vi.mock("~/api/onepassword", () => ({
  useOnePasswordSettings: () => ({
    data: onePasswordSettingsData,
    isLoading: false,
    error: null,
  }),
  useOpVaults: () => ({ data: opVaultsData, isLoading: false, error: null }),
  useOpItems: (_scope: string, vaultId: string | undefined) => ({
    data: vaultId ? opItemsData : undefined,
    isLoading: false,
    error: null,
  }),
  useOpItemDetail: (_scope: string, vaultId: string | undefined, itemId: string | undefined) => ({
    data: vaultId && itemId ? opItemDetailData : undefined,
    isLoading: false,
    error: null,
  }),
}));

import { ConnectedAccountsPage } from "./settings.connected-accounts";

describe("ConnectedAccountsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    linksData = undefined;
    isLoading = false;
    isError = false;
    credentialsData = { credentials: [] };
    credentialsLoading = false;
    credentialsError = false;
    githubAppData = undefined;
    onePasswordSettingsData = { allowPersonal: false, orgTokenConnected: false, personalTokenConnected: false };
    opVaultsData = { vaults: [{ id: "v1", title: "Vault One" }] };
    opItemsData = { items: [{ id: "i1", title: "Item One", vaultId: "v1" }] };
    opItemDetailData = {
      id: "i1",
      title: "Item One",
      fields: [{ id: "f1", title: "credential", fieldType: "CONCEALED" }],
    };
    connectCredentialMutateAsync.mockResolvedValue({ ok: true });
    vi.stubGlobal("confirm", vi.fn(() => true));
    // jsdom logs "Not implemented: navigation" when a real redirect happens;
    // route it through a plain assignable stub instead.
    Object.defineProperty(window, "location", {
      value: { ...window.location, href: "" },
      writable: true,
    });
  });

  it("shows a loading spinner row", () => {
    isLoading = true;
    render(<ConnectedAccountsPage />);
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("shows failure text on error", () => {
    isError = true;
    render(<ConnectedAccountsPage />);
    expect(screen.getByText("Failed to load connected accounts.")).toBeTruthy();
  });

  it("shows the unconfigured copy with no buttons when channelReady is false", () => {
    linksData = {
      links: [{ provider: "telegram", linked: false, channelReady: false }],
    };
    render(<ConnectedAccountsPage />);
    expect(
      screen.getByText(
        "Telegram isn't configured for this organization yet. An admin can add a bot token under Integrations.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect Telegram" })).toBeNull();
  });

  it("connecting starts the link flow and renders the deep link", async () => {
    linksData = {
      links: [{ provider: "telegram", linked: false, channelReady: true }],
    };
    startMutateAsync.mockResolvedValue({
      deepLink: "https://t.me/valet_bot?start=abc123",
      expiresInSeconds: 600,
    });
    render(<ConnectedAccountsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Connect Telegram" }));

    await waitFor(() => expect(startMutateAsync).toHaveBeenCalled());
    expect(
      await screen.findByRole("link", { name: "Open Telegram and press Start" }),
    ).toHaveProperty("href", "https://t.me/valet_bot?start=abc123");
    expect(screen.getByText("https://t.me/valet_bot?start=abc123")).toBeTruthy();
    expect(screen.getByText(/expires in 10 minutes/)).toBeTruthy();
  });

  it("shows an inline error and no deep link when the start mutation fails", async () => {
    linksData = {
      links: [{ provider: "telegram", linked: false, channelReady: true }],
    };
    startMutateAsync.mockRejectedValue(
      new ApiError(409, "POST /me/identity-links/telegram/start → 409", {
        error: "telegram bot not configured",
      }),
    );
    render(<ConnectedAccountsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Connect Telegram" }));

    expect(await screen.findByText("telegram bot not configured")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open Telegram and press Start" })).toBeNull();
  });

  it("linked state shows externalId, linked-since, a notify switch, and disconnect", () => {
    linksData = {
      links: [
        {
          provider: "telegram",
          linked: true,
          channelReady: true,
          externalId: "123456789",
          notifyAttention: true,
          createdAt: Date.parse("2026-01-01T00:00:00Z"),
        },
      ],
    };
    render(<ConnectedAccountsPage />);

    expect(screen.getByText("123456789")).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Notify on attention" });
    fireEvent.click(toggle);
    expect(setNotifyMutate).toHaveBeenCalledWith({ notifyAttention: false });

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(unlinkMutate).toHaveBeenCalled();
  });

  describe("GitHub row", () => {
    it("unconnected: shows Connect GitHub with no health badges", () => {
      render(<ConnectedAccountsPage />);
      expect(screen.getByRole("button", { name: "Connect GitHub" })).toBeTruthy();
      expect(screen.queryByText("Identity only")).toBeNull();
    });

    it("connecting redirects the browser to the returned url", async () => {
      connectGithubMutateAsync.mockResolvedValue({ url: "https://github.com/login/oauth/authorize?x=1" });
      render(<ConnectedAccountsPage />);

      fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));

      await waitFor(() => expect(connectGithubMutateAsync).toHaveBeenCalled());
      await waitFor(() =>
        expect(window.location.href).toBe("https://github.com/login/oauth/authorize?x=1"),
      );
      expect(confirm).not.toHaveBeenCalled();
    });

    it("identity-only: shows the sign-in-only hint and Connect GitHub (no replace warning)", async () => {
      credentialsData = {
        credentials: [
          {
            service: "github",
            type: "oauth2",
            connectedAt: "2026-01-01T00:00:00Z",
            login: "octocat",
            identityOnly: true,
          },
        ],
      };
      connectGithubMutateAsync.mockResolvedValue({ url: "https://github.com/x" });
      render(<ConnectedAccountsPage />);

      expect(screen.getByText(/sign-in only/i)).toBeTruthy();
      const btn = screen.getByRole("button", { name: "Connect GitHub" });
      fireEvent.click(btn);
      await waitFor(() => expect(connectGithubMutateAsync).toHaveBeenCalled());
      expect(confirm).not.toHaveBeenCalled();
    });

    it("repo-capable: shows login + Connected badge + Disconnect", () => {
      credentialsData = {
        credentials: [
          {
            service: "github",
            type: "oauth2",
            connectedAt: "2026-01-01T00:00:00Z",
            login: "octocat",
          },
        ],
      };
      render(<ConnectedAccountsPage />);
      expect(screen.getByText("octocat")).toBeTruthy();
      expect(screen.getByText("Connected")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Reconnect GitHub" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Disconnect GitHub" })).toBeTruthy();
    });

    it("repo-capable: expired/refresh-failing badges reflect health fields", () => {
      credentialsData = {
        credentials: [
          {
            service: "github",
            type: "oauth2",
            connectedAt: "2026-01-01T00:00:00Z",
            login: "octocat",
            expiresAt: Date.parse("2020-01-01T00:00:00Z"),
            refreshFailedAt: Date.parse("2026-01-01T00:00:00Z"),
          },
        ],
      };
      render(<ConnectedAccountsPage />);
      expect(screen.getByText("Expired")).toBeTruthy();
      expect(screen.getByText("Refresh failed")).toBeTruthy();
    });

    it("REPLACE-WARNING: Reconnect over a repo-capable credential confirms first", async () => {
      credentialsData = {
        credentials: [
          { service: "github", type: "oauth2", connectedAt: "2026-01-01T00:00:00Z", login: "octocat" },
        ],
      };
      connectGithubMutateAsync.mockResolvedValue({ url: "https://github.com/x" });
      render(<ConnectedAccountsPage />);

      fireEvent.click(screen.getByRole("button", { name: "Reconnect GitHub" }));
      expect(confirm).toHaveBeenCalledWith(
        expect.stringContaining("replace your existing GitHub token"),
      );
      await waitFor(() => expect(connectGithubMutateAsync).toHaveBeenCalled());
    });

    it("Disconnect GitHub confirms then fires the disconnect mutation", () => {
      credentialsData = {
        credentials: [
          { service: "github", type: "oauth2", connectedAt: "2026-01-01T00:00:00Z", login: "octocat" },
        ],
      };
      render(<ConnectedAccountsPage />);
      fireEvent.click(screen.getByRole("button", { name: "Disconnect GitHub" }));
      expect(confirm).toHaveBeenCalled();
      expect(disconnectGithubMutate).toHaveBeenCalled();
    });

    it("shows an Install on your personal account link when the org App is configured", () => {
      githubAppData = {
        configured: true,
        app: {
          appId: "1",
          appSlug: "valet-acme",
          htmlUrl: "https://github.com/apps/valet-acme",
          installUrl: "https://github.com/apps/valet-acme/installations/new",
        },
        installations: [],
        webhook: { mode: "public" },
      };
      render(<ConnectedAccountsPage />);
      expect(
        screen.getByRole("link", { name: "Install on your personal account" }),
      ).toHaveProperty("href", "https://github.com/apps/valet-acme/installations/new");
    });

    it("omits the install link when the org App isn't configured", () => {
      githubAppData = { configured: false, installations: [], webhook: { mode: "manual" } };
      render(<ConnectedAccountsPage />);
      expect(screen.queryByRole("link", { name: "Install on your personal account" })).toBeNull();
    });
  });

  describe("Credentials list", () => {
    it("shows a quiet empty state with no credentials", () => {
      render(<ConnectedAccountsPage />);
      expect(screen.getByText("No other services connected.")).toBeTruthy();
    });

    it("lists non-GitHub credentials with type and a revoke button, excluding GitHub (shown above)", () => {
      credentialsData = {
        credentials: [
          { service: "github", type: "oauth2", connectedAt: "2026-01-01T00:00:00Z", login: "octocat" },
          { service: "linear", type: "api_key", connectedAt: "2026-01-02T00:00:00Z" },
        ],
      };
      render(<ConnectedAccountsPage />);
      expect(screen.getByText("linear")).toBeTruthy();
      expect(screen.queryByText("No other services connected.")).toBeNull();
      // Only one Disconnect/Revoke control for github (from the row above);
      // linear gets its own Revoke button in the generic list.
      expect(screen.getByRole("button", { name: "Revoke linear" })).toBeTruthy();
    });

    it("revoke confirms then calls the delete-credential mutation", () => {
      credentialsData = {
        credentials: [{ service: "linear", type: "api_key", connectedAt: "2026-01-02T00:00:00Z" }],
      };
      render(<ConnectedAccountsPage />);
      fireEvent.click(screen.getByRole("button", { name: "Revoke linear" }));
      expect(confirm).toHaveBeenCalled();
      expect(disconnectCredentialMutate).toHaveBeenCalledWith({ service: "linear" });
    });

    it("shows the 1Password reference badge on a reference-backed row, no paste-token affordance", () => {
      credentialsData = {
        credentials: [
          {
            service: "linear",
            type: "api_key",
            connectedAt: "2026-01-02T00:00:00Z",
            onepasswordRef: "op://Vault One/Item One/credential",
          },
        ],
      };
      render(<ConnectedAccountsPage />);
      expect(screen.getByText("op://Vault One/Item One/credential")).toBeTruthy();
      // Deletion still works via the normal Revoke control — no separate
      // "edit"/"paste new token" affordance for a reference-backed row.
      expect(screen.getByRole("button", { name: "Revoke linear" })).toBeTruthy();
    });
  });

  describe("1Password", () => {
    it("hides the personal token card entirely when allowPersonal is false", () => {
      onePasswordSettingsData = { allowPersonal: false, orgTokenConnected: false, personalTokenConnected: false };
      render(<ConnectedAccountsPage />);
      expect(screen.queryByLabelText("1Password personal token")).toBeNull();
    });

    it("shows the personal token card when allowPersonal is true", () => {
      onePasswordSettingsData = { allowPersonal: true, orgTokenConnected: false, personalTokenConnected: false };
      render(<ConnectedAccountsPage />);
      expect(screen.getByLabelText("1Password personal token")).toBeTruthy();
    });

    it("shows Connected on the personal token card when personalTokenConnected", () => {
      onePasswordSettingsData = { allowPersonal: true, orgTokenConnected: false, personalTokenConnected: true };
      render(<ConnectedAccountsPage />);
      expect(screen.getByText("Connected")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Rotate" })).toBeTruthy();
    });

    it("saving the personal token fires the connect mutation with no scope field", async () => {
      onePasswordSettingsData = { allowPersonal: true, orgTokenConnected: false, personalTokenConnected: false };
      const user = userEvent.setup();
      render(<ConnectedAccountsPage />);
      await user.type(screen.getByLabelText("1Password personal token"), "op-personal-token");
      await user.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() =>
        expect(connectCredentialMutateAsync).toHaveBeenCalledWith({
          service: "onepassword",
          body: { type: "service_account", apiKey: "op-personal-token" },
        }),
      );
    });

    it("the tokenScope selector offers only Personal when the org token isn't connected", async () => {
      onePasswordSettingsData = { allowPersonal: true, orgTokenConnected: false, personalTokenConnected: false };
      const user = userEvent.setup();
      render(<ConnectedAccountsPage />);
      await user.click(screen.getByRole("button", { name: "Add from 1Password" }));
      const scopeSelect = screen.getByLabelText("1Password token") as HTMLSelectElement;
      const optionLabels = Array.from(scopeSelect.options).map((o) => o.textContent);
      expect(optionLabels).toEqual(["Personal"]);
    });

    it("the tokenScope selector offers Organization once the org token is connected", async () => {
      onePasswordSettingsData = { allowPersonal: true, orgTokenConnected: true, personalTokenConnected: false };
      const user = userEvent.setup();
      render(<ConnectedAccountsPage />);
      await user.click(screen.getByRole("button", { name: "Add from 1Password" }));
      const scopeSelect = screen.getByLabelText("1Password token") as HTMLSelectElement;
      const optionLabels = Array.from(scopeSelect.options).map((o) => o.textContent);
      expect(optionLabels).toEqual(["Personal", "Organization"]);
    });

    it("picker cascade — selecting vault loads items, selecting item loads fields, selecting field composes the reference and creating fires the PUT", async () => {
      onePasswordSettingsData = { allowPersonal: false, orgTokenConnected: false, personalTokenConnected: false };
      const user = userEvent.setup();
      render(<ConnectedAccountsPage />);

      await user.click(screen.getByRole("button", { name: "Add from 1Password" }));
      await user.type(screen.getByLabelText("Service name"), "linear");

      const vaultSelect = screen.getByLabelText("Vault") as HTMLSelectElement;
      const itemSelect = screen.getByLabelText("Item") as HTMLSelectElement;
      const fieldSelect = screen.getByLabelText("Field") as HTMLSelectElement;
      expect(itemSelect.disabled).toBe(true);
      expect(fieldSelect.disabled).toBe(true);

      await user.selectOptions(vaultSelect, "v1");
      expect(itemSelect.disabled).toBe(false);

      await user.selectOptions(itemSelect, "i1");
      expect(fieldSelect.disabled).toBe(false);

      await user.selectOptions(fieldSelect, "f1");
      expect(screen.getByText("op://Vault One/Item One/credential")).toBeTruthy();

      await user.click(screen.getByRole("button", { name: "Add" }));
      expect(connectCredentialMutate).toHaveBeenCalledWith(
        {
          service: "linear",
          body: {
            type: "api_key",
            onepassword: { reference: "op://Vault One/Item One/credential", tokenScope: "personal" },
          },
        },
        expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
      );
    });

    it("surfaces an inline error (not a toast) when saving the personal token fails", async () => {
      onePasswordSettingsData = { allowPersonal: true, orgTokenConnected: false, personalTokenConnected: false };
      connectCredentialMutateAsync.mockRejectedValueOnce(
        new ApiError(400, "PUT /credentials/onepassword → 400", {
          error: "personal 1Password tokens are disabled by your organization",
        }),
      );
      const user = userEvent.setup();
      render(<ConnectedAccountsPage />);
      await user.type(screen.getByLabelText("1Password personal token"), "bad-token");
      await user.click(screen.getByRole("button", { name: "Save" }));

      expect(
        await screen.findByText("personal 1Password tokens are disabled by your organization"),
      ).toBeTruthy();
    });
  });
});
