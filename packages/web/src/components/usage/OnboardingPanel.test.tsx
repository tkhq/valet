// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProxyRequestListItem } from "@valet/api/wire";
import { api } from "~/api/client";
import { OnboardingPanel } from "./OnboardingPanel";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("~/api/api-keys", () => ({
  useCreateApiKey: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

const requests = vi.spyOn(api, "proxyRequests");
const settingsQuery = { data: { enabled: true, mode: "centralized" as const }, isLoading: false };

function mount(team = false, mode: "centralized" | "passthrough" = "centralized") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>
    <OnboardingPanel settingsQuery={{ ...settingsQuery, data: { enabled: true, mode } }} team={team} />
  </QueryClientProvider>);
}

function requestRow(overrides: Partial<ProxyRequestListItem> = {}): ProxyRequestListItem {
  return { id: "request-1", createdAt: Date.now() + 1000, orgId: "org-1", userId: "user-1", apiKeyId: "key-1",
    providerKind: "anthropic", model: "claude-sonnet-4-6", harness: "claude-code", endpoint: "/v1/messages",
    stream: true, statusCode: 200, inputTokens: 3, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
    totalTokens: 8, costUsd: 0.01, latencyMs: 100, hasError: false, ...overrides };
}

beforeEach(() => {
  requests.mockReset();
  requests.mockResolvedValue({ requests: [], pageSize: 25, hasMore: false });
});

describe("coding tool setup", () => {
  it("leads with browser-approved Claude setup without making a manual key", () => {
    mount();
    expect(screen.getByRole("heading", { name: "Connect your coding tool" })).toBeTruthy();
    expect(screen.getByText(/valet proxy setup claude-code/).textContent).toContain(`valet login ${window.location.origin}`);
    expect(screen.getByText(/cli\/install.sh/).textContent).toContain(`${window.location.origin}/cli/install.sh`);
    expect(screen.queryByText(/valet proxy setup codex/)).toBeNull();
  });

  it("switches tools without mixing commands or reusing the default Codex profile", () => {
    mount();
    fireEvent.click(screen.getByRole("radio", { name: "Codex" }));
    expect(screen.getByText(/valet proxy setup codex/)).toBeTruthy();
    expect(screen.getByText('codex --profile valet exec "hello"')).toBeTruthy();
    expect(screen.queryByText(/valet proxy setup claude-code/)).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "OpenCode" }));
    expect(screen.getByText(/valet proxy setup opencode/)).toBeTruthy();
    expect(screen.getByText(/OpenCode 1.x and 2.x/)).toBeTruthy();
    expect(screen.getAllByText(/opencode auth logout/).length).toBeGreaterThan(0);
  });

  it("gives Cursor settings and exact generic endpoints without invented CLI commands", () => {
    mount();
    fireEvent.click(screen.getByRole("radio", { name: "Cursor" }));
    expect(screen.getByText(/Cursor Settings/)).toBeTruthy();
    expect(screen.getByText(`${window.location.origin}/proxy/openai/v1`)).toBeTruthy();
    expect(screen.queryByText(/valet proxy setup cursor/)).toBeNull();
    expect(screen.getByText(/Tab.*Auto.*Cloud/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Other tools" }));
    expect(screen.getByText(`${window.location.origin}/proxy/anthropic`)).toBeTruthy();
    expect(screen.getByText(`${window.location.origin}/proxy/openai/v1`)).toBeTruthy();
  });

  it.each(["team", "passthrough"])("keeps %s on the manual path", (kind) => {
    mount(kind === "team", kind === "passthrough" ? "passthrough" : "centralized");
    expect(screen.queryByText(/valet proxy setup claude-code/)).toBeNull();
    expect(screen.getByRole("button", { name: "Create proxy key" })).toBeTruthy();
  });
});

describe("observed proxy connection", () => {
  it("checks only on demand and explains an empty result", async () => {
    mount();
    expect(requests).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
    await waitFor(() => expect(screen.getByText(/No successful proxy request/)).toBeTruthy());
    expect(requests).toHaveBeenCalledWith(expect.objectContaining({ from: expect.any(Number), limit: 25 }), expect.any(AbortSignal));
  });

  it("shows loading then success from a recorded model call", async () => {
    let finish: ((value: Awaited<ReturnType<typeof api.proxyRequests>>) => void) | undefined;
    requests.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Checking…" })).toHaveProperty("disabled", true));
    await act(async () => { finish?.({ requests: [requestRow()], pageSize: 25, hasMore: false }); });
    await waitFor(() => expect(screen.getByText(/Successful proxy request recorded/)).toBeTruthy());
    expect(screen.getByText(/claude-sonnet-4-6/)).toBeTruthy();
  });

  it("does not mark failed or older requests as connected", async () => {
    requests.mockResolvedValue({ requests: [requestRow({ statusCode: 401 }), requestRow({ hasError: true }), requestRow({ createdAt: 1 })], pageSize: 25, hasMore: false });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
    await waitFor(() => expect(screen.getByText(/No successful proxy request/)).toBeTruthy());
    expect(screen.queryByText(/Successful proxy request recorded/)).toBeNull();
  });

  it("offers a retry after a real API error", async () => {
    requests.mockRejectedValue(new Error("Denied"));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Check connection"));
    requests.mockResolvedValue({ requests: [requestRow()], pageSize: 25, hasMore: false });
    fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
    await waitFor(() => expect(screen.getByText(/Successful proxy request recorded/)).toBeTruthy());
  });

  it("does not use personal request history to verify a team key", () => {
    mount(true);
    expect(screen.queryByRole("button", { name: "Check connection" })).toBeNull();
    expect(requests).not.toHaveBeenCalled();
    expect(screen.getByText(/Team connection checks/)).toBeTruthy();
  });
});
