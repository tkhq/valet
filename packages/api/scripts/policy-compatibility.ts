import { Pool } from "pg";
import { buildAppDb } from "../src/lib/drizzle.js";
import { currentPolicyCompatibilityReports } from "../src/authorization/policy-compatibility.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const pool = new Pool({ connectionString: databaseUrl });
try {
  const reports = await currentPolicyCompatibilityReports(buildAppDb(pool), new Map());
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, reports }, null, 2)}\n`);
  if (reports.some((report) => !report.compatible)) process.exitCode = 1;
} finally {
  await pool.end();
}
