// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthConsentInfo } from "@valet/api/wire";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options, useSearch: () => ({}) }),
}));

const oauthConsent = vi.fn<(code: string) => Promise<OAuthConsentInfo>>();
const decideOAuthConsent = vi.fn<(code: string, accept: boolean) => Promise<{ redirect: string }>>();
vi.mock("~/api/client", () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  },
  api: {
    oauthConsent: (code: string) => oauthConsent(code),
    decideOAuthConsent: (code: string, accept: boolean) => decideOAuthConsent(code, accept),
  },
}));

const { ConsentPage } = await import("./oauth.consent");

function renderPage(code: string | undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConsentPage code={code} />
    </QueryClientProvider>,
  );
}

const LOCAL: OAuthConsentInfo = {
  client_name: "Claude Code",
  redirect_origin: "http://localhost:33418",
  redirect_is_local: true,
  account: "me@valet.test",
  access: ["Use your connected integrations"],
};

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("OAuth consent page", () => {
  it("names the app, the account, and the access, with no warning for a local app", async () => {
    oauthConsent.mockResolvedValue(LOCAL);
    renderPage("code-1");
    expect(await screen.findByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("me@valet.test")).toBeTruthy();
    expect(screen.getByText("Use your connected integrations")).toBeTruthy();
    expect(screen.queryByText(/not to this computer/)).toBeNull();
  });

  it("warns when the code leaves this computer", async () => {
    oauthConsent.mockResolvedValue({ ...LOCAL, client_name: "Evil App", redirect_origin: "https://evil.example", redirect_is_local: false });
    renderPage("code-2");
    expect(await screen.findByText(/not to this computer/)).toBeTruthy();
    expect(screen.getAllByText(/https:\/\/evil\.example/).length).toBeGreaterThan(0);
  });

  it("sends the decision and follows the returned redirect", async () => {
    oauthConsent.mockResolvedValue(LOCAL);
    decideOAuthConsent.mockResolvedValue({ redirect: "http://localhost:33418/callback?code=x" });
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    renderPage("code-3");
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("http://localhost:33418/callback?code=x"));
    expect(decideOAuthConsent).toHaveBeenCalledWith("code-3", true);
  });

  it("explains an expired or missing request", async () => {
    renderPage(undefined);
    expect(screen.getByText(/expired or does not exist/)).toBeTruthy();
    oauthConsent.mockRejectedValue(new Error("404"));
    renderPage("gone");
    expect((await screen.findAllByText(/expired or does not exist/)).length).toBeGreaterThan(0);
  });
});
