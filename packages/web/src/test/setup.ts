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
