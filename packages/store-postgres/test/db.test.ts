import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { isPgUniqueViolation, pgDbFromPglite, pgDbFromPool, type PgDb } from "../src/db.js";

/**
 * Shared assertions run against both drivers. `pgDbFromPglite`/`pgDbFromPool`
 * have deliberately divergent `transaction()` implementations (decision 4 of
 * docs/specs/2026-07-15-postgres-backend-design.md) but must satisfy the same
 * observable contract.
 */
function runPgDbSuite(label: string, getDb: () => PgDb, tableName: string) {
  describe(label, () => {
    beforeEach(async () => {
      const db = getDb();
      await db.query(`DROP TABLE IF EXISTS ${tableName}`);
      await db.query(`CREATE TABLE ${tableName} (id integer PRIMARY KEY, value integer NOT NULL)`);
    });

    it("normalizes rowCount for INSERT/UPDATE/DELETE", async () => {
      const db = getDb();

      const insert = await db.query(`INSERT INTO ${tableName} (id, value) VALUES ($1, $2)`, [1, 10]);
      expect(insert.rowCount).toBe(1);

      const update = await db.query(`UPDATE ${tableName} SET value = $1 WHERE id = $2`, [20, 1]);
      expect(update.rowCount).toBe(1);

      const updateNoMatch = await db.query(`UPDATE ${tableName} SET value = $1 WHERE id = $2`, [99, 404]);
      expect(updateNoMatch.rowCount).toBe(0);

      const del = await db.query(`DELETE FROM ${tableName} WHERE id = $1`, [1]);
      expect(del.rowCount).toBe(1);
    });

    it("returns rows as-is from a SELECT", async () => {
      const db = getDb();
      await db.query(`INSERT INTO ${tableName} (id, value) VALUES ($1, $2)`, [1, 42]);
      const result = await db.query(`SELECT id, value FROM ${tableName} WHERE id = $1`, [1]);
      expect(result.rows).toEqual([{ id: 1, value: 42 }]);
    });

    it("rejects transaction-control statements issued through the shared query()", async () => {
      const db = getDb();
      await expect(db.query("BEGIN")).rejects.toThrow(/transaction\(fn\)/);
      await expect(db.query("  begin ;")).rejects.toThrow(/transaction\(fn\)/);
      await expect(db.query("COMMIT")).rejects.toThrow(/transaction\(fn\)/);
      await expect(db.query("ROLLBACK")).rejects.toThrow(/transaction\(fn\)/);
      await expect(db.query("SAVEPOINT foo")).rejects.toThrow(/transaction\(fn\)/);
    });

    it("commits writes made inside transaction(fn)", async () => {
      const db = getDb();
      await db.query(`INSERT INTO ${tableName} (id, value) VALUES ($1, $2)`, [1, 1]);

      await db.transaction(async (tx) => {
        await tx.query(`UPDATE ${tableName} SET value = $1 WHERE id = $2`, [7, 1]);
      });

      const result = await db.query(`SELECT value FROM ${tableName} WHERE id = $1`, [1]);
      expect(result.rows[0]?.value).toBe(7);
    });

    it("rolls back writes made inside transaction(fn) when it throws", async () => {
      const db = getDb();
      await db.query(`INSERT INTO ${tableName} (id, value) VALUES ($1, $2)`, [1, 1]);

      await expect(
        db.transaction(async (tx) => {
          await tx.query(`UPDATE ${tableName} SET value = $1 WHERE id = $2`, [999, 1]);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      const result = await db.query(`SELECT value FROM ${tableName} WHERE id = $1`, [1]);
      expect(result.rows[0]?.value).toBe(1);
    });

    // The lost-update regression: two concurrent transaction(fn) blocks each
    // doing SELECT -> increment -> UPDATE on the same row must serialize.
    // A raw-BEGIN-through-query() implementation loses one of the two
    // increments (final value 1) because interleaved async callers share
    // the connection and FOR UPDATE provides no isolation across query()
    // calls. transaction(fn) must make this land on 2.
    it("serializes concurrent read-increment-write transactions (lost-update regression)", async () => {
      const db = getDb();
      await db.query(`INSERT INTO ${tableName} (id, value) VALUES ($1, $2)`, [1, 0]);

      const incrementOnce = () =>
        db.transaction(async (tx) => {
          const result = await tx.query(`SELECT value FROM ${tableName} WHERE id = $1 FOR UPDATE`, [1]);
          const current = result.rows[0]?.value;
          if (typeof current !== "number") throw new Error("expected numeric value");
          // Yield to let the other concurrent transaction attempt to interleave
          // if the implementation doesn't actually serialize.
          await new Promise((resolve) => setTimeout(resolve, 5));
          await tx.query(`UPDATE ${tableName} SET value = $1 WHERE id = $2`, [current + 1, 1]);
        });

      await Promise.all([incrementOnce(), incrementOnce()]);

      const result = await db.query(`SELECT value FROM ${tableName} WHERE id = $1`, [1]);
      expect(result.rows[0]?.value).toBe(2);
    });
  });
}

describe("pgDbFromPglite", () => {
  // Task 0 finding: PGlite's wasm heap is not reliably released on close(),
  // so this file shares ONE instance across all its tests rather than
  // opening a fresh PGlite per test.
  const pglite = new PGlite();
  const db = pgDbFromPglite(pglite);

  afterAll(async () => {
    await db.close();
  });

  runPgDbSuite("pgDbFromPglite", () => db, "pglite_db_test");
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("pgDbFromPool", () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const db = pgDbFromPool(pool);

  afterAll(async () => {
    await db.close();
  });

  runPgDbSuite("pgDbFromPool", () => db, "pool_db_test");
});

describe("isPgUniqueViolation", () => {
  it("returns true for an error carrying code 23505", () => {
    const err = Object.assign(new Error("duplicate key value"), { code: "23505" });
    expect(isPgUniqueViolation(err)).toBe(true);
  });

  it("returns true when the code lives on err.cause", () => {
    const cause = Object.assign(new Error("duplicate key value"), { code: "23505" });
    const err = new Error("wrapped", { cause });
    expect(isPgUniqueViolation(err)).toBe(true);
  });

  it("returns false for other codes and non-error values", () => {
    expect(isPgUniqueViolation(Object.assign(new Error("nope"), { code: "23503" }))).toBe(false);
    expect(isPgUniqueViolation(new Error("plain"))).toBe(false);
    expect(isPgUniqueViolation(null)).toBe(false);
    expect(isPgUniqueViolation("not an error")).toBe(false);
  });

  it("detects the real unique-violation error surfaced by INSERT", async () => {
    const pglite = new PGlite();
    const db = pgDbFromPglite(pglite);
    try {
      await db.query("CREATE TABLE uniq_test (id integer PRIMARY KEY)");
      await db.query("INSERT INTO uniq_test (id) VALUES ($1)", [1]);
      let caught: unknown;
      try {
        await db.query("INSERT INTO uniq_test (id) VALUES ($1)", [1]);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(isPgUniqueViolation(caught)).toBe(true);
    } finally {
      await db.close();
    }
  });
});
