/**
 * Model spend per step of one workflow run, for the run page.
 *
 * The usage projection bills every model call a workflow makes to its step's
 * id (`wf:{runId}:{nodeId}[:{iteration}]`; see `step-usage.ts` and
 * `valet_usage_fact`), so the step and iteration are read back
 * from `usage_entry_facts.session_id`. A `workflow` step's own cost is the
 * cost of the runs it started, which bill to their own run ids. The walk
 * follows `childRunId` from the checkpoints and adds each child run's total
 * to the step that started it.
 */
import { sql } from "drizzle-orm";
import type { NodeCheckpoint, WorkflowStore } from "@valet/workflow";
import type { AppDb } from "../lib/drizzle.js";
import type { WorkflowStepCost } from "../wire/types.js";

/** Nesting deeper than this is not followed; such a child's spend is left out. */
const MAX_SUB_RUN_DEPTH = 5;

interface StepKey { nodeId: string; iteration: number }

interface FactRow {
  workflow_run_id: string; node_id: string; iteration: number | string;
  cost_usd: number | string; turns: number | string; unpriced_turns: number | string;
  total_tokens: number | string; models: string[] | null;
}

function childRuns(checkpoints: NodeCheckpoint[], step?: StepKey): { runId: string; step: StepKey }[] {
  return checkpoints.flatMap((cp) => typeof cp.effects?.childRunId === "string"
    ? [{ runId: cp.effects.childRunId, step: step ?? { nodeId: cp.nodeId, iteration: cp.iteration } }] : []);
}

/** Each sub-run reachable from `runId`, mapped to the root-run step that
 * started it. Each level of nesting reads its runs' checkpoints at once. */
async function subRunSteps(store: Pick<WorkflowStore, "getCheckpoints">, runId: string): Promise<Map<string, StepKey>> {
  const owners = new Map<string, StepKey>();
  let frontier = childRuns(await store.getCheckpoints(runId));
  for (let depth = 0; depth < MAX_SUB_RUN_DEPTH && frontier.length > 0; depth++) {
    const level = frontier.filter(({ runId: child }) => !owners.has(child) && child !== runId);
    for (const { runId: child, step } of level) owners.set(child, step);
    const reads = await Promise.all(level.map(async ({ runId: child, step }) => childRuns(await store.getCheckpoints(child), step)));
    frontier = reads.flat();
  }
  return owners;
}

/** Read by the run page route only: the walk reads every sub-run's checkpoints. */
export async function workflowRunStepCosts(
  db: AppDb, store: Pick<WorkflowStore, "getCheckpoints">, runId: string,
): Promise<WorkflowStepCost[]> {
  const owners = await subRunSteps(store, runId);
  const runIds = [runId, ...owners.keys()];
  const result = await db.execute(sql`
    SELECT workflow_run_id, split_part(session_id, ':', 3) AS node_id,
      -- Cast only digits: a read must never fail on an id it does not expect.
      CASE WHEN split_part(session_id, ':', 4) ~ '^[0-9]{1,9}$' THEN split_part(session_id, ':', 4)::int ELSE 0 END AS iteration,
      COALESCE(SUM((cost->>'total')::float8), 0) AS cost_usd, COUNT(*) AS turns,
      COUNT(*) FILTER (WHERE cost->>'total' IS NULL) AS unpriced_turns,
      COALESCE(SUM((usage->>'total')::bigint), 0) AS total_tokens,
      array_agg(DISTINCT model) FILTER (WHERE model IS NOT NULL) AS models
    FROM usage_entry_facts
    WHERE workflow_run_id IN (${sql.join(runIds.map((id) => sql`${id}`), sql`, `)}) AND usage IS NOT NULL
    GROUP BY 1, 2, 3`) as { rows: FactRow[] };

  const steps = new Map<string, WorkflowStepCost>();
  for (const row of result.rows) {
    const key = row.workflow_run_id === runId
      ? { nodeId: row.node_id, iteration: Number(row.iteration) }
      : owners.get(row.workflow_run_id);
    if (!key) continue;
    const id = `${key.nodeId}\u0000${key.iteration}`;
    const step = steps.get(id) ?? { ...key, costUsd: 0, turns: 0, unpricedTurns: 0, totalTokens: 0, models: [] };
    step.costUsd += Number(row.cost_usd);
    step.turns += Number(row.turns);
    step.unpricedTurns += Number(row.unpriced_turns);
    step.totalTokens += Number(row.total_tokens);
    step.models = [...new Set([...step.models, ...(row.models ?? [])])].sort();
    steps.set(id, step);
  }
  return [...steps.values()].sort((a, b) => b.costUsd - a.costUsd);
}
