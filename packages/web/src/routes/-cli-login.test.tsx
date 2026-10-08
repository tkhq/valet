// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliLoginInfo } from "@valet/api/wire";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options, useSearch: () => ({}) }),
}));

type Decide = { redirect_uri: string; code_challenge: string; state: string; device: string; accept: boolean };
const cliLogin = vi.fn<(p: { redirectUri: string; codeChallenge: string; device: string }) => Promise<CliLoginInfo>>();
const decideCliLogin = vi.fn<(body: Decide) => Promise<{ redirect: string }>>();
vi.mock("~/api/client", () => ({
  api: {
    cliLogin: (p: { redirectUri: string; codeChallenge: string; device: string }) => cliLogin(p),
    decideCliLogin: (body: Decide) => decideCliLogin(body),
  },
}));

const { CliLoginPage } = await import("./cli.login");

const SEARCH = { redirect_uri: "http://127.0.0.1:5000/callback", code_challenge: "c".repeat(43), state: "st", device: "laptop" };
const INFO: CliLoginInfo = { account: "me@valet.test", device: "laptop", access: ["Act as you in Valet"] };

function renderPage(search: Partial<typeof SEARCH>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CliLoginPage search={search} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("CLI sign-in page", () => {
  it("names the computer, the account, and the access", async () => {
    cliLogin.mockResolvedValue(INFO);
    renderPage(SEARCH);
    expect(await screen.findByText("laptop")).toBeTruthy();
    expect(screen.getByText("me@valet.test")).toBeTruthy();
    expect(screen.getByText("Act as you in Valet")).toBeTruthy();
    expect(cliLogin).toHaveBeenCalledWith({ redirectUri: SEARCH.redirect_uri, codeChallenge: SEARCH.code_challenge, device: "laptop" });
  });

  it("sends the decision and returns the browser to the CLI", async () => {
    cliLogin.mockResolvedValue(INFO);
    decideCliLogin.mockResolvedValue({ redirect: "http://127.0.0.1:5000/callback?code=x&state=st" });
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    renderPage(SEARCH);
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("http://127.0.0.1:5000/callback?code=x&state=st"));
    expect(decideCliLogin).toHaveBeenCalledWith({ ...SEARCH, accept: true });
    expect(screen.getByText(/close this tab/)).toBeTruthy();
  });

  it("explains a broken or refused link", async () => {
    renderPage({});
    expect(screen.getByText(/not valid/)).toBeTruthy();
    cliLogin.mockRejectedValue(new Error("400"));
    renderPage(SEARCH);
    expect((await screen.findAllByText(/not valid/)).length).toBeGreaterThan(0);
  });
});
