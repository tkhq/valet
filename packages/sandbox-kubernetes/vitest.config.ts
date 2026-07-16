import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Bumped from 60s (Task 5): each conformance-suite `it()` provisions a
    // fresh Sandbox CR from scratch via `factory()` (pod-to-Ready typically
    // ~15-20s on this cluster, see lifecycle.cluster.test.ts's timings),
    // and the "workspace survives" case does that TWICE (create + a
    // pod-recreate wait) inside one test.
    testTimeout: 120_000,
  },
});
