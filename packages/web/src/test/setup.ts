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
// exists in jsdom. Minimal shims: xyflow only needs ResizeObserver to not
// throw on mount (component tests don't assert on measured layout), and
// only needs DOMMatrixReadOnly's constructor to exist (it's used to derive
// pane transforms, never asserted against here).
if (typeof document !== "undefined") {
  if (typeof globalThis.ResizeObserver === "undefined") {
    class ResizeObserverShim {
      observe() {}
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
}
