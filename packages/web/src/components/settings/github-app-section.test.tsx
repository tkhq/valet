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
const refreshMutate = vi.fn();
const deleteAppMutate = vi.fn();

let githubAppData: GetGithubAppResponse | undefined;
let isLoading = false;
let isError = false;

vi.mock("~/api/settings", () => ({
  useGithubApp: () => ({ data: githubAppData, isLoading, error: isError ? new Error("boom") : null }),
  useCreateGithubAppManifest: () => ({
    mutateAsync: createManifestMutateAsync,
    isPending: false,
    error: null,
  }),
  useRefreshGithubApp: () => ({ mutate: refreshMutate, isPending: false }),
  useDeleteGithubApp: () => ({ mutate: deleteAppMutate, isPending: false }),
}));

import { GithubAppSection } from "./github-app-section";

describe("GithubAppSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    githubAppData = undefined;
    isLoading = false;
    isError = false;
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
    expect(screen.getByRole("link", { name: "Install on GitHub" })).toHaveProperty(
      "href",
      "https://github.com/apps/valet-acme/installations/new",
    );
    expect(screen.getByText("public")).toBeTruthy();

    expect(screen.getByText("acme-corp")).toBeTruthy();
    expect(screen.getByText("some-user")).toBeTruthy();
    expect(screen.getByText("Suspended")).toBeTruthy();
    expect(screen.getAllByText("Linked").length).toBeGreaterThan(0);
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
