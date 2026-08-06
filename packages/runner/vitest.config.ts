import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/agent-client.test.ts",
      "src/gateway.test.ts",
      "src/opencode-config-writer.test.ts",
      "src/secrets.test.ts",
      "src/opencode-manager.test.ts",
      "src/prompt.test.ts",
      "src/ephemeral-usage.test.ts",
    ],
    testTimeout: 10_000,
  },
});
