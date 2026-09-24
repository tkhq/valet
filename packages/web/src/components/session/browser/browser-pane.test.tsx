// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BrowserRuntimeStatus } from "@valet/shared";
import { BrowserPane } from "./browser-pane";

const state = vi.hoisted(() => ({
  status: null as BrowserRuntimeStatus | null,
  actorId: "viewer",
  enabled: true,
  settingsEnabled: true,
  control: vi.fn().mockResolvedValue({}),
  start: vi.fn().mockResolvedValue({}),
  tab: vi.fn().mockResolvedValue({}),
  input: vi.fn().mockResolvedValue({}),
  dialog: vi.fn().mockResolvedValue({}),
  frameEnabled: vi.fn(),
  settings: vi.fn().mockResolvedValue({}),
  capture: vi.fn().mockResolvedValue({}),
}));
vi.mock("~/api/browser", () => ({
  browserApi: {
    evidence: (session: string, artifact: string) =>
      `/api/sessions/${session}/browser/evidence/${artifact}`,
  },
  useBrowserStatus: () => ({
    data: {
      status: state.status,
      actorId: state.actorId,
      canAdminister: true,
      enabled: state.enabled,
      settings: {
        enabled: state.settingsEnabled,
        audience: "owner",
        grants: [],
        policyVersion: "1",
      },
    },
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useBrowserActions: () =>
    Object.fromEntries(
      ["control", "start", "tab", "input", "dialog", "settings", "capture"].map(
        (name) => [
          name,
          {
            mutateAsync:
              state[
                name as
                  | "control"
                  | "start"
                  | "tab"
                  | "input"
                  | "dialog"
                  | "settings"
                  | "capture"
              ],
            isPending: false,
          },
        ],
      ),
    ),
  useBrowserFrame: (
    _session: string,
    _runtime: string,
    _tab: string,
    enabled: boolean,
  ) => {
    state.frameEnabled(enabled);
    return { frame: null, error: null, visible: true, retry: vi.fn() };
  },
}));

function ready(): BrowserRuntimeStatus {
  return {
    state: "ready",
    runtimeId: "runtime",
    protocolVersion: "1.0",
    capabilities: {
      viewer: { available: true },
      webmcp: { available: false, reason: "Unavailable in this image." },
    },
    tabs: [
      {
        id: "tab",
        runtimeId: "runtime",
        documentId: "doc",
        title: "Example",
        url: "https://example.com/",
        actorId: "agent",
        ownerThreadId: "thread",
        mark: "temporary",
      },
    ],
    control: null,
  };
}
afterEach(() => {
  state.status = null;
  state.enabled = true;
  state.settingsEnabled = true;
  vi.clearAllMocks();
});

describe("browser pane control", () => {
  it("answers a dialog outside the page input queue and pauses frame capture", async () => {
    state.status = {
      ...ready(),
      control: {
        id: "lease",
        runtimeId: "runtime",
        actorId: "viewer",
        state: "active",
        privateMode: false,
        expiresAt: Date.now() + 60_000,
      },
      dialogs: [
        {
          tabId: "tab",
          dialogId: "dialog",
          kind: "alert",
          message: "Test alert",
        },
      ],
    };
    render(<BrowserPane sessionId="session" />);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(state.dialog).toHaveBeenCalledWith({
        leaseId: "lease",
        runtimeId: "runtime",
        tabId: "tab",
        documentId: "doc",
        input: { type: "dialog", dialogId: "dialog", accept: true, text: "" },
      }),
    );
    expect(state.input).not.toHaveBeenCalled();
    expect(state.frameEnabled).toHaveBeenLastCalledWith(false);
    expect(
      screen
        .getByRole("button", { name: "Save screenshot" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("does not start a runtime by mounting the browser pane", () => {
    render(<BrowserPane sessionId="session" />);
    expect(state.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start browser" }));
    expect(state.start).toHaveBeenCalledOnce();
  });

  it("requests a private lease and explains the agent pause", () => {
    state.status = ready();
    render(<BrowserPane sessionId="session" />);
    fireEvent.click(screen.getByRole("button", { name: "Private sign-in" }));
    expect(state.control).toHaveBeenCalledWith({
      action: "take",
      privateMode: true,
    });
  });

  it("captures durable screenshot evidence for the selected page", async () => {
    state.status = ready();
    state.capture.mockResolvedValueOnce({
      id: "image",
      sessionId: "session",
      runtimeId: "runtime",
      tabId: "tab",
      documentId: "doc",
      filename: "page.png",
      mimeType: "image/png",
      width: 1280,
      height: 720,
    });
    render(<BrowserPane sessionId="session" />);
    fireEvent.click(screen.getByRole("button", { name: "Save screenshot" }));
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "page.png" }).getAttribute("href"),
      ).toBe("/api/sessions/session/browser/evidence/image"),
    );
    expect(state.capture).toHaveBeenCalledWith({
      runtimeId: "runtime",
      tabId: "tab",
    });
    expect(
      screen.getByRole("button", { name: "Annotate screenshot" }),
    ).toBeTruthy();
  });

  it("disables screenshot capture during private sign-in", () => {
    state.status = {
      ...ready(),
      control: {
        id: "lease",
        runtimeId: "runtime",
        actorId: "viewer",
        state: "active",
        privateMode: true,
        expiresAt: Date.now() + 60_000,
      },
    };
    render(<BrowserPane sessionId="session" />);
    expect(
      screen
        .getByRole("button", { name: "Save screenshot" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("never enables another viewer's lease for navigation", () => {
    state.status = {
      ...ready(),
      control: {
        id: "lease",
        runtimeId: "runtime",
        actorId: "someone-else",
        state: "active",
        privateMode: false,
        expiresAt: Date.now() + 60_000,
      },
    };
    render(<BrowserPane sessionId="session" />);
    expect(
      screen.getByRole("button", { name: "Go" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.queryByRole("button", { name: "Release control" }),
    ).toBeNull();
  });

  it("keeps release and renewal available after the viewer's lease expires", () => {
    state.status = {
      ...ready(),
      control: {
        id: "lease",
        runtimeId: "runtime",
        actorId: "viewer",
        state: "active",
        privateMode: true,
        expiresAt: Date.now() - 1,
      },
    };
    render(<BrowserPane sessionId="session" />);
    expect(
      screen.getByRole("button", { name: "Go" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Renew control" }));
    expect(state.control).toHaveBeenCalledWith({
      action: "take",
      privateMode: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Release control" }));
    expect(state.control).toHaveBeenCalledWith({
      action: "release",
      leaseId: "lease",
    });
  });

  it("stops agent actions by acquiring control and then pausing the returned lease", async () => {
    state.status = ready();
    state.control.mockResolvedValueOnce({
      status: {
        ...ready(),
        control: {
          id: "new-lease",
          runtimeId: "runtime",
          actorId: "viewer",
          state: "active",
          privateMode: false,
          expiresAt: Date.now() + 60_000,
        },
      },
    });
    render(<BrowserPane sessionId="session" />);
    fireEvent.click(
      screen.getByRole("button", { name: "Stop browser actions" }),
    );
    await waitFor(() =>
      expect(state.control.mock.calls).toEqual([
        [{ action: "take" }],
        [{ action: "pause", leaseId: "new-lease" }],
      ]),
    );
  });

  it("syncs the address when the selected page changes", () => {
    state.status = ready();
    const view = render(<BrowserPane sessionId="session" />);
    expect(
      screen
        .getByRole("textbox", { name: "Browser address" })
        .getAttribute("value"),
    ).toBe("https://example.com/");
    state.status = {
      ...ready(),
      tabs: [
        { ...ready().tabs[0]!, id: "second", url: "https://next.example/" },
      ],
    };
    view.rerender(<BrowserPane sessionId="session" />);
    expect(
      screen
        .getByRole("textbox", { name: "Browser address" })
        .getAttribute("value"),
    ).toBe("https://next.example/");
  });

  it("selects a newly opened page after the viewer manually selected another page", async () => {
    const first = ready().tabs[0]!;
    const second = {
      ...first,
      id: "second",
      title: "Second",
      url: "https://second.example/",
    };
    const third = {
      ...first,
      id: "third",
      title: "New page",
      url: "about:blank",
    };
    const control = {
      id: "lease",
      runtimeId: "runtime",
      actorId: "viewer",
      state: "active" as const,
      privateMode: false,
      expiresAt: Date.now() + 60_000,
    };
    state.status = { ...ready(), control, tabs: [first, second] };
    const view = render(<BrowserPane sessionId="session" />);
    fireEvent.click(screen.getByRole("tab", { name: "Second" }));
    state.tab.mockResolvedValueOnce({
      status: {
        ...state.status,
        tabs: [first, second, third],
        selectedTabId: "third",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "New browser page" }));
    state.status = {
      ...state.status,
      tabs: [first, second, third],
      selectedTabId: "third",
    };
    view.rerender(<BrowserPane sessionId="session" />);
    await waitFor(() =>
      expect(
        screen
          .getByRole("tab", { name: "New page" })
          .getAttribute("aria-selected"),
      ).toBe("true"),
    );
  });
});
