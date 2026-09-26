import { parseArgs } from "node:util";
import pg from "pg";
import { buildAppDb } from "../src/lib/drizzle.js";
import { repriceProxyCalls } from "../src/proxy/reprice.js";

const { values } = parseArgs({ options: {
  org: { type: "string" }, before: { type: "string" }, apply: { type: "boolean", default: false },
} });
const beforeMs = Date.parse(values.before ?? "");
if (!values.org || !Number.isFinite(beforeMs) || !process.env.DATABASE_URL) {
  throw new Error("Set DATABASE_URL and pass --org <org-id> --before <ISO-date>. Add --apply after reviewing the dry run.");
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const result = await repriceProxyCalls(buildAppDb(pool), { orgId: values.org, beforeMs, apply: values.apply });
  console.log(JSON.stringify({ mode: values.apply ? "applied" : "dry-run", rates: "current model catalog", ...result }, null, 2));
} finally {
  await pool.end();
}
