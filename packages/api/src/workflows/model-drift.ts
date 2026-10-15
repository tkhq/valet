/**
 * Steps whose model changed between two runs that had the same steps.
 *
 * The platform can change the model a step runs on with no edit to the
 * workflow: an admin remaps a size tier, or a default changes. A workflow
 * that worked can then give worse results, and nothing on the run page
 * says why. This compares the models each step called in a run (its step
 * costs, from the usage projection) with the previous run of the same
 * workflow whose steps were the same (`sameWorkflowSteps`). A run after an
 * edit has no such run, so the change an author made is never flagged.
 *
 * A step is flagged only when it called none of the same models in the two
 * runs. A `switch_model` call or a provider fallback adds a model for one
 * turn, and the step still calls its assigned model, so a shared model means
 * the platform did not remap the step.
 */
import { and, desc, eq, lt, or } from "drizzle-orm";
import type { WorkflowStore } from "@valet/workflow";
import type { AppDb } from "../lib/drizzle.js";
import { workflowRuns } from "../schema/index.js";
import type { WorkflowModelChange, WorkflowStepCost } from "../wire/types.js";
import { sameWorkflowSteps } from "./definition-version.js";
import { findNodeInDefinition } from "./service.js";
import { workflowRunStepCosts } from "./step-cost.js";

/** Older runs read to find the previous run with the same steps. */
const PREVIOUS_RUN_WINDOW = 20;

/** The models each step called, over all its iterations. */
function modelsByStep(costs: WorkflowStepCost[]): Map<string, string[]> {
  const models = new Map<string, Set<string>>();
  for (const cost of costs) {
    const step = models.get(cost.nodeId) ?? new Set<string>();
    for (const model of cost.models) step.add(model);
    models.set(cost.nodeId, step);
  }
  return new Map([...models].filter(([, step]) => step.size > 0).map(([nodeId, step]) => [nodeId, [...step].sort()]));
}

/** `stepCosts` are the run's own step costs, which the run page already reads.
 * `canRead` is the run page's own access check. A run the viewer may not read
 * is never compared, so its models stay hidden. */
export async function workflowRunModelChanges(
  db: AppDb,
  store: Pick<WorkflowStore, "getCheckpoints">,
  run: { runId: string; workflowId: string; createdAt: number; definition: unknown },
  stepCosts: WorkflowStepCost[],
  canRead: (runId: string) => Promise<boolean>,
): Promise<WorkflowModelChange[]> {
  const current = modelsByStep(stepCosts);
  // A `workflow` step's models come from the runs it started. Their workflow
  // can be edited apart from this one, so its change is not the platform's.
  for (const nodeId of current.keys()) {
    if (findNodeInDefinition(run.definition, nodeId)?.type === "workflow") current.delete(nodeId);
  }
  if (current.size === 0) return [];

  const older = await db.select({ id: workflowRuns.id, definition: workflowRuns.definition }).from(workflowRuns)
    .where(and(eq(workflowRuns.workflowId, run.workflowId), or(
      lt(workflowRuns.createdAt, run.createdAt),
      and(eq(workflowRuns.createdAt, run.createdAt), lt(workflowRuns.id, run.runId)),
    )))
    .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
    .limit(PREVIOUS_RUN_WINDOW);
  let previousRun: (typeof older)[number] | undefined;
  for (const row of older) {
    // Checked one at a time: the newest readable run ends the search.
    if (sameWorkflowSteps(row.definition, run.definition) && await canRead(row.id)) {
      previousRun = row;
      break;
    }
  }
  if (!previousRun) return [];

  const previous = modelsByStep(await workflowRunStepCosts(db, store, previousRun.id));
  return [...current].flatMap(([nodeId, models]) => {
    const before = previous.get(nodeId);
    return before && !models.some((model) => before.includes(model)) ? [{ nodeId, previous: before, current: models }] : [];
  });
}
