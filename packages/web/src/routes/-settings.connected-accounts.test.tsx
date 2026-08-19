// @vitest-environment jsdom
/**
 * `/settings/connected-accounts` — provider-driven identity linking (Task 9).
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
// Controls the mocked useStartIdentityLink pending state per test.
let startLinkState: { isPending: boolean; variables?: string } = { isPending: false };
const setNotifyMutate = vi.fn();
const unlinkMutate = vi.fn();
const connectGithubMutateAsync = vi.fn();
const disconnectGithubMutate = vi.fn();
const disconnectCredentialMutate = vi.fn();

let linksData: { links: IdentityLinkStatus[] } | undefined;
let isLoading = false;
let isError = false;
let credentialsData: { credentials: CredentialSummary[] } | undefined = { credentials: [] };
let credentialsLoading = false;
let credentialsError = false;
let githubAppData: GetGithubAppResponse | undefined;

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
}));

// importOriginal: see -new-session-dialog.test.tsx for why a bare
// replacement here is unsafe under vitest.config.ts's isolate:false.
vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useIdentityLinks: () => ({ data: linksData, isLoading, error: isError ? new Error("boom") : null }),
    useStartIdentityLink: () => ({ mutateAsync: startMutateAsync, ...startLinkState }),
    // provider argument accepted but ignored — mocks return fixed stubs
    useSetLinkNotify: (_provider: string) => ({ mutate: setNotifyMutate }),
    useUnlinkIdentity: (_provider: string) => ({ mutate: unlinkMutate, isPending: false }),
  };
});

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

// importOriginal: see -new-session-dialog.test.tsx (packages/web root) for
// why a bare replacement here is unsafe under vitest.config.ts's isolate:false.
vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useGithubApp: () => ({ data: githubAppData, isLoading: false, error: null }),
  };
});

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
      links: [{ provider: "telegram", linked: false, channelReady: false, codeDelivery: false, memberSearch: false }],
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
      links: [{ provider: "telegram", linked: false, channelReady: true, codeDelivery: false, memberSearch: false }],
    };
    startMutateAsync.mockResolvedValue({
      deepLink: "https://t.me/valet_bot?start=abc123",
      code: "abc123",
      instructions: "Send this code to @valet_bot.",
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
    // code and instructions always render
    expect(screen.getByText("abc123")).toBeTruthy();
    expect(screen.getByText("Send this code to @valet_bot.")).toBeTruthy();
  });

  it("shows an inline error and no deep link when the start mutation fails", async () => {
    linksData = {
      links: [{ provider: "telegram", linked: false, channelReady: true, codeDelivery: false, memberSearch: false }],
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
          codeDelivery: false,
          memberSearch: false,
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
        installationsCheckedAt: null,
      };
      render(<ConnectedAccountsPage />);
      expect(
        screen.getByRole("link", { name: "Install on your personal account" }),
      ).toHaveProperty("href", "https://github.com/apps/valet-acme/installations/new");
    });

    it("omits the install link when the org App isn't configured", () => {
      githubAppData = { configured: false, installations: [], webhook: { mode: "manual" }, installationsCheckedAt: null };
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

  describe("multi-provider cards", () => {
    it("renders one card per entry in the links response (telegram + slack)", () => {
      linksData = {
        links: [
          { provider: "telegram", linked: false, channelReady: true, codeDelivery: false, memberSearch: false },
          { provider: "slack", linked: false, channelReady: true, codeDelivery: false, memberSearch: false },
        ],
      };
      render(<ConnectedAccountsPage />);
      expect(screen.getByRole("button", { name: "Connect Telegram" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Connect Slack" })).toBeTruthy();
    });

    it("one provider's in-flight start does not disable the other card's button", () => {
      linksData = {
        links: [
          { provider: "telegram", linked: false, channelReady: true, codeDelivery: false, memberSearch: false },
          { provider: "slack", linked: false, channelReady: true, codeDelivery: false, memberSearch: false },
        ],
      };
      startLinkState = { isPending: true, variables: "slack" };
      render(<ConnectedAccountsPage />);
      const slackBtn = screen.getByRole("button", { name: "Connecting…" });
      expect(slackBtn).toHaveProperty("disabled", true);
      const telegramBtn = screen.getByRole("button", { name: "Connect Telegram" });
      expect(telegramBtn).toHaveProperty("disabled", false);
      startLinkState = { isPending: false };
    });

    it("provider without deepLink shows code + instructions after start, no anchor", async () => {
      linksData = {
        links: [{ provider: "slack", linked: false, channelReady: true, codeDelivery: false, memberSearch: false }],
      };
      startMutateAsync.mockResolvedValue({
        code: "SLACK-CODE-42",
        instructions: "Send this code to @valet in Slack.",
        expiresInSeconds: 300,
      });
      render(<ConnectedAccountsPage />);

      fireEvent.click(screen.getByRole("button", { name: "Connect Slack" }));

      await waitFor(() => expect(startMutateAsync).toHaveBeenCalledWith("slack"));
      expect(await screen.findByText("SLACK-CODE-42")).toBeTruthy();
      expect(screen.getByText("Send this code to @valet in Slack.")).toBeTruthy();
      // No deep-link anchor when deepLink is absent.
      expect(screen.queryByRole("link", { name: "Open Telegram and press Start" })).toBeNull();
    });

    it("telegram card (with deepLink) keeps the anchor after start", async () => {
      linksData = {
        links: [{ provider: "telegram", linked: false, channelReady: true, codeDelivery: false, memberSearch: false }],
      };
      startMutateAsync.mockResolvedValue({
        deepLink: "https://t.me/valet_bot?start=xyz",
        code: "xyz",
        instructions: "Or send the code to @valet_bot.",
        expiresInSeconds: 120,
      });
      render(<ConnectedAccountsPage />);

      fireEvent.click(screen.getByRole("button", { name: "Connect Telegram" }));

      await waitFor(() => expect(startMutateAsync).toHaveBeenCalledWith("telegram"));
      expect(
        await screen.findByRole("link", { name: "Open Telegram and press Start" }),
      ).toHaveProperty("href", "https://t.me/valet_bot?start=xyz");
      expect(screen.getByText("xyz")).toBeTruthy();
    });
  });
});
