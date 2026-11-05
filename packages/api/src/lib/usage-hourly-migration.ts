import { assertCompleteUsageProjection } from "./usage-rollup-state.js";
import { readFileSync } from "node:fs";
import type { PgDb } from "@valet/store-postgres";
import { usageAnalyticsInstallSql } from "./usage-analytics-migration.js";
const migration = readFileSync(
  new URL("../../migrations/pg/0000_app.sql", import.meta.url),
  "utf8",
);
function section(start: string, end: string): string {
  const value = migration.split(`-- usage hourly ${start}\n`)[1]?.split(end)[0];
  if (!value)
    throw new Error(
      "Usage hourly migration missing. Restore 0000_app.sql from the release.",
    );
  return value;
}
export const usageHourlyPublishSql = `DO $publish$ BEGIN ${section("publish", "END $hourly$;")} ANALYZE usage_hourly; END $publish$`;
const DIMENSIONS = [
  "dimensions",
  "source_kind",
  "session_id",
  "org_id",
  "user_id",
  "team_id",
  "model",
  "provider",
  "created_at",
];
const METRICS = [
  "turns",
  "unpriced_turns",
  "positive_turns",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "total_tokens",
  "cost_total",
  "tool_calls",
  "pull_requests",
  "reviews",
];
const COLUMNS = [...DIMENSIONS, ...METRICS];
export async function prepareUsageHourly(db: PgDb): Promise<void> {
  // Daily totals cannot survive a missing hourly source without risking recounts.
  // An hourly-only installation is valid while the daily layer is first added.
  const daily = await db.query(
    "SELECT to_regclass('usage_daily') IS NOT NULL AS present",
  );
  await assertCompleteUsageProjection(
    db,
    daily.rows[0]?.present === true
      ? ["usage_hourly", "usage_hourly_progress", "usage_daily"]
      : ["usage_hourly", "usage_hourly_progress"],
  );
  await db.transaction(async (tx) => {
    await tx.query("SET LOCAL lock_timeout='5s'");
    // Also upgrades the fact function's composite return type for older releases.
    await tx.query(
      `DO $install$ BEGIN ${usageAnalyticsInstallSql} ${section("install", "-- usage hourly backfill")} END $install$`,
    );
  });
  for (const [source, table, id, project] of [
    ["engine", "usage_entry_facts", "entry_id", "valet_entry_hour"],
    ["proxy", "llm_proxy_requests", "id", "valet_proxy_hour"],
  ] as const) {
    for (;;) {
      // The progress lock serializes concurrent upgrades. Source locks order
      // corrections and deletes before this batch or after its committed watermark.
      // Live inserts and updates set hourly_accounted; the batch skips those rows.
      const result = await db.query(
        `WITH progress AS MATERIALIZED (
    SELECT watermark FROM usage_hourly_progress WHERE source_kind=$1 FOR UPDATE
   ), batch AS MATERIALIZED (
    SELECT source.* FROM ${table} source WHERE source.${id}>(SELECT watermark FROM progress)
    ORDER BY source.${id} LIMIT 10000 FOR UPDATE OF source
   ), contributions AS MATERIALIZED (
    SELECT h.* FROM batch b CROSS JOIN LATERAL ${project}(b) h WHERE NOT b.hourly_accounted
   ), deltas AS (
    SELECT ${DIMENSIONS.join(",")},${METRICS.map((f) => `SUM(${f}) AS ${f}`).join(",")}
    FROM contributions GROUP BY ${DIMENSIONS.join(",")}
   ), inserted AS (
    INSERT INTO usage_hourly(${COLUMNS.join(",")}) SELECT ${COLUMNS.join(",")} FROM deltas
    WHERE turns<>0 OR tool_calls<>0 OR pull_requests<>0 OR reviews<>0
    ORDER BY dimensions,created_at
    ON CONFLICT(dimensions,created_at) DO UPDATE SET
     ${METRICS.map((f) => `${f}=usage_hourly.${f}+EXCLUDED.${f}`).join(",")}
   ), advanced AS (
    UPDATE usage_hourly_progress SET watermark=(SELECT MAX(${id}) FROM batch)
    WHERE source_kind=$1 AND EXISTS(SELECT 1 FROM batch) RETURNING watermark
   ) SELECT watermark FROM advanced`,
        [source],
      );
      if (typeof result.rows[0]?.watermark !== "string") break;
    }
  }
}

/** Existing hourly-only installs build the smaller daily layer before serving. */
export async function prepareUsageDaily(db: PgDb): Promise<void> {
  const install = migration
    .split("-- usage daily install\n")[1]
    ?.split("-- usage daily end")[0];
  if (!install)
    throw new Error(
      "Daily usage migration missing. Restore 0000_app.sql from the release.",
    );
  await db.transaction(async (tx) => {
    await tx.query("SET LOCAL lock_timeout='5s'");
    await tx.query("SET LOCAL statement_timeout='30s'");
    await tx.query(`DO $install$ BEGIN ${install} END $install$`);
  });
}
