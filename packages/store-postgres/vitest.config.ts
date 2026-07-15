import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20000,
    // Multiple test files (pg-store, pg-event-stream, pg-restart-safe-gates)
    // point their docker-pg describe blocks at the same shared
    // TEST_DATABASE_URL container (unlike PGlite, which gets a fresh
    // in-process instance per file). Running files in parallel races their
    // TRUNCATEs/transactions against each other — real Postgres deadlocks
    // and cross-test data corruption, not a PGlite-only concern. Files run
    // sequentially; within a file, tests still run in their normal order.
    fileParallelism: false,
  },
});
