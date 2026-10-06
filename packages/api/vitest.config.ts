import { fileURLToPath } from "node:url";
import { defineConfig, defineProject } from "vitest/config";
import { INTEGRATION_LIST_FILES } from "../../scripts/e2e/lib.js";

const common = {
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    environment: "node" as const,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    exclude: [
      "**/node_modules/**", "**/dist/**",
      ...(process.env.VALET_E2E_DEDICATED_CORE === "1" ? INTEGRATION_LIST_FILES.core : []),
      ...(process.env.CI ? ["**/*.cluster.test.ts", "**/*.docker.test.ts", "**/integration/prebuilds.e2e.test.ts"] : []),
    ],
  },
};

// Root CI and package commands use the same projects. Only unit tests scrub keys.
export const apiProjects = [
  defineProject({
    ...common,
    test: {
      ...common.test,
      name: "unit",
      include: ["src/**/*.test.ts", "test/**/*.test.ts"],
      exclude: [...common.test.exclude, "src/integration/**"],
      setupFiles: ["./vitest.setup.ts"],
      isolate: false,
    },
  }),
  defineProject({
    ...common,
    test: {
      ...common.test,
      name: "integration",
      include: ["src/integration/**/*.test.ts"],
    },
  }),
];

export default defineConfig({ test: { projects: apiProjects } });
