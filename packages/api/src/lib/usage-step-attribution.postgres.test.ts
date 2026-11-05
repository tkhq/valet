/** Concurrent boots on real PostgreSQL. Set TEST_DATABASE_URL to a disposable
 * database. Each run owns one schema. PGlite serializes all transactions, so
 * it cannot show two boots replacing the projection function at once. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { applyAppMigrations, buildAppQueryable } from "./drizzle.js";
import { prepareUsageStepAttribution } from "./usage-step-attribution.js";

const connectionString = process.env.TEST_DATABASE_URL;

describe.skipIf(!connectionString)("usage step attribution repair on concurrent boots (Postgres)", () => {
  const schema = `usage_step_${randomUUID().replaceAll("-", "")}`;
  const options = `-c search_path=${schema} -c statement_timeout=15000`;
  let admin: Pool;
  let first: Pool;
  let second: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    first = new Pool({ connectionString, options, max: 1 });
    second = new Pool({ connectionString, options, max: 1 });
    await applyAppMigrations(buildAppQueryable(first));
  });

  afterAll(async () => {
    await Promise.all([first?.end(), second?.end()]);
    if (admin) {
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  });

  it("serializes two boots that replace the projection function at once", async () => {
    const one = buildAppQueryable(first);
    const two = buildAppQueryable(second);
    for (let attempt = 0; attempt < 40; attempt++) {
      const results = await Promise.allSettled([prepareUsageStepAttribution(one), prepareUsageStepAttribution(two)]);
      const failures = results.flatMap((r) => r.status === "rejected" ? [String(r.reason)] : []);
      expect(failures).toEqual([]);
    }
  }, 300_000);
});
