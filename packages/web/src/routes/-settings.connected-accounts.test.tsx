// @vitest-environment jsdom
/**
 * `/settings/connected-accounts` — provider-driven identity linking (Task 9).
 * Mocks `~/api/queries` the same way `-settings.sections.test.tsx` mocks it
 * for the notifications toggle: these tests only care what the page renders
 * and which mutation it fires, not that TanStack Query itself resolves
 * anything.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type {
  CredentialSummary,
  GetGithubAppResponse,
  IdentityLinkStatus,
} from "@valet/api/wire";
import { ApiError } from "~/api/client";

const startMutateAsync = vi.fn();
// Controls the mocked useStartIdentityLink pending state per test.
let startLinkState: { isPending: boolean; variables?: string } = { isPending: false };
const setNotifyMutate = vi.fn();
const unlinkMutate = vi.fn();
const connectGithubMutateAsync = vi.fn();
// Both disconnect mutations run their caller's `onSuccess`, which is how the
// page closes each confirm dialog.
const disconnectGithubMutate = vi.fn(
  (_vars?: undefined, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.(),
);
const disconnectCredentialMutate = vi.fn(
  (_vars: { service: string }, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.(),
);
let disconnectGithubState: { isPending: boolean; error: Error | null } = {
  isPending: false,
  error: null,
};
let disconnectCredentialState: {
  isPending: boolean;
  error: Error | null;
  variables?: { service: string };
} = { isPending: false, error: null };
// A real React Query `reset()` clears the mutation's error, and the page
// leans on that to open the disconnect dialog clean. A stub that only counts
// calls would let a dialog full of the previous attempt's refusal pass.
const disconnectGithubReset = vi.fn(() => {
  disconnectGithubState = { ...disconnectGithubState, error: null };
});

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
    useUnlinkIdentity: (_provider: string) => ({ mutate: unlinkMutate, isPending: false , reset: vi.fn() }),
  };
});

vi.mock("~/api/repos", () => ({
  useConnectGithub: () => ({ mutateAsync: connectGithubMutateAsync, isPending: false }),
  useDisconnectGithub: () => ({
    mutate: disconnectGithubMutate,
    ...disconnectGithubState,
    reset: disconnectGithubReset,
  }),
}));

vi.mock("~/api/integrations", () => ({
  useCredentials: () => ({
    data: credentialsData,
    isLoading: credentialsLoading,
    error: credentialsError ? new Error("boom") : null,
  }),
  useDisconnectCredential: () => ({
    mutate: disconnectCredentialMutate,
    ...disconnectCredentialState,
    reset: vi.fn(),
  }),
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

/** The state both GitHub guards (replace on reconnect, disconnect) are
 * written for: a repo-capable credential. */
function renderRepoCapable() {
  credentialsData = {
    credentials: [
      { service: "github", type: "oauth2", connectedAt: "2026-01-01T00:00:00Z", login: "octocat" },
    ],
  };
  connectGithubMutateAsync.mockResolvedValue({ url: "https://github.com/x" });
  return render(<ConnectedAccountsPage />);
}

function renderCredentials(credentials: CredentialSummary[]) {
  credentialsData = { credentials };
  render(<ConnectedAccountsPage />);
}

const linearCred: CredentialSummary = {
  service: "linear",
  type: "api_key",
  connectedAt: "2026-01-02T00:00:00Z",
};
const notionCred: CredentialSummary = {
  service: "notion",
  type: "api_key",
  connectedAt: "2026-01-03T00:00:00Z",
};

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
    disconnectGithubState = { isPending: false, error: null };
    disconnectCredentialState = { isPending: false, error: null };
    // Still stubbed so the tests below can assert the page NEVER reaches for
    // the native dialog, which browser automation accepts for free.
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
      // Nothing to replace on a first connect, so no guard at all.
      expect(screen.queryByRole("dialog")).toBeNull();
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
      expect(screen.queryByRole("dialog")).toBeNull();
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

    it("REPLACE-WARNING: Reconnect asks in-page and starts nothing until confirmed", async () => {
      renderRepoCapable();

      fireEvent.click(screen.getByRole("button", { name: "Reconnect GitHub" }));

      expect(connectGithubMutateAsync).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("Replace your GitHub token?")).toBeTruthy();
      expect(within(dialog).getByText(/replaces the one stored now/)).toBeTruthy();
    });

    it("REPLACE-WARNING: confirming starts the connect flow and redirects", async () => {
      renderRepoCapable();

      fireEvent.click(screen.getByRole("button", { name: "Reconnect GitHub" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Reconnect GitHub" }));

      await waitFor(() => expect(connectGithubMutateAsync).toHaveBeenCalled());
      await waitFor(() => expect(window.location.href).toBe("https://github.com/x"));
    });

    it("REPLACE-WARNING: cancelling starts nothing", async () => {
      renderRepoCapable();

      fireEvent.click(screen.getByRole("button", { name: "Reconnect GitHub" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(connectGithubMutateAsync).not.toHaveBeenCalled();
      expect(window.location.href).toBe("");
    });

    it("REPLACE-WARNING: a failed start names the failure, and reopening starts clean", async () => {
      const refusal = "GitHub App is not configured. Ask an admin to add it under Integrations.";
      renderRepoCapable();
      connectGithubMutateAsync.mockRejectedValue(new Error(refusal));

      fireEvent.click(screen.getByRole("button", { name: "Reconnect GitHub" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Reconnect GitHub" }));
      expect(await within(dialog).findByText(refusal)).toBeTruthy();
      // A start that never began leaves the dialog open, on screen, so the
      // reason sits beside the button that produced it.
      expect(screen.getByRole("dialog")).toBeTruthy();

      // Closing the dialog hands the failure to the row below, which is the
      // only place left to read it.
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(screen.getByText(refusal)).toBeTruthy();

      // Reopening is a fresh attempt, so the previous refusal must not read
      // as this attempt's until the user presses Reconnect again.
      fireEvent.click(screen.getByRole("button", { name: "Reconnect GitHub" }));
      const reopened = await screen.findByRole("dialog");
      expect(within(reopened).queryByText(refusal)).toBeNull();
      expect(screen.queryByText(refusal)).toBeNull();

      fireEvent.click(within(reopened).getByRole("button", { name: "Reconnect GitHub" }));
      expect(await within(reopened).findByText(refusal)).toBeTruthy();
    });

    it("Disconnect GitHub asks in-page and fires nothing until confirmed", async () => {
      renderRepoCapable();

      fireEvent.click(screen.getByRole("button", { name: "Disconnect GitHub" }));

      expect(disconnectGithubMutate).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("Disconnect GitHub?")).toBeTruthy();
      expect(within(dialog).getByText(/clone or push to your repos/)).toBeTruthy();
    });

    it("Disconnect GitHub fires the disconnect mutation once confirmed", async () => {
      renderRepoCapable();

      fireEvent.click(screen.getByRole("button", { name: "Disconnect GitHub" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));

      expect(disconnectGithubMutate).toHaveBeenCalledTimes(1);
      expect(disconnectGithubMutate.mock.calls[0]?.[0]).toBeUndefined();
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("Disconnect GitHub fires nothing when cancelled", async () => {
      renderRepoCapable();

      fireEvent.click(screen.getByRole("button", { name: "Disconnect GitHub" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(disconnectGithubMutate).not.toHaveBeenCalled();
    });

    it("Disconnect GitHub: a refusal shows in the dialog, and reopening starts clean", async () => {
      const refusal = "A running session holds this token. Stop the session, then disconnect.";
      // The state React Query leaves behind after a refused disconnect: the
      // error stays on the mutation until the next mutate.
      disconnectGithubState = {
        isPending: false,
        error: new ApiError(409, "DELETE /me/github → 409", { error: refusal }),
      };
      const { rerender } = renderRepoCapable();

      // Opening is a fresh attempt, so the previous attempt's refusal must not
      // read as this one's.
      fireEvent.click(screen.getByRole("button", { name: "Disconnect GitHub" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).queryByText(refusal)).toBeNull();
      expect(screen.queryByText(refusal)).toBeNull();

      // A refused disconnect never reaches `onSuccess`, so the dialog stays
      // open to carry the failure the mutation settles with.
      disconnectGithubMutate.mockImplementationOnce(() => {});
      fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
      disconnectGithubState = {
        isPending: false,
        error: new ApiError(409, "DELETE /me/github → 409", { error: refusal }),
      };
      rerender(<ConnectedAccountsPage />);

      expect(within(await screen.findByRole("dialog")).getByText(refusal)).toBeTruthy();
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

    it("revoke asks in-page and calls nothing until confirmed", async () => {
      renderCredentials([linearCred]);

      fireEvent.click(screen.getByRole("button", { name: "Revoke linear" }));

      expect(disconnectCredentialMutate).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("Revoke linear?")).toBeTruthy();
      expect(within(dialog).getByText(/Connect linear again to restore access/)).toBeTruthy();
    });

    it("revoke calls the delete-credential mutation once confirmed", async () => {
      renderCredentials([linearCred]);

      fireEvent.click(screen.getByRole("button", { name: "Revoke linear" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));

      expect(disconnectCredentialMutate).toHaveBeenCalledTimes(1);
      expect(disconnectCredentialMutate.mock.calls[0]?.[0]).toEqual({ service: "linear" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("revoke calls nothing when cancelled", async () => {
      renderCredentials([linearCred]);

      fireEvent.click(screen.getByRole("button", { name: "Revoke linear" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(disconnectCredentialMutate).not.toHaveBeenCalled();
    });

    it("one row's revoke opens one dialog, for that row only", async () => {
      renderCredentials([linearCred, notionCred]);

      fireEvent.click(screen.getByRole("button", { name: "Revoke notion" }));

      const dialogs = await screen.findAllByRole("dialog");
      expect(dialogs).toHaveLength(1);
      expect(within(dialogs[0]!).getByText("Revoke notion?")).toBeTruthy();
      expect(within(dialogs[0]!).queryByText("Revoke linear?")).toBeNull();

      fireEvent.click(within(dialogs[0]!).getByRole("button", { name: "Revoke" }));
      expect(disconnectCredentialMutate.mock.calls[0]?.[0]).toEqual({ service: "notion" });
    });

    it("revoke says the 1Password item survives on a reference-backed row", async () => {
      renderCredentials([{ ...linearCred, onepasswordRef: "op://Vault One/Item One/credential" }]);

      fireEvent.click(screen.getByRole("button", { name: "Revoke linear" }));

      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText(/The item in 1Password is not deleted/)).toBeTruthy();
    });

    it("revoke shows the server's refusal in the dialog", async () => {
      disconnectCredentialState = {
        isPending: false,
        error: new ApiError(409, "DELETE /credentials/linear → 409", {
          error: "A team workflow uses this credential. Remove the delegation, then revoke.",
        }),
        variables: { service: "linear" },
      };
      renderCredentials([linearCred, notionCred]);

      fireEvent.click(screen.getByRole("button", { name: "Revoke linear" }));

      const dialog = await screen.findByRole("dialog");
      expect(
        within(dialog).getByText(
          "A team workflow uses this credential. Remove the delegation, then revoke.",
        ),
      ).toBeTruthy();

      // linear's failure is linear's: notion's dialog opens clean.
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      fireEvent.click(screen.getByRole("button", { name: "Revoke notion" }));
      const next = await screen.findByRole("dialog");
      expect(
        within(next).queryByText(
          "A team workflow uses this credential. Remove the delegation, then revoke.",
        ),
      ).toBeNull();
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
