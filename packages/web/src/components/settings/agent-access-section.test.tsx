// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAccessResponse } from "@valet/api/wire";

const agentAccess = vi.fn<() => Promise<AgentAccessResponse>>();
const disconnectMcpApp = vi.fn<(id: string) => Promise<{ ok: true }>>();
const disconnectCliDevice = vi.fn<(id: string) => Promise<{ ok: true }>>();
vi.mock("~/api/client", () => ({
  api: {
    agentAccess: () => agentAccess(),
    disconnectMcpApp: (id: string) => disconnectMcpApp(id),
    disconnectCliDevice: (id: string) => disconnectCliDevice(id),
  },
}));

const { AgentAccessSection } = await import("./agent-access-section");

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AgentAccessSection />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.clearAllMocks());

describe("Agent access", () => {
  it("lists MCP apps and CLIs, and disconnects one after a second click", async () => {
    agentAccess.mockResolvedValue({
      mcp_apps: [{ client_id: "c1", name: "Claude Code", connected_at: 1, expires_at: null }],
      cli_devices: [{ id: "t1", device: "laptop", signed_in_at: 1, last_used_at: null }],
    });
    disconnectCliDevice.mockResolvedValue({ ok: true });
    renderSection();
    expect(await screen.findByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("laptop")).toBeTruthy();
    const [, cliButton] = screen.getAllByRole("button", { name: "Disconnect" });
    fireEvent.click(cliButton!);
    expect(disconnectCliDevice).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm disconnect" }));
    await waitFor(() => expect(disconnectCliDevice).toHaveBeenCalledWith("t1"));
    expect(disconnectMcpApp).not.toHaveBeenCalled();
  });

  it("explains an empty list", async () => {
    agentAccess.mockResolvedValue({ mcp_apps: [], cli_devices: [] });
    renderSection();
    expect(await screen.findByText(/No apps are connected/)).toBeTruthy();
    expect(screen.getByText(/No CLI is signed in/)).toBeTruthy();
  });
});
