// @vitest-environment jsdom
/**
 * Org · GitHub App settings (GitHub/repo integration plan, Task 11). Mocks
 * `~/api/settings` the same way `-settings.organization.models.test.tsx`
 * mocks it — these tests only care what the section renders and which
 * mutation it fires, not that TanStack Query itself resolves anything.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { GetGithubAppResponse, PostGithubAppManifestResponse } from "@valet/api/wire";

const createManifestMutateAsync = vi.fn();
const saveCredentialMutateAsync = vi.fn();
const refreshMutate = vi.fn();
const deleteAppMutate = vi.fn();

let githubAppData: GetGithubAppResponse | undefined;
let isLoading = false;
let isError = false;
let saveCredentialError: Error | null = null;

// importOriginal: see -new-session-dialog.test.tsx (packages/web root) for
// why a bare replacement here is unsafe under vitest.config.ts's isolate:false.
vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useGithubApp: () => ({ data: githubAppData, isLoading, error: isError ? new Error("boom") : null }),
    useCreateGithubAppManifest: () => ({
      mutateAsync: createManifestMutateAsync,
      isPending: false,
      error: null,
    }),
    useSaveGithubAppCredential: () => ({
      mutateAsync: saveCredentialMutateAsync,
      isPending: false,
      error: saveCredentialError,
    }),
    useRefreshGithubApp: () => ({ mutate: refreshMutate, isPending: false }),
    useDeleteGithubApp: () => ({ mutate: deleteAppMutate, isPending: false }),
  };
});

import { ApiError } from "~/api/client";
import { GithubAppSection } from "./github-app-section";

describe("GithubAppSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    githubAppData = undefined;
    isLoading = false;
    isError = false;
    saveCredentialError = null;
    vi.stubGlobal("confirm", vi.fn(() => true));
  });

  it("shows a loading spinner", () => {
    isLoading = true;
    render(<GithubAppSection />);
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("shows failure text on error", () => {
    isError = true;
    render(<GithubAppSection />);
    expect(screen.getByText("Failed to load the GitHub App.")).toBeTruthy();
  });

  it("not configured: shows Create GitHub App, then renders the manifest form on click", async () => {
    githubAppData = { configured: false, installations: [], webhook: { mode: "manual" } };
    const manifestResponse: PostGithubAppManifestResponse = {
      url: "https://github.com/settings/apps/new",
      manifest: {
        name: "valet-acme",
        url: "https://api.example.com",
        redirect_url: "https://api.example.com/api/org/github-app/setup",
        hook_attributes: { url: "https://api.example.com/webhooks/github-app" },
        public: false,
        default_events: [],
          callback_urls: ["https://api.example.com/api/me/github/callback"],
        default_permissions: { contents: "write" },
      },
      state: "signed-state-value",
    };
    createManifestMutateAsync.mockResolvedValue(manifestResponse);
    render(<GithubAppSection />);

    expect(screen.queryByText(/installations/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create GitHub App" }));

    await waitFor(() => expect(createManifestMutateAsync).toHaveBeenCalled());

    const form = await screen.findByTestId("github-manifest-form");
    expect(form.getAttribute("action")).toBe(
      "https://github.com/settings/apps/new?state=signed-state-value",
    );
    expect(form.getAttribute("method")).toBe("post");
    const hiddenInput = form.querySelector('input[name="manifest"]') as HTMLInputElement;
    expect(hiddenInput.value).toBe(JSON.stringify(manifestResponse.manifest));
  });

  it("org toggle gates the button until a name is entered and sends target org:{login}", async () => {
    githubAppData = { configured: false, installations: [], webhook: { mode: "manual" } };
    createManifestMutateAsync.mockResolvedValue({
      url: "https://github.com/organizations/acme/settings/apps/new",
      manifest: {
        name: "valet-acme",
        url: "https://api.example.com",
        redirect_url: "https://api.example.com/api/org/github-app/setup",
        hook_attributes: { url: "https://api.example.com/webhooks/github-app" },
        public: false,
        default_events: [],
          callback_urls: ["https://api.example.com/api/me/github/callback"],
        default_permissions: { contents: "write" },
      },
      state: "s",
    });
    render(<GithubAppSection />);

    fireEvent.click(screen.getByRole("switch", { name: "Create under a GitHub organization" }));
    const createBtn = screen.getByRole("button", { name: "Create GitHub App" }) as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true); // org on + no name

    fireEvent.change(screen.getByLabelText("GitHub organization"), { target: { value: "acme" } });
    expect(createBtn.disabled).toBe(false);
    fireEvent.click(createBtn);
    await waitFor(() =>
      expect(createManifestMutateAsync).toHaveBeenCalledWith({ webhook: false, target: "org:acme" }),
    );
  });

  it("advanced picker sends the FULL permission map (deselections stick) and chosen events", async () => {
    githubAppData = { configured: false, installations: [], webhook: { mode: "manual" } };
    createManifestMutateAsync.mockResolvedValue({
      url: "https://github.com/settings/apps/new",
      manifest: {
        name: "valet-acme",
        url: "https://api.example.com",
        redirect_url: "https://api.example.com/api/org/github-app/setup",
        hook_attributes: { url: "https://api.example.com/webhooks/github-app" },
        public: false,
        default_events: [],
          callback_urls: ["https://api.example.com/api/me/github/callback"],
        default_permissions: { contents: "read" },
      },
      state: "s",
    });
    render(<GithubAppSection />);

    fireEvent.click(screen.getByRole("button", { name: "Configure permissions" }));
    // Manual webhook mode: the webhook switch is disabled-off and the
    // events checkboxes are hidden (nothing would deliver anyway).
    const webhookSwitch = screen.getByRole("switch", { name: "Deliver webhook events" }) as HTMLButtonElement;
    expect(webhookSwitch.disabled).toBe(true);
    expect(screen.queryByLabelText("pull_request")).toBeNull();

    // Drop `actions` entirely, downgrade contents to read.
    fireEvent.change(screen.getByLabelText("Actions permission"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Repository contents permission"), { target: { value: "read" } });

    fireEvent.click(screen.getByRole("button", { name: "Create GitHub App" }));
    await waitFor(() => expect(createManifestMutateAsync).toHaveBeenCalled());
    const body = createManifestMutateAsync.mock.calls[0][0] as {
      webhook: boolean;
      permissions: Record<string, string>;
    };
    expect(body.webhook).toBe(false);
    expect(body.permissions.actions).toBeUndefined();
    expect(body.permissions.contents).toBe("read");
  });

  // ── The second setup path: connect an App that already exists ──────────

  const NOT_CONFIGURED: GetGithubAppResponse = {
    configured: false,
    installations: [],
    webhook: { mode: "manual" },
  };

  /** Opens the second path and fills the two fields the server requires. */
  function openExistingAppForm(): void {
    fireEvent.click(screen.getByRole("button", { name: "I already have a GitHub App" }));
    fireEvent.change(screen.getByLabelText("App ID"), { target: { value: " 4242 " } });
    fireEvent.change(screen.getByLabelText("Private key"), {
      target: { value: "-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----" },
    });
  }

  it("not configured: offers the second path alongside the manifest flow, not instead of it", () => {
    githubAppData = NOT_CONFIGURED;
    render(<GithubAppSection />);

    // Creating an App stays the default and keeps working.
    expect(screen.getByRole("button", { name: "Create GitHub App" })).toBeTruthy();
    // The second path starts collapsed, so it does not compete with it.
    expect(screen.getByRole("button", { name: "I already have a GitHub App" })).toBeTruthy();
    expect(screen.queryByLabelText("App ID")).toBeNull();
  });

  it("existing App: Connect is gated until both required fields are filled", () => {
    githubAppData = NOT_CONFIGURED;
    render(<GithubAppSection />);

    fireEvent.click(screen.getByRole("button", { name: "I already have a GitHub App" }));
    const connect = screen.getByRole("button", { name: "Connect App" }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("App ID"), { target: { value: "4242" } });
    expect(connect.disabled).toBe(true); // no key yet

    fireEvent.change(screen.getByLabelText("Private key"), {
      target: { value: "-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----" },
    });
    expect(connect.disabled).toBe(false);
  });

  it("existing App: sends the trimmed app id and the key, and omits every field left blank", async () => {
    githubAppData = NOT_CONFIGURED;
    saveCredentialMutateAsync.mockResolvedValue(NOT_CONFIGURED);
    render(<GithubAppSection />);

    openExistingAppForm();
    fireEvent.click(screen.getByRole("button", { name: "Connect App" }));

    await waitFor(() => expect(saveCredentialMutateAsync).toHaveBeenCalled());
    expect(saveCredentialMutateAsync).toHaveBeenCalledWith({
      appId: "4242",
      privateKey: "-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----",
    });
  });

  it("existing App: sends the optional secrets and overrides only when they are filled", async () => {
    githubAppData = NOT_CONFIGURED;
    saveCredentialMutateAsync.mockResolvedValue(NOT_CONFIGURED);
    render(<GithubAppSection />);

    openExistingAppForm();
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "the-client-secret" } });
    fireEvent.change(screen.getByLabelText("Webhook secret"), { target: { value: "the-webhook-secret" } });
    fireEvent.change(screen.getByLabelText("App slug"), { target: { value: "my-app" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect App" }));

    await waitFor(() => expect(saveCredentialMutateAsync).toHaveBeenCalled());
    const body = saveCredentialMutateAsync.mock.calls[0][0] as Record<string, string>;
    expect(body.oauthClientSecret).toBe("the-client-secret");
    expect(body.webhookSecret).toBe("the-webhook-secret");
    expect(body.appSlug).toBe("my-app");
    // Left blank, so it is not sent — the server reads it from GitHub.
    expect(body.oauthClientId).toBeUndefined();
  });

  it("existing App: shows the server's refusal message, which names the fix", async () => {
    githubAppData = NOT_CONFIGURED;
    const refusal = new ApiError(400, "POST /org/github-app/credential → 400", {
      error: "GitHub rejected this App ID and private key. Check the App ID at the top of the app's settings page.",
    });
    saveCredentialMutateAsync.mockRejectedValue(refusal);
    saveCredentialError = refusal;
    render(<GithubAppSection />);

    openExistingAppForm();
    fireEvent.click(screen.getByRole("button", { name: "Connect App" }));

    // The server's own text is rendered, not the "POST … → 400" transport line.
    expect(await screen.findByText(/GitHub rejected this App ID and private key/)).toBeTruthy();
    expect(screen.queryByText(/→ 400/)).toBeNull();
  });

  it("existing App: says the server takes over the webhook URL before anything is pasted", () => {
    githubAppData = NOT_CONFIGURED;
    render(<GithubAppSection />);
    fireEvent.click(screen.getByRole("button", { name: "I already have a GitHub App" }));
    expect(screen.getByText(/takes over the App's webhook URL/)).toBeTruthy();
  });

  it("configured: the second path is gone — there is nothing left to connect", () => {
    githubAppData = {
      configured: true,
      app: {
        appId: "123",
        appSlug: "valet-acme",
        htmlUrl: "https://github.com/apps/valet-acme",
        installUrl: "https://github.com/apps/valet-acme/installations/new",
      },
      installations: [],
      webhook: { mode: "manual" },
    };
    render(<GithubAppSection />);
    expect(screen.queryByRole("button", { name: "I already have a GitHub App" })).toBeNull();
  });

  it("configured: renders the app card, installations table, and webhook badge", () => {
    githubAppData = {
      configured: true,
      app: {
        appId: "123",
        appSlug: "valet-acme",
        htmlUrl: "https://github.com/apps/valet-acme",
        installUrl: "https://github.com/apps/valet-acme/installations/new",
      },
      installations: [
        {
          id: "inst_1",
          installationId: 555,
          accountLogin: "acme-corp",
          accountType: "Organization",
          repositorySelection: "all",
          suspended: false,
          linkedUserId: "user_1",
        },
        {
          id: "inst_2",
          installationId: 556,
          accountLogin: "some-user",
          accountType: "User",
          repositorySelection: "selected",
          suspended: true,
          linkedUserId: null,
        },
      ],
      webhook: { mode: "public" },
    };
    render(<GithubAppSection />);

    expect(screen.getByText("valet-acme")).toBeTruthy();
    expect(screen.getByText(/123/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /view on github/i })).toHaveProperty(
      "href",
      "https://github.com/apps/valet-acme",
    );
    // Installed: the loud banner is gone; the quiet add-another link remains.
    expect(screen.queryByText("One step left — install the App")).toBeNull();
    expect(screen.getByRole("link", { name: "Install on another account" })).toHaveProperty(
      "href",
      "https://github.com/apps/valet-acme/installations/new",
    );
    expect(screen.getByText("public")).toBeTruthy();

    expect(screen.getByText("acme-corp")).toBeTruthy();
    expect(screen.getByText("some-user")).toBeTruthy();
    expect(screen.getByText("Suspended")).toBeTruthy();
    expect(screen.getAllByText("Linked").length).toBeGreaterThan(0);
  });

  it("configured but uninstalled: shows the loud install banner with the install link", () => {
    githubAppData = {
      configured: true,
      app: {
        appId: "123",
        appSlug: "valet-acme",
        htmlUrl: "https://github.com/apps/valet-acme",
        installUrl: "https://github.com/apps/valet-acme/installations/new",
      },
      installations: [],
      webhook: { mode: "manual" },
    };
    render(<GithubAppSection />);

    expect(screen.getByText("One step left — install the App")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Install on GitHub" })).toHaveProperty(
      "href",
      "https://github.com/apps/valet-acme/installations/new",
    );
    // The quiet add-another variant only appears once installed.
    expect(screen.queryByRole("link", { name: "Install on another account" })).toBeNull();
  });

  it("Refresh installations fires the refresh mutation", () => {
    githubAppData = {
      configured: true,
      app: {
        appId: "123",
        appSlug: "valet-acme",
        htmlUrl: "https://github.com/apps/valet-acme",
        installUrl: "https://github.com/apps/valet-acme/installations/new",
      },
      installations: [],
      webhook: { mode: "manual" },
    };
    render(<GithubAppSection />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh installations" }));
    expect(refreshMutate).toHaveBeenCalled();
  });

  it("Remove App confirms then fires the delete mutation", () => {
    githubAppData = {
      configured: true,
      app: {
        appId: "123",
        appSlug: "valet-acme",
        htmlUrl: "https://github.com/apps/valet-acme",
        installUrl: "https://github.com/apps/valet-acme/installations/new",
      },
      installations: [],
      webhook: { mode: "manual" },
    };
    render(<GithubAppSection />);
    fireEvent.click(screen.getByRole("button", { name: "Remove App" }));
    expect(confirm).toHaveBeenCalled();
    expect(deleteAppMutate).toHaveBeenCalled();
  });
});
