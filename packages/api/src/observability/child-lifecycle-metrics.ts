/**
 * Child session lifecycle signals. A settled child's sandbox is reclaimed,
 * then `ChildWatcher.retireChild` releases its working directory and
 * leaves the session hibernated. These metrics show when that breaks:
 *
 * - `valet_child_reclaim_failures_total{stage}`: a park, retention or
 *   working-directory release failed (`park`, `retention`, `workspace`).
 * - `valet_children_reclaimed_active`: children whose sandbox is reclaimed
 *   but whose session is still `active`. Expected 0.
 * - `valet_child_workspaces{state}`: working directories on the api host,
 *   `live` (sandbox not reclaimed) or `retired` (reclaimed, but files are
 *   still in it; retire empties it). Expected `retired` = 0.
 * - `valet_child_workspace_bytes`: bytes under the working-directory root,
 *   sampled every 10 minutes.
 *
 * Alert on them; no code repairs them (repo rule: alert, don't auto-repair).
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { metrics } from "@opentelemetry/api";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, childWatches } from "../schema/index.js";

export type ChildReclaimFailureStage = "park" | "retention" | "workspace";

type Counter = ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
let reclaimFailures: Counter | undefined;

export function recordChildReclaimFailure(stage: ChildReclaimFailureStage): void {
  reclaimFailures ??= metrics.getMeter("@valet/api").createCounter("valet_child_reclaim_failures", {
    description: "Failed child sandbox parks, retention reclaims and working-directory releases",
  });
  reclaimFailures.add(1, { stage });
}

/** Children whose sandbox is reclaimed but whose session is still `active`. */
export async function reclaimedActiveChildren(db: AppDb): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(childWatches)
    .innerJoin(agentSessions, eq(agentSessions.id, childWatches.childSessionId))
    .where(and(eq(childWatches.settled, true), isNotNull(childWatches.sandboxReclaimedAt), eq(agentSessions.status, "active")));
  return row?.n ?? 0;
}

/** Working directories under `root`: `live` (sandbox not reclaimed) and `retired` (reclaimed, not empty). */
export async function childWorkspaceCounts(db: AppDb, root: string): Promise<{ live: number; retired: number }> {
  const names = await fs.readdir(root).catch(() => [] as string[]);
  if (names.length === 0) return { live: 0, retired: 0 };
  const retired = new Set<string>();
  for (let i = 0; i < names.length; i += 500) {
    const rows = await db.select({ id: childWatches.childSessionId }).from(childWatches)
      .where(and(inArray(childWatches.childSessionId, names.slice(i, i + 500)), isNotNull(childWatches.sandboxReclaimedAt)));
    for (const row of rows) retired.add(row.id);
  }
  let notEmpty = 0;
  for (const id of retired) if ((await fs.readdir(join(root, id)).catch(() => [] as string[])).length > 0) notEmpty++;
  return { live: names.length - retired.size, retired: notEmpty };
}

/** Bytes under `dir`. Entries the api user cannot read count as 0. */
export async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(path);
    else total += (await fs.lstat(path).catch(() => null))?.size ?? 0;
  }
  return total;
}

const BYTES_SAMPLE_MS = 10 * 60_000;
const registered = new WeakSet<AppDb>();

export function registerChildLifecycleMetrics(db: AppDb, root: string): void {
  if (registered.has(db)) return;
  registered.add(db);
  const meter = metrics.getMeter("@valet/api");
  meter.createObservableGauge("valet_children_reclaimed_active", {
    description: "Children whose sandbox is reclaimed but whose session is still active",
  }).addCallback(async (result) => result.observe(await reclaimedActiveChildren(db)));
  meter.createObservableGauge("valet_child_workspaces", {
    description: "Child working directories on the api host, by live or retired child",
  }).addCallback(async (result) => {
    const counts = await childWorkspaceCounts(db, root);
    result.observe(counts.live, { state: "live" });
    result.observe(counts.retired, { state: "retired" });
  });
  // A walk of a large root is slow, so it runs on its own timer and the gauge reports the last sample.
  let bytes = 0;
  const sample = () => void directoryBytes(root).then((n) => { bytes = n; }, () => undefined);
  sample();
  setInterval(sample, BYTES_SAMPLE_MS).unref();
  meter.createObservableGauge("valet_child_workspace_bytes", {
    unit: "By", description: "Bytes under the child working-directory root, sampled every 10 minutes",
  }).addCallback((result) => result.observe(bytes));
}
