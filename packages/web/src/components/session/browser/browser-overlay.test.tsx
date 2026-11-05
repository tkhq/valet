// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserOverlay } from "./browser-overlay";
import { clampOverlay } from "./use-browser-overlay-geometry";

let resize: () => void;
let bounds = { width: 900, height: 650 };
const disconnect = vi.fn();
vi.mock("./browser-preview-feed", () => ({
  BrowserPreviewFeed: ({
    choice,
    onChoose,
  }: {
    choice?: string;
    onChoose: (id: string) => void;
  }) => (
    <div data-testid="feed">
      {choice ?? "auto page"}
      <button onClick={() => onChoose("chosen page")}>choose page</button>
    </div>
  ),
}));
beforeEach(() => {
  disconnect.mockClear();
  bounds = { width: 900, height: 650 };
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, bounds.width, bounds.height),
  );
  vi.stubGlobal("PointerEvent", MouseEvent);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  disconnect.mockClear();
});
const props = {
  sessionId: "s",
  threadId: "t",
  working: true,
  minimized: false,
  onMinimize: vi.fn(),
  onRestore: vi.fn(),
  onClose: vi.fn(),
  onExpand: vi.fn(),
};
function rect() {
  const style = screen.getByRole("region", { name: "Browser preview" }).style;
  return {
    x: parseFloat(style.getPropertyValue("--preview-x")),
    y: parseFloat(style.getPropertyValue("--preview-y")),
    width: parseFloat(style.getPropertyValue("--preview-width")),
    height: parseFloat(style.getPropertyValue("--preview-height")),
  };
}

describe("floating preview", () => {
  it("clamps oversized and negative positions, including narrow containers", () => {
    expect(
      clampOverlay(
        { x: -40, y: 800, width: 800, height: 600 },
        { width: 260, height: 180 },
      ),
    ).toEqual({ x: 0, y: 0, width: 260, height: 180 });
  });
  it("suspends the feed when minimized and wires every window control", () => {
    const view = render(<BrowserOverlay {...props} />);
    expect(screen.getByTestId("feed")).toBeTruthy();
    fireEvent.click(screen.getByText("choose page"));
    expect(screen.getByText("chosen page")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Minimize browser preview" }),
    );
    expect(props.onMinimize).toHaveBeenCalled();
    view.rerender(<BrowserOverlay {...props} minimized />);
    expect(screen.queryByTestId("feed")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Restore browser preview" }),
    );
    expect(props.onRestore).toHaveBeenCalled();
    view.rerender(<BrowserOverlay {...props} />);
    expect(screen.getByText("chosen page")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Open full Browser view" }),
    );
    expect(props.onExpand).toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Close browser preview" }),
    );
    expect(props.onClose).toHaveBeenCalled();
  });
  it("moves and resizes with keyboard and resets with Home", () => {
    render(<BrowserOverlay {...props} />);
    const initial = rect();
    const move = screen.getByRole("button", { name: "Move browser preview" });
    fireEvent.keyDown(move, { key: "ArrowLeft" });
    expect(rect().x).toBe(initial.x - 16);
    fireEvent.keyDown(move, { key: "ArrowDown", shiftKey: true });
    expect(rect().y).toBe(initial.y + 48);
    const size = screen.getByRole("button", { name: "Resize browser preview" });
    fireEvent.keyDown(size, { key: "ArrowLeft" });
    expect(rect().width).toBe(initial.width - 16);
    fireEvent.keyDown(size, { key: "Home" });
    expect(rect()).toEqual(initial);
  });
  it("drags and resizes with pointer capture, and stops on cancellation", () => {
    render(<BrowserOverlay {...props} />);
    const initial = rect();
    const move = screen.getByRole("button", { name: "Move browser preview" });
    fireEvent.pointerDown(move, { clientX: 500, clientY: 100, button: 0 });
    fireEvent.pointerMove(move, { clientX: 400, clientY: 150 });
    expect(rect().x).toBe(initial.x - 100);
    expect(rect().y).toBe(initial.y + 50);
    fireEvent.pointerCancel(move);
    fireEvent.pointerMove(move, { clientX: 300, clientY: 100 });
    expect(rect().x).toBe(initial.x - 100);
    const size = screen.getByRole("button", { name: "Resize browser preview" });
    fireEvent.pointerDown(size, { clientX: 600, clientY: 400, button: 0 });
    fireEvent.pointerMove(size, { clientX: 650, clientY: 420 });
    expect(rect().width).toBe(initial.width + 50);
    fireEvent.pointerUp(size);
  });
  it("clamps when the composer grows and suspends frames in a very short area", () => {
    const view = render(<BrowserOverlay {...props} />);
    bounds = { width: 300, height: 160 };
    act(() => resize());
    expect(rect().width).toBeLessThanOrEqual(300);
    expect(rect().y + rect().height).toBeLessThanOrEqual(160);
    expect(screen.queryByTestId("feed")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Open full Browser view" }),
    ).toBeTruthy();
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
