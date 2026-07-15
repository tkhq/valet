import { describe, it } from "vitest";

// `SqliteWorkflowStore` (`./sqlite-store.ts`) is hard-typed against the raw
// better-sqlite3 handle underneath the app's Drizzle instance
// (`AppDb["$client"]`), which no longer exists now that `AppDb` is
// Postgres-backed (Task 7 of the postgres-backend plan,
// docs/specs/2026-07-15-postgres-backend-design.md). It's ported to a
// pg-native `PgWorkflowStore` in Task 8, at which point this suite is
// rewritten against the new implementation (still driving the shared
// `@valet/workflow/conformance` suites) over the shared PGlite test helper
// (`../test-helpers/pg-test-db.ts`).
describe.skip("SqliteWorkflowStore conformance (not yet ported to Postgres — Task 8)", () => {
  it("placeholder — real coverage returns in Task 8's PgWorkflowStore suite", () => {
    // intentionally empty
  });
});
