// @vitest-environment jsdom
/**
 * `SandboxTabs` (sandbox auth gateway plan, Task 7): Chat/Terminal/VS Code
 * tab bar + iframe pane for "full"-profile sessions. `headless` sessions
 * render nothing (no empty tab bar). Selecting a non-chat tab mints a
 * sandbox JWT (`useSandboxJwt`) and builds the gateway iframe src; the pane
 * is gated on the `sandbox.status` stream state (only "ready" renders the
 * iframe, everything else shows a "starting" placeholder).
 *
 * `global.fetch` is stubbed per-test — the component precedes the iframe
 * render with a same-origin status precheck against the gateway URL so it
 * can tell a 401 (silent re-mint + reload once) from a 502 (error panel +
 * retry) apart, neither of which is observable from the iframe's own
 * `onError` alone.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "~/components/primitives";
import { SandboxTabs, type SandboxTabsProps } from "./sandbox-tabs";

function renderTabs(props: SandboxTabsProps) {
  return render(
    <TooltipProvider>
      <SandboxTabs {...props} />
    </TooltipProvider>,
  );
}

const mintSandboxJwt = vi.fn();
vi.mock("~/api/queries", () => ({
  useSandboxJwt: () => ({ mutateAsync: mintSandboxJwt }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  mintSandboxJwt.mockReset();
});

describe("SandboxTabs", () => {
  it("renders nothing for a headless session", () => {
    const { container } = renderTabs({
      sessionId: "sess-1",
      profile: "headless",
      activeTab: "chat",
      onTabChange: () => {},
      sandbox: { state: "ready", epoch: 1 },
    });
    expect(container.textContent).toBe("");
  });

  it("full session: shows the tab bar", () => {
    renderTabs({
      sessionId: "sess-1",
      profile: "full",
      activeTab: "chat",
      onTabChange: () => {},
      sandbox: { state: "ready", epoch: 1 },
    });
    expect(screen.getByRole("tab", { name: "Chat" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Terminal" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "VS Code" })).toBeTruthy();
  });

  it("full session + ready sandbox on the terminal tab: mints a JWT and renders the iframe", async () => {
    mintSandboxJwt.mockResolvedValue({ token: "tok-123", expiresAt: Date.now() + 60_000 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));

    renderTabs({
      sessionId: "sess-1",
      profile: "full",
      activeTab: "terminal",
      onTabChange: () => {},
      sandbox: { state: "ready", epoch: 1 },
    });

    expect(mintSandboxJwt).toHaveBeenCalled();
    const iframe = await screen.findByTitle("Terminal");
    expect(iframe.getAttribute("src")).toContain("/gateway/ttyd/?token=tok-123");
  });

  it("full session + provisioning sandbox: shows a starting placeholder, no iframe", () => {
    renderTabs({
      sessionId: "sess-1",
      profile: "full",
      activeTab: "terminal",
      onTabChange: () => {},
      sandbox: { state: "provisioning", epoch: 1 },
    });
    expect(screen.getByText(/starting/i)).toBeTruthy();
    expect(screen.queryByTitle("Terminal")).toBeNull();
    expect(mintSandboxJwt).not.toHaveBeenCalled();
  });

  it("gateway 401: silently re-mints the JWT and reloads the iframe once", async () => {
    mintSandboxJwt
      .mockResolvedValueOnce({ token: "stale-tok", expiresAt: Date.now() + 60_000 })
      .mockResolvedValueOnce({ token: "fresh-tok", expiresAt: Date.now() + 60_000 });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    renderTabs({
      sessionId: "sess-1",
      profile: "full",
      activeTab: "vscode",
      onTabChange: () => {},
      sandbox: { state: "ready", epoch: 1 },
    });

    const iframe = await screen.findByTitle("VS Code");
    expect(iframe.getAttribute("src")).toContain("token=fresh-tok");
    expect(mintSandboxJwt).toHaveBeenCalledTimes(2);
  });

  it("gateway 502: shows an error panel with a retry button", async () => {
    mintSandboxJwt.mockResolvedValue({ token: "tok-123", expiresAt: Date.now() + 60_000 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 502 })));

    renderTabs({
      sessionId: "sess-1",
      profile: "full",
      activeTab: "terminal",
      onTabChange: () => {},
      sandbox: { state: "ready", epoch: 1 },
    });

    await waitFor(() => expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy());
    expect(screen.queryByTitle("Terminal")).toBeNull();
  });

  it("clicking a tab calls onTabChange", () => {
    const onTabChange = vi.fn();
    renderTabs({
      sessionId: "sess-1",
      profile: "full",
      activeTab: "chat",
      onTabChange,
      sandbox: { state: "ready", epoch: 1 },
    });
    screen.getByRole("tab", { name: "Terminal" }).click();
    expect(onTabChange).toHaveBeenCalledWith("terminal");
  });
});
