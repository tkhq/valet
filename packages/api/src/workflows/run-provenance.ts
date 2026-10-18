/**
 * Which server build and which saved workflow version a run used. A person
 * debugging a run needs both before anything else: a fix that is merged but
 * not deployed, or an edit made after the run, explains many failures.
 */
import { desc, eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { workflowVersions } from "../schema/index.js";
import { valetBuildSha } from "../version.js";
import type { WorkflowRunProvenance } from "../wire/types.js";
import { sameWorkflowSteps } from "./definition-version.js";

/** Saved versions searched for a match. Older runs show no version number. */
const VERSIONS_SEARCHED = 100;

export async function workflowRunProvenance(
  db: AppDb,
  run: { workflowId: string; definition: unknown; params: unknown },
): Promise<WorkflowRunProvenance> {
  const rows = await db.select({ version: workflowVersions.version, definition: workflowVersions.definition })
    .from(workflowVersions)
    .where(eq(workflowVersions.workflowId, run.workflowId))
    .orderBy(desc(workflowVersions.version))
    .limit(VERSIONS_SEARCHED);
  // The run row keeps the definition it started with. The newest saved
  // version with the same steps is the one it ran; a map-layout move is not an edit.
  const match = rows.find((row) => sameWorkflowSteps(row.definition, run.definition));
  const build = run.params && typeof run.params === "object" ? (run.params as { build?: unknown }).build : undefined;
  const serverBuild = valetBuildSha();
  return {
    ...(typeof build === "string" ? { build } : {}),
    ...(serverBuild ? { serverBuild } : {}),
    ...(match ? { workflowVersion: match.version } : {}),
    ...(rows[0] ? { latestWorkflowVersion: rows[0].version } : {}),
  };
}
