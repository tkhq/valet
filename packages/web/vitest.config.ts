import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./src/test/setup.ts"],
    // Share the module registry across files in a worker — per-file
    // isolation re-imported React/Radix/xyflow for every test file.
    // Component tests already clean up per-test (setup.ts's afterEach
    // cleanup()); per-file `@vitest-environment jsdom` pragmas still get
    // their own environment.
    isolate: false,
  },
  resolve: {
    alias: {
      "~": resolve(__dirname, "./src"),
    },
  },
});
