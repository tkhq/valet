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
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // In CI, EXCLUDE infra-dependent e2e suites entirely (not merely skip):
      // some build a real k8s/docker client at module/collection scope, which
      // throws on the GitHub runner (no cluster/images) before a `describe.skip`
      // can take effect. They run unchanged locally (`CI` unset).
      ...(process.env.CI
        ? ["**/*.cluster.test.ts", "**/*.docker.test.ts", "**/integration/prebuilds.e2e.test.ts"]
        : []),
    ],
    // Generous timeout at the OUTER level. When this package runs as a project
    // of the ROOT vitest config (`projects: ['packages/api']`), the inner
    // projects' own `testTimeout` is not applied — the shared/outer config is —
    // so without this the CI runner (slower PGlite boot, docker pulls, app
    // boots) hits vitest's 5s default and times out. Belt-and-suspenders with
    // the inner values below (used when running this config directly).
    testTimeout: 120_000,
    hookTimeout: 120_000,
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts", "test/**/*.test.ts"],
          exclude: ["src/integration/**"],
          setupFiles: ["./vitest.setup.ts"],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["src/integration/**/*.test.ts"],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
