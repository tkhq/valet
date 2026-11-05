/**
 * Records an LLM step's model call as a usage entry, so Usage counts it.
 *
 * A session step runs in an engine session, and the engine writes each turn
 * to `engine_entries` with its usage and cost. An LLM step calls the model
 * directly and has no session, so before this record its spend reached no
 * usage table. The record is one `engine_entries` row of type `usage` under
 * the step's session id (`workflowStepSessionId`). The usage triggers then
 * project it like any other turn: `usage_entry_facts`, the hourly and daily
 * rollups, and `cost_entries` all attribute it to the run and the step. No
 * engine session or thread exists for that id, so no conversation shows it,
 * and the store's entry readers skip the type (`USAGE_ENTRY_TYPE`).
 */
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Usage } from "@earendil-works/pi-ai/compat";
import { modelCallUsage, type MessageCost, type MessageUsage } from "@valet/engine";
import { USAGE_ENTRY_TYPE } from "@valet/store-postgres";
import { workflowStepSessionId } from "@valet/workflow";
import type { AppDb } from "../lib/drizzle.js";

/**
 * The usage and cost an engine turn would persist for this call, by the
 * engine's own rule (`modelCallUsage`): no usage when the provider reported
 * no tokens, and no cost (unpriced, never "$0") when it reported no price.
 */
export function stepUsageEntry(usage: Usage): { usage: MessageUsage; cost?: MessageCost } | null {
  const call = modelCallUsage(usage);
  if (!call.usage) return null;
  return call.cost ? { usage: call.usage, cost: call.cost } : { usage: call.usage };
}

/** An id in the engine's entry shape (`e-<time>-<random>`), so entries keep
 * their creation order when the usage backfill pages through them by id. */
function entryId(now: number): string {
  return `e-${now.toString(36)}-${randomBytes(6).toString("hex")}`;
}

export async function recordLlmStepUsage(db: AppDb, step: {
  runId: string; nodeId: string; iteration: number; model: string; usage: Usage; now?: number;
}): Promise<void> {
  const entry = stepUsageEntry(step.usage);
  if (!entry) return;
  const now = step.now ?? Date.now();
  const sessionId = workflowStepSessionId(step.runId, step.nodeId, step.iteration);
  await db.execute(sql`INSERT INTO engine_entries (id, session_id, thread_id, entry_type, model, usage, cost, created_at)
    VALUES (${entryId(now)}, ${sessionId}, ${sessionId}, ${USAGE_ENTRY_TYPE}, ${step.model}, ${JSON.stringify(entry.usage)},
      ${entry.cost ? JSON.stringify(entry.cost) : null}, ${now})`);
}
