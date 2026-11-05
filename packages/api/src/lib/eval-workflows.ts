/**
 * Workflow access for the eval harness's workflow-authoring cases.
 *
 * The eval package scores the workflow definitions an assistant drafts. It
 * needs two things the api owns: the step-design heuristic, and the
 * definitions that a product-drive case saved. This module owns both, so
 * the eval package never touches the workflow service internals or the
 * schema. Validity comes from the product's own save results, not from a
 * second validator here.
 */
import { asc } from "drizzle-orm";
import type { AppDb } from "./drizzle.js";
import { workflowDefinitions } from "../schema/index.js";

/** The step-design heuristic `preview_workflow` warns with: an agent prompt that asks for approval. */
export { approvalRequestWarning } from "@valet/workflow";

/** The `trigger.data` reads that a scheduled run leaves empty, by the scheduler's own rule. */
export { scheduledRunMisses } from "@valet/workflow";

/** Every workflow definition in the database, oldest update first. */
export async function listSavedWorkflows(
  db: AppDb,
): Promise<Array<{ id: string; name: string; definition: unknown; updatedAt: number }>> {
  return db
    .select({
      id: workflowDefinitions.id,
      name: workflowDefinitions.name,
      definition: workflowDefinitions.definition,
      updatedAt: workflowDefinitions.updatedAt,
    })
    .from(workflowDefinitions)
    .orderBy(asc(workflowDefinitions.updatedAt));
}
