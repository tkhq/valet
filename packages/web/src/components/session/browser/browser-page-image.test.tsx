// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BrowserFrame } from "~/api/browser";
import { BrowserPageImage } from "./browser-page-image";

const frame: BrowserFrame = {
  url: "blob:first", runtimeId: "runtime", tabId: "tab", documentId: "doc",
  viewport: { width: 1280, height: 720 },
  agentCursor: { x: 320, y: 180, kind: "click", sequence: 1, ageMs: 500 },
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 640, 480));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("browser agent pointer", () => {
  it("waits for decoded pixels and maps the arrow tip through letterboxing", () => {
    const view = render(<BrowserPageImage frame={frame} alt="Page" />);
    expect(view.container.querySelector("[data-agent-pointer]")).toBeNull();
    fireEvent.load(screen.getByAltText("Page"));
    const pointer = view.container.querySelector<HTMLElement>("[data-agent-pointer]");
    expect(pointer?.style.transform).toBe("translate3d(160px, 150px, 0)");
    expect(pointer?.closest('[aria-hidden="true"]')?.className).toContain("pointer-events-none");
  });

  it("does not replay clicks or extend expiry when a sequence repeats", () => {
    const view = render(<BrowserPageImage frame={frame} alt="Page" />);
    fireEvent.load(screen.getByAltText("Page"));
    const pulse = view.container.querySelector("[data-agent-pulse]");
    act(() => vi.advanceTimersByTime(1000));
    view.rerender(<BrowserPageImage frame={{ ...frame, url: "blob:second" }} alt="Page" />);
    fireEvent.load(screen.getByAltText("Page"));
    expect(view.container.querySelector("[data-agent-pulse]")).toBe(pulse);
    act(() => vi.advanceTimersByTime(1000));
    expect(view.container.querySelector<HTMLElement>("[data-agent-pointer]")?.style.opacity).toBe("0");
  });

  it("clears on navigation, missing metadata, or local human input", () => {
    const view = render(<BrowserPageImage frame={frame} alt="Page" />);
    fireEvent.load(screen.getByAltText("Page"));
    view.rerender(<BrowserPageImage frame={frame} alt="Page" suppressedSequence={1} />);
    expect(view.container.querySelector<HTMLElement>("[data-agent-pointer]")?.style.opacity).toBe("0");
    view.rerender(<BrowserPageImage frame={{ ...frame, documentId: "new", url: "blob:new" }} alt="Page" />);
    expect(view.container.querySelector("[data-agent-pointer]")).toBeNull();
    fireEvent.load(screen.getByAltText("Page"));
    expect(view.container.querySelector("[data-agent-pointer]")).not.toBeNull();
    view.rerender(<BrowserPageImage frame={{ ...frame, agentCursor: undefined }} alt="Page" />);
    expect(view.container.querySelector("[data-agent-pointer]")).toBeNull();
  });

  it("keeps a click pulse consumed when a capture temporarily omits metadata", () => {
    const view = render(<BrowserPageImage frame={frame} alt="Page" />);
    fireEvent.load(screen.getByAltText("Page"));
    const pulse = view.container.querySelector("[data-agent-pulse]");
    view.rerender(<BrowserPageImage frame={{ ...frame, agentCursor: undefined }} alt="Page" />);
    fireEvent.load(screen.getByAltText("Page"));
    expect(view.container.querySelector<HTMLElement>("[data-agent-pointer]")?.style.opacity).toBe("0");
    view.rerender(<BrowserPageImage frame={frame} alt="Page" />);
    fireEvent.load(screen.getByAltText("Page"));
    expect(view.container.querySelector("[data-agent-pulse]")).toBe(pulse);
  });

  it("keeps readable artwork while mapping the mini preview size", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 320, 240));
    const view = render(<BrowserPageImage frame={frame} alt="Page" />);
    fireEvent.load(screen.getByAltText("Page"));
    expect(view.container.querySelector<HTMLElement>("[data-agent-pointer]")?.style.transform).toBe("translate3d(80px, 75px, 0)");
    expect(view.container.querySelector("svg")?.getAttribute("width")).toBe("26");
  });

  it("counts transfer and image decoding time toward activity expiry", () => {
    const view = render(<BrowserPageImage frame={{ ...frame, receivedAt: Date.now() }} alt="Page" />);
    act(() => vi.advanceTimersByTime(2100));
    fireEvent.load(screen.getByAltText("Page"));
    expect(view.container.querySelector("[data-agent-pointer]")).toBeNull();
  });
});
