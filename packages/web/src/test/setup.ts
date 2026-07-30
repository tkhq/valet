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
  // jsdom's `window.localStorage` throws SecurityError on the default
  // `about:blank` opaque origin — WHATWG storage-partitioning rule.
  // Setting `environmentOptions.jsdom.url` in vitest.config.ts SHOULD fix
  // this, but the option doesn't reliably propagate to the per-file
  // `// @vitest-environment jsdom` opt-in path. Install a plain in-memory
  // Storage on the window so `readStoredTheme`/`applyStoredTheme` and any
  // `afterEach(() => window.localStorage.clear())` calls just work.
  // Test-only; production uses the real browser Storage.
  let storageWorks = false;
  try {
    // Actually CALL getItem — jsdom's opaque-origin Storage throws on
    // method invocation, not property access, so a bare `void
    // .getItem` isn't enough to detect the broken case.
    window.localStorage.getItem("__probe__");
    storageWorks = true;
  } catch {
    storageWorks = false;
  }
  if (!storageWorks) {
    const store = new Map<string, string>();
    const memory: Storage = {
      get length() {
        return store.size;
      },
      clear: () => store.clear(),
      getItem: (k) => store.get(k) ?? null,
      key: (i) => Array.from(store.keys())[i] ?? null,
      removeItem: (k) => void store.delete(k),
      setItem: (k, v) => void store.set(k, String(v)),
    };
    Object.defineProperty(window, "localStorage", { configurable: true, value: memory });
  }

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
