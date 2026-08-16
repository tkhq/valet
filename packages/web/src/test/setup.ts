/**
 * Global vitest setup. Applies to every test file regardless of resolved
 * environment (`node` for pure-logic tests, `jsdom` per-file opt-in via
 * `// @vitest-environment jsdom` for component tests) — the `document`
 * guard keeps this a no-op for the former.
 */
import { afterEach } from "vitest";

afterEach(async () => {
  if (typeof document === "undefined") return;
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

// `@xyflow/react` (Task 9's editor canvas) measures nodes/viewport via
// `ResizeObserver` and reads transforms via `DOMMatrixReadOnly` — neither
// exists in jsdom. Minimal shims: xyflow needs ResizeObserver's `observe`
// callback to actually fire once (even with jsdom's zero-size layout) so
// nodes flip to "measured" and edges — including their labels — get drawn;
// without this, edge/label assertions silently find nothing. Only needs
// DOMMatrixReadOnly's constructor to exist (it's used to derive pane
// transforms, never asserted against here).
if (typeof document !== "undefined") {
  if (typeof globalThis.ResizeObserver === "undefined") {
    class ResizeObserverShim implements ResizeObserver {
      #callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.#callback = callback;
      }
      observe(target: Element) {
        // jsdom never lays elements out, so every dimension here is zero.
        // xyflow reads `entry.target` (node id lookup) and, for the pane's
        // own resize observer, `entry.contentRect.{width,height}` — a
        // zeroed DOMRectReadOnly is a real object satisfying that read, not
        // a stand-in for layout data we don't have.
        const contentRect = new DOMRect(0, 0, 0, 0);
        const entry = { target, contentRect } as ResizeObserverEntry;
        queueMicrotask(() => this.#callback([entry], this));
      }
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = ResizeObserverShim as typeof ResizeObserver;
  }

  if (typeof globalThis.DOMMatrixReadOnly === "undefined") {
    class DOMMatrixReadOnlyShim {
      m22 = 1;
      constructor(_init?: string) {}
    }
    globalThis.DOMMatrixReadOnly = DOMMatrixReadOnlyShim as typeof DOMMatrixReadOnly;
  }

  // jsdom never runs layout, so `offsetWidth`/`offsetHeight` are always 0.
  // xyflow's node-measurement pass (`getDimensions` in @xyflow/system) treats
  // a zero width/height as "not yet measured" and leaves the node (and any
  // edge attached to it) hidden forever — the ResizeObserver firing above
  // isn't enough on its own. Stub a fixed, plausible node size so nodes
  // flip to measured and edges/labels actually render in these tests.
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 150,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 40,
  });

  // vitest 4's jsdom environment does not provide `localStorage`, though it
  // provides `window` and a real origin. The workspace scope persists there
  // (`lib/workspace-scope.tsx`), and its provider reads it during the first
  // render, so without this every test that renders a scoped surface fails
  // before asserting anything. Same class of gap as the shims above: jsdom
  // is missing a browser API this app legitimately uses.
  //
  // Per-file, not shared: each test file gets its own jsdom global, so this
  // starts empty for every file and needs no reset between them.
  if (typeof globalThis.localStorage === "undefined") {
    const store = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return store.size;
      },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, String(v)),
      removeItem: (k) => void store.delete(k),
      clear: () => store.clear(),
    };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    if (typeof window !== "undefined") {
      Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
    }
  }

  // Edge labels ("when" badges) measure their own text via SVG's `getBBox`,
  // which jsdom doesn't implement at all (not even as a zero-returning
  // stub) and throws instead. A fixed box is enough for the label to mount.
  if (typeof SVGElement !== "undefined" && !("getBBox" in SVGElement.prototype)) {
    Object.defineProperty(SVGElement.prototype, "getBBox", {
      configurable: true,
      value: () => ({ x: 0, y: 0, width: 40, height: 14 }),
    });
  }
}
