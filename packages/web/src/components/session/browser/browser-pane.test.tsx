// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BrowserAgentCursor, BrowserRuntimeStatus } from "@valet/shared";
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
  frameDocument: null as string | null,
  agentCursor: undefined as BrowserAgentCursor | undefined,
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
    return {
      frame: state.frameDocument
        ? {
            url: "blob:frame",
            runtimeId: "runtime",
            tabId: "tab",
            documentId: state.frameDocument,
            viewport: { width: 1280, height: 720 },
            agentCursor: state.agentCursor,
          }
        : null,
      error: null,
      visible: true,
      retry: vi.fn(),
    };
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
  state.frameDocument = null;
  state.agentCursor = undefined;
  state.enabled = true;
  state.settingsEnabled = true;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("browser pane control", () => {
  it("preserves consumed activity across control changes and hides it during private sign-in", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 640, 480));
    state.status = ready();
    state.frameDocument = "doc";
    state.agentCursor = { x: 30, y: 20, kind: "click", sequence: 1, ageMs: 0 };
    const view = render(<BrowserPane sessionId="session" />);
    fireEvent.load(screen.getByAltText("Browser page"));
    const pulse = view.container.querySelector("[data-agent-pulse]");
    expect(pulse).not.toBeNull();
    state.status = { ...ready(), control: {
      id: "lease", runtimeId: "runtime", actorId: "viewer", state: "active", privateMode: false, expiresAt: Date.now() + 60_000,
    } };
    view.rerender(<BrowserPane sessionId="session" />);
    expect(view.container.querySelector("[data-agent-pulse]")).toBe(pulse);
    state.status.control!.privateMode = true;
    view.rerender(<BrowserPane sessionId="session" />);
    expect(view.container.querySelector<HTMLElement>("[data-agent-pointer]")?.style.opacity).toBe("0");
    state.status = ready();
    view.rerender(<BrowserPane sessionId="session" />);
    expect(view.container.querySelector("[data-agent-pulse]")).toBe(pulse);
    expect(view.container.querySelector<HTMLElement>("[data-agent-pointer]")?.style.opacity).toBe("0");
    state.agentCursor = { ...state.agentCursor, sequence: 2 };
    view.rerender(<BrowserPane sessionId="session" />);
    fireEvent.load(screen.getByAltText("Browser page"));
    expect(view.container.querySelector<HTMLElement>("[data-agent-pointer]")?.style.opacity).toBe("1");
  });
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

  it("does not resubmit the selected browser audience", () => {
    state.status = ready();
    render(<BrowserPane sessionId="session" />);
    const owner = screen.getByRole("button", { name: "Owner" });
    expect(owner.hasAttribute("disabled")).toBe(true);
    fireEvent.click(owner);
    expect(state.settings).not.toHaveBeenCalled();
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
    expect(screen.queryByRole("button", { name: "Resume agent" })).toBeNull();
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
    fireEvent.click(
      screen.getByRole("button", { name: "End private sign-in" }),
    );
    expect(state.control).toHaveBeenCalledWith({
      action: "release",
      leaseId: "lease",
    });
  });

  it("pauses only when requested and resumes shared use", async () => {
    state.status = ready();
    const view = render(<BrowserPane sessionId="session" />);
    expect(state.control).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pause agent" }));
    await waitFor(() =>
      expect(state.control.mock.calls).toEqual([[{ action: "take" }]]),
    );
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
    };
    view.rerender(<BrowserPane sessionId="session" />);
    expect(
      screen.getByRole("button", { name: "Go" }).hasAttribute("disabled"),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Resume agent" }));
    expect(state.control).toHaveBeenLastCalledWith({
      action: "release",
      leaseId: "lease",
    });
  });

  it("navigates, opens, selects, and closes pages without acquiring control", async () => {
    state.status = ready();
    render(<BrowserPane sessionId="session" />);
    fireEvent.change(screen.getByRole("textbox", { name: "Browser address" }), {
      target: { value: "https://next.example/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() =>
      expect(state.input).toHaveBeenCalledWith({
        runtimeId: "runtime",
        tabId: "tab",
        documentId: "doc",
        input: { type: "navigate", url: "https://next.example/" },
      }),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Example" }));
    expect(state.tab).toHaveBeenCalledWith({
      action: "select",
      runtimeId: "runtime",
      tabId: "tab",
    });
    fireEvent.click(screen.getByRole("button", { name: "New browser page" }));
    expect(state.tab).toHaveBeenCalledWith({
      action: "new",
      runtimeId: "runtime",
      url: "about:blank",
    });
    fireEvent.click(screen.getByRole("button", { name: "Close Example" }));
    expect(state.tab).toHaveBeenCalledWith({
      action: "close",
      runtimeId: "runtime",
      tabId: "tab",
    });
    expect(state.control).not.toHaveBeenCalled();
  });

  it("answers dialogs without acquiring control", async () => {
    state.status = {
      ...ready(),
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
        runtimeId: "runtime",
        tabId: "tab",
        documentId: "doc",
        input: { type: "dialog", dialogId: "dialog", accept: true, text: "" },
      }),
    );
    expect(state.control).not.toHaveBeenCalled();
  });

  it("recovers input on a fresh document without replaying failed input", async () => {
    state.status = ready();
    state.frameDocument = "doc";
    state.input.mockRejectedValueOnce(
      new Error("The page changed. Observe the current page before retrying."),
    );
    const view = render(<BrowserPane sessionId="session" />);
    fireEvent.load(screen.getByRole("img", { name: "Browser page" }));
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Browser page input" }),
      { key: "x" },
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "The page changed",
      ),
    );
    state.frameDocument = "new-doc";
    state.status = {
      ...ready(),
      tabs: [{ ...ready().tabs[0]!, documentId: "new-doc" }],
    };
    view.rerender(<BrowserPane sessionId="session" />);
    fireEvent.load(screen.getByRole("img", { name: "Browser page" }));
    expect(
      screen
        .getByRole("textbox", { name: "Browser page input" })
        .hasAttribute("readonly"),
    ).toBe(false);
    expect(state.input).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Browser page input" }),
      { key: "y" },
    );
    await waitFor(() =>
      expect(state.input).toHaveBeenLastCalledWith({
        runtimeId: "runtime",
        tabId: "tab",
        documentId: "new-doc",
        input: { type: "key", key: "y", phase: "down" },
      }),
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
