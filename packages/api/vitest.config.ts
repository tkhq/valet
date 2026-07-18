import { defineConfig } from "vitest/config";

// Two projects so the systematic ambient-env scrub (vitest.setup.ts) can
// apply to every test EXCEPT `src/integration/**`, whose suites are
// key-gated on a real `ANTHROPIC_API_KEY` in the shell (see vitest.setup.ts
// for why scrubbing that env var globally would break them). Splitting
// keeps the integration project's behavior byte-for-byte identical to
// before this file existed — same include glob, no setupFiles.
export default defineConfig({
  test: {
    // Exclude compiled output. `tsc --build` (run by `pnpm typecheck`) emits
    // `dist/**/*.test.js`; when this package is run as a project of the ROOT
    // vitest config (`projects: ['packages/api']`), the inner unit/integration
    // projects' `src/**`-only includes are not applied, so without this a
    // default scan would execute those broken compiled copies. Harmless to the
    // inner projects (they only include `src/**`).
    exclude: ["**/node_modules/**", "**/dist/**"],
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts", "test/**/*.test.ts"],
          exclude: ["src/integration/**"],
          setupFiles: ["./vitest.setup.ts"],
          testTimeout: 10_000,
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["src/integration/**/*.test.ts"],
          testTimeout: 10_000,
        },
      },
    ],
  },
});
