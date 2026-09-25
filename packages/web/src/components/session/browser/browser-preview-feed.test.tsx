// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { SessionBrowserResponse } from "@valet/api/wire";
import { BrowserPreviewFeed } from "./browser-preview-feed";

function ready(): SessionBrowserResponse {
  return {
    enabled: true,
    actorId: "viewer",
    canAdminister: true,
    settings: {
      enabled: true,
      audience: "owner",
      grants: [],
      policyVersion: "1",
    },
    status: {
      state: "ready",
      runtimeId: "runtime",
      protocolVersion: "1.0",
      control: null,
      capabilities: { viewer: { available: true } },
      selectedTabId: "other",
      tabs: ["other", "thread"].map((id) => ({
        id,
        runtimeId: "runtime",
        documentId: id,
        title: id,
        url: `https://${id}.example/`,
        actorId: "agent",
        ownerThreadId: id,
        mark: "temporary",
      })),
    },
  };
}
const state = vi.hoisted(() => ({
  data: undefined as SessionBrowserResponse | undefined,
  error: null as Error | null,
  frameError: null as string | null,
  frame: vi.fn(),
  status: vi.fn(),
  retry: vi.fn(),
  control: vi.fn().mockResolvedValue({}),
  refetch: vi.fn(),
  visible: true,
}));
vi.mock("~/api/browser", () => ({
  useBrowserActions: () => ({
    control: { mutateAsync: state.control, isPending: false },
  }),
  useBrowserStatus: (...args: unknown[]) => {
    state.status(...args);
    return {
      data: state.data,
      isPending: !state.data,
      isError: !!state.error,
      error: state.error,
      refetch: state.refetch,
    };
  },
  useBrowserFrame: (...args: unknown[]) => {
    state.frame(...args);
    return {
      frame: {
        url: "blob:frame",
        runtimeId: "runtime",
        tabId: "thread",
        documentId: "thread",
        viewport: { width: 1280, height: 720 },
      },
      error: state.frameError,
      visible: state.visible,
      retry: state.retry,
    };
  },
}));
afterEach(() => {
  state.data = undefined;
  state.error = null;
  state.frameError = null;
  state.visible = true;
  vi.clearAllMocks();
});
const props = { sessionId: "session", threadId: "thread", working: false };

function PreviewHarness() {
  const [choice, onChoose] = useState<string>();
  return <BrowserPreviewFeed {...props} choice={choice} onChoose={onChoose} />;
}

describe("read-only browser preview", () => {
  it("follows the active tab and allows a temporary pinned page", () => {
    state.data = ready();
    render(<PreviewHarness />);
    expect(state.frame).toHaveBeenLastCalledWith(
      "session",
      "runtime",
      "other",
      true,
      "other",
    );
    expect(
      screen
        .getByRole("img", { name: "Live browser page" })
        .getAttribute("src"),
    ).toBe("blob:frame");
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Preview page" }), {
      target: { value: "thread" },
    });
    expect(state.frame).toHaveBeenLastCalledWith(
      "session",
      "runtime",
      "thread",
      true,
      "thread",
    );
    fireEvent.click(screen.getByRole("button", { name: "Follow active tab" }));
    expect(state.frame.mock.calls.at(-1)?.[2]).toBe("other");
  });
  it("follows changes to the active tab while the agent works", () => {
    state.data = ready();
    const view = render(<PreviewHarness />);
    expect(state.frame.mock.calls.at(-1)?.[2]).toBe("other");
    state.data.status!.selectedTabId = "thread";
    view.rerender(<PreviewHarness />);
    expect(state.frame.mock.calls.at(-1)?.[2]).toBe("thread");
  });
  it("refreshes active-tab status quickly while the agent works", () => {
    state.data = ready();
    render(<BrowserPreviewFeed {...props} working onChoose={() => {}} />);
    expect(state.status).toHaveBeenLastCalledWith("session", {
      refetchInterval: 500,
    });
  });
  it.each(["viewer", "other-viewer"])(
    "shows live frames during explicit pause with resume limited to %s",
    (actorId) => {
      const data = ready();
      data.status!.control = {
        id: "lease",
        runtimeId: "runtime",
        actorId,
        state: "active",
        privateMode: false,
        expiresAt: Date.now() - 1,
      };
      state.data = data;
      render(<PreviewHarness />);
      expect(
        screen.getByRole("img", { name: "Live browser page" }),
      ).toBeTruthy();
      expect(screen.getByText("Agent paused")).toBeTruthy();
      if (actorId === "viewer") {
        fireEvent.click(screen.getByRole("button", { name: "Resume agent" }));
        expect(state.control).toHaveBeenCalledWith({
          action: "release",
          leaseId: "lease",
        });
      } else {
        expect(
          screen.queryByRole("button", { name: "Resume agent" }),
        ).toBeNull();
      }
    },
  );
  it.each([
    "private",
    "dialog",
    "disabled",
    "unsupported",
    "sleeping",
    "statusError",
    "permission",
    "frameError",
    "hidden",
  ])("hides cached frames when %s", (condition) => {
    const data = ready();
    const runtime = data.status!;
    if (condition === "private")
      runtime.control = {
        id: "lease",
        runtimeId: "runtime",
        actorId: "viewer",
        privateMode: true,
        state: "active",
        expiresAt: Date.now() + 1000,
      };
    if (condition === "dialog")
      runtime.dialogs = [
        {
          tabId: "thread",
          dialogId: "dialog",
          kind: "alert",
          message: "secret",
        },
      ];
    if (condition === "disabled") data.settings.enabled = false;
    if (condition === "unsupported")
      runtime.capabilities.viewer = { available: false };
    if (condition === "sleeping") runtime.state = "sleeping";
    if (condition === "statusError") data.error = "Runtime unreachable";
    if (condition === "permission") state.error = new Error("Access denied");
    if (condition === "frameError")
      state.frameError = "Permission expired. Retry to request access.";
    if (condition === "hidden") state.visible = false;
    state.data = data;
    render(<PreviewHarness />);
    expect(screen.queryByRole("img")).toBeNull();
    if (
      condition === "private" ||
      condition === "permission" ||
      condition === "statusError"
    ) {
      expect(screen.queryByRole("combobox")).toBeNull();
      expect(screen.queryByText("https://thread.example/")).toBeNull();
    }
    if (!["frameError", "hidden"].includes(condition))
      expect(state.frame.mock.calls.at(-1)?.[3]).toBe(false);
  });
  it("offers retry on a failed feed and clears failed image decoding", () => {
    state.data = ready();
    const view = render(<PreviewHarness />);
    fireEvent.error(screen.getByRole("img"));
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry preview" }));
    expect(state.retry).toHaveBeenCalledOnce();
    expect(state.refetch).toHaveBeenCalledOnce();
    state.frameError = "Permission expired. Retry to request access.";
    view.rerender(<PreviewHarness />);
    expect(screen.getByText(state.frameError)).toBeTruthy();
  });
});
