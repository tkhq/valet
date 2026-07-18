import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgDbFromPglite, type PgDb } from "../src/db.js";
import { applyEngineMigrations } from "../src/migrate.js";

/**
 * Guards the "uniform asset-read seam" refactor: the engine migration loader
 * reads its one pre-1.0 `0000_engine.sql` explicitly via
 * `readFileSync(new URL(...))` instead of scanning the migrations directory.
 * These assertions must hold regardless of how the SQL bytes are located, so
 * they double as a regression net for a later bundling step.
 */
async function tableExists(db: PgDb, table: string): Promise<boolean> {
  const result = await db.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1",
    [table],
  );
  return result.rows.length > 0;
}

describe("applyEngineMigrations (explicit single-file read)", () => {
  // One PGlite instance for this file — PGlite's wasm heap is not reliably
  // released on close(), so tests must never open a second in-process.
  const pglite = new PGlite();
  const db = pgDbFromPglite(pglite);

  beforeAll(async () => {
    await applyEngineMigrations(db);
  });

  afterAll(async () => {
    await db.close();
  });

  it("creates the engine_entries table from the explicitly-read 0000_engine.sql", async () => {
    expect(await tableExists(db, "engine_entries")).toBe(true);
  });

  it("records the migration under the name 0000_engine.sql", async () => {
    const result = await db.query("SELECT filename FROM __valet_engine_migrations");
    expect(result.rows).toEqual([{ filename: "0000_engine.sql" }]);
  });

  it("is idempotent: a second run leaves exactly one tracker row", async () => {
    await expect(applyEngineMigrations(db)).resolves.toBeUndefined();
    const result = await db.query(
      "SELECT filename FROM __valet_engine_migrations WHERE filename = $1",
      ["0000_engine.sql"],
    );
    expect(result.rows).toEqual([{ filename: "0000_engine.sql" }]);
    expect(await tableExists(db, "engine_entries")).toBe(true);
  });
});
