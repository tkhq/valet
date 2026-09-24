// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserViewport } from "./browser-viewport";
import type { BrowserFrame } from "~/api/browser";

const frame: BrowserFrame = {
  url: "blob:frame",
  runtimeId: "runtime",
  tabId: "tab",
  documentId: "document",
  viewport: { width: 1280, height: 720 },
};
afterEach(() => vi.restoreAllMocks());

describe("browser viewport", () => {
  it("requires control and a decoded frame before sending keys", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <BrowserViewport
        frame={frame}
        canControl={false}
        send={send}
        onError={() => {}}
      />,
    );
    const surface = screen.getByRole("textbox", { name: "Browser page input" });
    fireEvent.keyDown(surface, { key: "Enter" });
    expect(send).not.toHaveBeenCalled();
    view.rerender(
      <BrowserViewport
        frame={frame}
        canControl
        send={send}
        onError={() => {}}
      />,
    );
    fireEvent.keyDown(surface, { key: "Enter" });
    expect(send).not.toHaveBeenCalled();
    fireEvent.load(screen.getByAltText("Browser page"));
    fireEvent.keyDown(surface, { key: "Enter" });
    fireEvent.keyUp(surface, { key: "Enter" });
    await waitFor(() =>
      expect(send.mock.calls).toEqual([
        [{ type: "key", key: "Enter", phase: "down" }],
        [{ type: "key", key: "Enter", phase: "up" }],
      ]),
    );
  });

  it("sends composed text once without composition keystrokes", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    render(
      <BrowserViewport
        frame={frame}
        canControl
        send={send}
        onError={() => {}}
      />,
    );
    fireEvent.load(screen.getByAltText("Browser page"));
    const surface = screen.getByRole("textbox", { name: "Browser page input" });
    fireEvent.compositionStart(surface);
    fireEvent.keyDown(surface, { key: "Process", isComposing: true });
    fireEvent.compositionEnd(surface, { data: "日本語" });
    await waitFor(() =>
      expect(send.mock.calls).toEqual([[{ type: "text", text: "日本語" }]]),
    );
  });

  it("invalidates input when the document changes before a new image loads", () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <BrowserViewport
        frame={frame}
        canControl
        send={send}
        onError={() => {}}
      />,
    );
    fireEvent.load(screen.getByAltText("Browser page"));
    view.rerender(
      <BrowserViewport
        frame={{ ...frame, documentId: "new", url: "blob:new" }}
        canControl
        send={send}
        onError={() => {}}
      />,
    );
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Browser page input" }),
      { key: "Enter" },
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("waits for a resized frame to decode before mapping input", () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <BrowserViewport
        frame={frame}
        canControl
        send={send}
        onError={() => {}}
      />,
    );
    fireEvent.load(screen.getByAltText("Browser page"));
    view.rerender(
      <BrowserViewport
        frame={{
          ...frame,
          url: "blob:resized",
          viewport: { width: 800, height: 600 },
        }}
        canControl
        send={send}
        onError={() => {}}
      />,
    );
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Browser page input" }),
      { key: "Enter" },
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("sends explicit paste text without triggering the remote clipboard shortcut", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    render(
      <BrowserViewport
        frame={frame}
        canControl
        send={send}
        onError={() => {}}
      />,
    );
    fireEvent.load(screen.getByAltText("Browser page"));
    const surface = screen.getByRole("textbox", { name: "Browser page input" });
    fireEvent.keyDown(surface, { key: "v", ctrlKey: true });
    fireEvent.paste(surface, {
      clipboardData: { getData: () => "local clipboard" },
    });
    fireEvent.keyUp(surface, { key: "v", ctrlKey: true });
    await waitFor(() =>
      expect(send.mock.calls).toEqual([
        [{ type: "text", text: "local clipboard" }],
      ]),
    );
  });

  it("prevents the local pane from scrolling while forwarding wheel input", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    render(
      <BrowserViewport
        frame={frame}
        canControl
        send={send}
        onError={() => {}}
      />,
    );
    fireEvent.load(screen.getByAltText("Browser page"));
    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 120,
    });
    fireEvent(
      screen.getByRole("textbox", { name: "Browser page input" }),
      wheel,
    );
    expect(wheel.defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: "wheel",
        deltaX: 0,
        deltaY: 120,
      }),
    );
  });
});
