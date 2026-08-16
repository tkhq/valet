import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./src/test/setup.ts"],
    // `isolate: false` (sharing the module registry across files in a
    // worker) was tried here for perf, but under CI's smaller worker count
    // it let one file's `vi.mock` override win for a DIFFERENT file's test
    // of the same module — not just missing exports (the `importOriginal`
    // pattern used throughout this suite's mocks fixes that part), but
    // wrong override VALUES bleeding across files that mock the same
    // module with different data. Reproduced locally by forcing a single
    // worker (`--pool=forks --maxWorkers=1`): model-picker, editor,
    // approval-card, and settings tests all failed on stale/foreign mock
    // state. Isolation costs about a second on the full suite locally —
    // worth it over flaky, diff-unrelated CI failures.
  },
  resolve: {
    alias: {
      "~": resolve(__dirname, "./src"),
    },
  },
});
