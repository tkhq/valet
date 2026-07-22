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
import type { CredentialSummary, GetGithubAppResponse, IdentityLinkStatus } from "@valet/api/wire";
import { ApiError } from "~/api/client";

const startMutateAsync = vi.fn();
const setNotifyMutate = vi.fn();
const unlinkMutate = vi.fn();
const connectGithubMutateAsync = vi.fn();
const disconnectGithubMutate = vi.fn();
const disconnectCredentialMutate = vi.fn();
const startSlackMutateAsync = vi.fn();
const verifySlackMutateAsync = vi.fn();

let linksData: { links: IdentityLinkStatus[] } | undefined;
let isLoading = false;
let isError = false;
let credentialsData: { credentials: CredentialSummary[] } | undefined = { credentials: [] };
let credentialsLoading = false;
let credentialsError = false;
let githubAppData: GetGithubAppResponse | undefined;
let slackMembersData: { members: Array<{ id: string; name: string; realName?: string }> } | undefined;
let slackMembersError: Error | null = null;

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
}));

vi.mock("~/api/queries", () => ({
  useIdentityLinks: () => ({ data: linksData, isLoading, error: isError ? new Error("boom") : null }),
  useStartIdentityLink: () => ({ mutateAsync: startMutateAsync, isPending: false }),
  useSetLinkNotify: () => ({ mutate: setNotifyMutate }),
  useUnlinkIdentity: () => ({ mutate: unlinkMutate, isPending: false }),
  useSlackWorkspaceMembers: (q: string, enabled: boolean) => ({
    data: enabled ? slackMembersData : undefined,
    isLoading: false,
    error: enabled ? slackMembersError : null,
  }),
  useStartSlackLink: () => ({ mutateAsync: startSlackMutateAsync, isPending: false }),
  useVerifySlackLink: () => ({ mutateAsync: verifySlackMutateAsync, isPending: false }),
}));

// Make the typeahead debounce synchronous — these tests assert on the flow,
// not the 300ms trailing edge.
vi.mock("~/hooks/use-debounced-value", () => ({
  useDebouncedValue: <T,>(value: T) => value,
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
}));

vi.mock("~/api/settings", () => ({
  useGithubApp: () => ({ data: githubAppData, isLoading: false, error: null }),
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
    slackMembersData = undefined;
    slackMembersError = null;
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
      delivery: "deep_link",
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
    const toggle = screen.getByRole("switch", { name: "Notify on attention (Telegram)" });
    fireEvent.click(toggle);
    expect(setNotifyMutate).toHaveBeenCalledWith({ provider: "telegram", notifyAttention: false });

    fireEvent.click(screen.getByRole("button", { name: "Disconnect Telegram" }));
    expect(unlinkMutate).toHaveBeenCalledWith("telegram");
  });

  describe("Slack block", () => {
    it("shows the unconfigured copy when channelReady is false", () => {
      linksData = {
        links: [{ provider: "slack", linked: false, channelReady: false }],
      };
      render(<ConnectedAccountsPage />);
      expect(
        screen.getByText(
          "Slack isn't configured for this organization yet. An admin can add a bot token under Integrations.",
        ),
      ).toBeTruthy();
      expect(screen.queryByLabelText("Find your Slack account")).toBeNull();
    });

    it("typeahead → pick a member → send code → verify links the account", async () => {
      linksData = {
        links: [{ provider: "slack", linked: false, channelReady: true }],
      };
      slackMembersData = {
        members: [
          { id: "U1", name: "conner", realName: "Conner Swann" },
          { id: "U2", name: "connerbot" },
        ],
      };
      startSlackMutateAsync.mockResolvedValue({ delivery: "dm_code", expiresInSeconds: 600 });
      verifySlackMutateAsync.mockResolvedValue({ ok: true });
      render(<ConnectedAccountsPage />);

      // <2 chars: no results yet.
      const search = screen.getByLabelText("Find your Slack account");
      fireEvent.change(search, { target: { value: "c" } });
      expect(screen.queryByRole("button", { name: /@conner/ })).toBeNull();

      fireEvent.change(search, { target: { value: "conner" } });
      const option = await screen.findByRole("button", { name: /@conner Conner Swann/ });
      expect(screen.getByRole("button", { name: "@connerbot" })).toBeTruthy();
      fireEvent.click(option);

      fireEvent.click(screen.getByRole("button", { name: "Send link code" }));
      await waitFor(() =>
        expect(startSlackMutateAsync).toHaveBeenCalledWith({ externalId: "U1" }),
      );

      expect(await screen.findByText("We DMed a code to @conner — enter it here.")).toBeTruthy();
      fireEvent.change(screen.getByLabelText("Link code"), { target: { value: "424242" } });
      fireEvent.click(screen.getByRole("button", { name: "Verify" }));
      await waitFor(() =>
        expect(verifySlackMutateAsync).toHaveBeenCalledWith({ code: "424242" }),
      );
    });

    it("Send link code is disabled until a member is selected", async () => {
      linksData = {
        links: [{ provider: "slack", linked: false, channelReady: true }],
      };
      slackMembersData = { members: [{ id: "U1", name: "conner" }] };
      render(<ConnectedAccountsPage />);

      const send = screen.getByRole("button", { name: "Send link code" });
      expect(send).toHaveProperty("disabled", true);
      fireEvent.change(screen.getByLabelText("Find your Slack account"), {
        target: { value: "conner" },
      });
      fireEvent.click(await screen.findByRole("button", { name: "@conner" }));
      expect(send).toHaveProperty("disabled", false);
    });

    it("shows the invalid-code error inline and stays on the code step", async () => {
      linksData = {
        links: [{ provider: "slack", linked: false, channelReady: true }],
      };
      slackMembersData = { members: [{ id: "U1", name: "conner" }] };
      startSlackMutateAsync.mockResolvedValue({ delivery: "dm_code", expiresInSeconds: 600 });
      verifySlackMutateAsync.mockRejectedValue(
        new ApiError(400, "POST /me/identity-links/slack/verify → 400", {
          error: "invalid or expired code",
        }),
      );
      render(<ConnectedAccountsPage />);

      fireEvent.change(screen.getByLabelText("Find your Slack account"), {
        target: { value: "conner" },
      });
      fireEvent.click(await screen.findByRole("button", { name: "@conner" }));
      fireEvent.click(screen.getByRole("button", { name: "Send link code" }));

      fireEvent.change(await screen.findByLabelText("Link code"), { target: { value: "nope" } });
      fireEvent.click(screen.getByRole("button", { name: "Verify" }));

      expect(await screen.findByText("invalid or expired code")).toBeTruthy();
      expect(screen.getByLabelText("Link code")).toBeTruthy();
    });

    it("linked state shows externalId, a notify switch, and disconnect wired to slack", () => {
      linksData = {
        links: [
          {
            provider: "slack",
            linked: true,
            channelReady: true,
            externalId: "U12345",
            notifyAttention: false,
            createdAt: Date.parse("2026-02-01T00:00:00Z"),
          },
        ],
      };
      render(<ConnectedAccountsPage />);

      expect(screen.getByText("U12345")).toBeTruthy();
      fireEvent.click(screen.getByRole("switch", { name: "Notify on attention (Slack)" }));
      expect(setNotifyMutate).toHaveBeenCalledWith({ provider: "slack", notifyAttention: true });

      fireEvent.click(screen.getByRole("button", { name: "Disconnect Slack" }));
      expect(unlinkMutate).toHaveBeenCalledWith("slack");
    });
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
      expect(disconnectCredentialMutate).toHaveBeenCalledWith("linear");
    });
  });
});
