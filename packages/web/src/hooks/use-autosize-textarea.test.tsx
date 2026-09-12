// @vitest-environment jsdom
import { createRef } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAutosizeTextarea } from "./use-autosize-textarea";

afterEach(() => vi.unstubAllGlobals());

it("grows for multiline drafts and shrinks when the draft is cleared", () => {
  const textarea = document.createElement("textarea");
  const ref = createRef<HTMLTextAreaElement>();
  ref.current = textarea;
  Object.defineProperty(textarea, "scrollHeight", {
    get: () => textarea.value.split("\n").length * 24 + 24,
  });
  const { rerender } = renderHook(
    ({ value }) => {
      textarea.value = value;
      useAutosizeTextarea(ref, value);
    },
    { initialProps: { value: "first line" } },
  );
  expect(textarea.style.height).toBe("48px");
  rerender({ value: "first line\nsecond line\nthird line" });
  expect(textarea.style.height).toBe("96px");
  rerender({ value: "" });
  expect(textarea.style.height).toBe("48px");
});

it("remeasures wrapping when the available width changes and disconnects on unmount", () => {
  let notifyResize = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) {
      notifyResize = callback;
    }
    observe() {}
    disconnect = disconnect;
  });
  const textarea = document.createElement("textarea");
  const ref = createRef<HTMLTextAreaElement>();
  ref.current = textarea;
  let width = 400;
  Object.defineProperty(textarea, "clientWidth", { get: () => width });
  Object.defineProperty(textarea, "scrollHeight", { get: () => width === 400 ? 48 : 96 });
  const { unmount } = renderHook(() => useAutosizeTextarea(ref, "A draft that wraps"));
  expect(textarea.style.height).toBe("48px");
  act(() => {
    width = 200;
    notifyResize();
  });
  expect(textarea.style.height).toBe("96px");
  unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});
