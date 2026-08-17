// @vitest-environment jsdom
/**
 * Org · Slack app settings. Mocks `~/api/settings` the same way
 * `github-app-section.test.tsx` does — these tests only care what the
 * section renders and which mutation it fires, not that TanStack Query
 * itself resolves anything.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { GetSlackAppResponse } from "@valet/api/wire";

const saveCredentialMutateAsync = vi.fn();
const deleteAppMutate = vi.fn();

let slackAppData: GetSlackAppResponse | undefined;
let isLoading = false;
let isError = false;
let saveCredentialError: Error | null = null;

// importOriginal: see -new-session-dialog.test.tsx (packages/web root) for
// why a bare replacement here is unsafe under vitest.config.ts's isolate:false.
vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useSlackApp: () => ({ data: slackAppData, isLoading, error: isError ? new Error("boom") : null }),
    useSaveSlackCredential: () => ({
      mutateAsync: saveCredentialMutateAsync,
      isPending: false,
      error: saveCredentialError,
    }),
    useDeleteSlackApp: () => ({ mutate: deleteAppMutate, isPending: false }),
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
      oauth_config: { scopes: { bot: ["assistant:write", "chat:write", "im:history"] } },
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
    vi.stubGlobal("confirm", vi.fn(() => true));
  });

  it("shows a loading spinner", () => {
    isLoading = true;
    render(<SlackAppSection />);
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("shows failure text on error", () => {
    isError = true;
    render(<SlackAppSection />);
    expect(screen.getByText("Failed to load the Slack app setup.")).toBeTruthy();
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
    expect(screen.getByText(/Socket Mode/)).toBeTruthy();
    unmount();

    slackAppData = slackAppResponse();
    render(<SlackAppSection />);
    expect(screen.queryByText(/Socket Mode/)).toBeNull();
  });

  it("surfaces the save error the server explains", () => {
    slackAppData = slackAppResponse();
    saveCredentialError = new Error(
      "That token is not a bot token. Copy the Bot User OAuth Token from Install App.",
    );
    render(<SlackAppSection />);
    expect(screen.getByText(/not a bot token/)).toBeTruthy();
  });

  it("connected: shows the workspace and disconnects after confirm", () => {
    slackAppData = slackAppResponse({
      connected: true,
      teamName: "Acme",
      teamId: "T12345",
    });
    render(<SlackAppSection />);

    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText("Workspace T12345")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(deleteAppMutate).toHaveBeenCalled();
  });

  it("connected: a declined confirm does not disconnect", () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    slackAppData = slackAppResponse({ connected: true, teamName: "Acme" });
    render(<SlackAppSection />);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(deleteAppMutate).not.toHaveBeenCalled();
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
