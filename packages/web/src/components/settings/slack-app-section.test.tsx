// @vitest-environment jsdom
/**
 * Org · Slack app settings. Mocks `~/api/settings` the same way
 * `github-app-section.test.tsx` does — these tests only care what the
 * section renders and which mutation it fires, not that TanStack Query
 * itself resolves anything.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { GetSlackAppResponse } from "@valet/api/wire";

const saveCredentialMutateAsync = vi.fn();
const deleteAppMutate = vi.fn();
// Clears like the real `reset()`, or a dialog that opens on a stale error
// still looks clean here and the bug ships green.
const deleteAppReset = vi.fn(() => {
  deleteAppError = null;
});
let nativeConfirm = vi.fn(() => true);

let slackAppData: GetSlackAppResponse | undefined;
let isLoading = false;
let isError = false;
let saveCredentialError: Error | null = null;
let deleteAppError: Error | null = null;
let lastRequestedName: string | undefined;

// importOriginal: see -new-session-dialog.test.tsx (packages/web root) for
// why a bare replacement here is unsafe under vitest.config.ts's isolate:false.
vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useSlackApp: (name?: string) => {
      lastRequestedName = name;
      return { data: slackAppData, isLoading, error: isError ? new Error("boom") : null };
    },
    useSaveSlackCredential: () => ({
      mutateAsync: saveCredentialMutateAsync,
      isPending: false,
      error: saveCredentialError,
    }),
    useDeleteSlackApp: () => ({
      mutate: deleteAppMutate,
      isPending: false,
      error: deleteAppError,
      reset: deleteAppReset,
    }),
  };
});

import { SlackAppSection } from "./slack-app-section";

function slackAppResponse(overrides: Partial<GetSlackAppResponse> = {}): GetSlackAppResponse {
  return {
    ingress: "webhook",
    requestUrl: "https://valet.example.com/api/channels/slack/webhook",
    createUrl: "https://api.slack.com/apps?new_app=1",
    manifest: {
      display_information: { name: "Valet", description: "Your Valet assistant, in Slack." },
      features: {
        agent_view: { agent_description: "Valet runs work for you.", suggested_prompts: [] },
        app_home: {
          home_tab_enabled: false,
          messages_tab_enabled: true,
          messages_tab_read_only_enabled: false,
        },
        bot_user: { display_name: "Valet", always_online: true },
      },
      oauth_config: {
        redirect_urls: ["https://valet.example.com/api/credentials/oauth/callback"],
        scopes: {
          bot: ["assistant:write", "chat:write", "im:history"],
          user: ["search:read", "chat:write"],
        },
      },
      settings: {
        event_subscriptions: {
          request_url: "https://valet.example.com/api/channels/slack/webhook",
          bot_events: ["app_home_opened", "app_context_changed", "message.im"],
        },
        interactivity: {
          is_enabled: true,
          request_url: "https://valet.example.com/api/channels/slack/webhook",
        },
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
      },
    },
    requiredScopes: ["assistant:write", "chat:write", "im:history"],
    optionalScopes: ["users:read", "im:write", "files:read", "files:write"],
    connected: false,
    missingScopes: [],
    ...overrides,
  };
}

describe("SlackAppSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    slackAppData = undefined;
    isLoading = false;
    isError = false;
    saveCredentialError = null;
    deleteAppError = null;
    lastRequestedName = undefined;
    // Browser automation auto-accepts `window.confirm`, so a native confirm is
    // no confirmation at all. Answering "yes" makes a reintroduced call visible.
    nativeConfirm = vi.fn(() => true);
    vi.stubGlobal("confirm", nativeConfirm);
  });

  it("shows a loading spinner", () => {
    isLoading = true;
    render(<SlackAppSection />);
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("shows failure text on error", () => {
    isError = true;
    render(<SlackAppSection />);
    expect(screen.getByText(/Failed to load the Slack app setup/)).toBeTruthy();
  });

  it("not connected: shows the manifest and the Slack create link", () => {
    slackAppData = slackAppResponse();
    render(<SlackAppSection />);

    const manifest = screen.getByLabelText("App manifest") as HTMLTextAreaElement;
    expect(manifest.value).toBe(JSON.stringify(slackAppData.manifest, null, 2));

    const link = screen.getByRole("link", { name: "Open Slack app creation" });
    expect(link.getAttribute("href")).toBe("https://api.slack.com/apps?new_app=1");
  });

  it("not connected: Connect stays disabled until both credentials are entered, then saves them", async () => {
    slackAppData = slackAppResponse();
    saveCredentialMutateAsync.mockResolvedValue({ ok: true });
    render(<SlackAppSection />);

    const connectBtn = screen.getByRole("button", { name: "Connect Slack" }) as HTMLButtonElement;
    expect(connectBtn.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Bot token"), { target: { value: "xoxb-token" } });
    expect(connectBtn.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Signing secret"), { target: { value: "sig-secret" } });
    expect(connectBtn.disabled).toBe(false);

    fireEvent.click(connectBtn);
    await waitFor(() =>
      expect(saveCredentialMutateAsync).toHaveBeenCalledWith({
        accessToken: "xoxb-token",
        webhookSecret: "sig-secret",
      }),
    );
  });

  it("shows the Socket Mode notice only when the deployment has no public URL", () => {
    slackAppData = slackAppResponse({ ingress: "socket_mode", requestUrl: null });
    const { unmount } = render(<SlackAppSection />);
    expect(screen.getByText(/no public URL/)).toBeTruthy();
    unmount();

    slackAppData = slackAppResponse();
    render(<SlackAppSection />);
    expect(screen.queryByText(/Socket Mode/)).toBeNull();
    expect(screen.queryByLabelText("App-level token")).toBeNull();
  });

  it("socket mode: requires the app-level token and sends it with the save", async () => {
    slackAppData = slackAppResponse({ ingress: "socket_mode", requestUrl: null });
    saveCredentialMutateAsync.mockResolvedValue({ ok: true });
    render(<SlackAppSection />);

    const connectBtn = screen.getByRole("button", { name: "Connect Slack" }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText("Bot token"), { target: { value: "xoxb-token" } });
    fireEvent.change(screen.getByLabelText("Signing secret"), { target: { value: "sig-secret" } });
    // Both webhook-mode credentials entered, but Socket Mode still needs the
    // app-level token — without it no event would ever arrive.
    expect(connectBtn.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("App-level token"), { target: { value: "xapp-1-a" } });
    expect(connectBtn.disabled).toBe(false);

    fireEvent.click(connectBtn);
    await waitFor(() =>
      expect(saveCredentialMutateAsync).toHaveBeenCalledWith({
        accessToken: "xoxb-token",
        webhookSecret: "sig-secret",
        appToken: "xapp-1-a",
      }),
    );
  });

  it("commits the app name on blur, refetching the manifest under that name", () => {
    slackAppData = slackAppResponse();
    render(<SlackAppSection />);
    expect(lastRequestedName).toBeUndefined();

    const nameInput = screen.getByLabelText("App name");
    fireEvent.change(nameInput, { target: { value: "  Valet Dev  " } });
    fireEvent.blur(nameInput);
    expect(lastRequestedName).toBe("Valet Dev");

    fireEvent.change(nameInput, { target: { value: "   " } });
    fireEvent.blur(nameInput);
    expect(lastRequestedName).toBeUndefined();
  });

  it("copies the manifest through the Clipboard API when it exists", async () => {
    slackAppData = slackAppResponse();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<SlackAppSection />);

    fireEvent.click(screen.getByRole("button", { name: "Copy manifest" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(JSON.stringify(slackAppData?.manifest, null, 2)),
    );
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("falls back to selecting the manifest when the Clipboard API is unavailable", async () => {
    slackAppData = slackAppResponse();
    // A plain-http origin exposes no `navigator.clipboard` at all.
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    render(<SlackAppSection />);

    fireEvent.click(screen.getByRole("button", { name: "Copy manifest" }));
    expect(await screen.findByText(/the manifest is selected/)).toBeTruthy();
  });

  it("surfaces the save error the server explains", () => {
    slackAppData = slackAppResponse();
    saveCredentialError = new Error(
      "That token is not a bot token. Copy the Bot User OAuth Token from Install App.",
    );
    render(<SlackAppSection />);
    expect(screen.getByText(/not a bot token/)).toBeTruthy();
  });

  it("connected: shows the workspace", () => {
    slackAppData = slackAppResponse({
      connected: true,
      teamName: "Acme",
      teamId: "T12345",
    });
    render(<SlackAppSection />);

    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText("Workspace T12345")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
  });

  it("connected: Disconnect asks first and deletes nothing on its own", () => {
    slackAppData = slackAppResponse({ connected: true, teamName: "Acme" });
    render(<SlackAppSection />);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    expect(screen.getByText("Disconnect Slack?")).toBeTruthy();
    expect(screen.getByText(/The agent stops answering in this workspace/)).toBeTruthy();
    expect(deleteAppMutate).not.toHaveBeenCalled();
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it("connected: confirming the dialog disconnects", () => {
    slackAppData = slackAppResponse({ connected: true, teamName: "Acme" });
    render(<SlackAppSection />);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    // Two "Disconnect" buttons are on screen now: the card's and the dialog's.
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    expect(deleteAppMutate).toHaveBeenCalledTimes(1);
    // The pre-dialog code called `mutate()` with no variables. Same shape.
    expect(deleteAppMutate.mock.calls[0]?.[0]).toBeUndefined();
  });

  it("connected: cancelling the dialog disconnects nothing", () => {
    slackAppData = slackAppResponse({ connected: true, teamName: "Acme" });
    render(<SlackAppSection />);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(deleteAppMutate).not.toHaveBeenCalled();
    expect(screen.queryByText("Disconnect Slack?")).toBeNull();
  });

  it("connected: the dialog shows the error the disconnect failed with", () => {
    slackAppData = slackAppResponse({ connected: true, teamName: "Acme" });
    const { rerender } = render(<SlackAppSection />);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(deleteAppMutate).toHaveBeenCalledTimes(1);

    // Production order: the mutation the operator just confirmed rejects while
    // the dialog is open. Setting the error before the open would exercise the
    // stale-error path instead.
    deleteAppError = new Error("Slack rejected the request");
    rerender(<SlackAppSection />);

    expect(within(screen.getByRole("dialog")).getByText(/Slack rejected the request/)).toBeTruthy();
  });

  it("connected: reopening after a refusal starts with no error", () => {
    slackAppData = slackAppResponse({ connected: true, teamName: "Acme" });
    // React Query holds `error` until the next mutate, so the previous
    // attempt's refusal is still on it. The Disconnect button clears it as it
    // opens the dialog.
    deleteAppError = new Error("Slack rejected the request");
    render(<SlackAppSection />);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByText(/Slack rejected the request/)).toBeNull();
  });

  it("connected: lists the scopes the installed app did not grant", () => {
    slackAppData = slackAppResponse({
      connected: true,
      teamName: "Acme",
      missingScopes: ["im:write", "files:read"],
    });
    render(<SlackAppSection />);

    expect(screen.getByText("Missing scopes")).toBeTruthy();
    expect(screen.getByText("im:write")).toBeTruthy();
    expect(screen.getByText("files:read")).toBeTruthy();
  });
});
