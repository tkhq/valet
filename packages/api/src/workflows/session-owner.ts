/**
 * The principal a workflow session acts as, for the sandbox-facing routes.
 *
 * A `session` node's engine session (`wf:{runId}:{nodeId}[:{iteration}]`) has
 * no `agent_sessions` row, so `routes/sandbox-git-credential.ts` and
 * `routes/sandbox-secrets.ts` cannot read its owner the way they read a coding
 * session's. The run row holds it: `workflow_runs.owner_type`/`owner_id` is
 * what credential resolution uses, and `actor_user_id` (who clicked Run) is
 * display and audit only. The session's sandbox token carries that actor,
 * because `mintSandboxEnv` takes the run context's `actorUserId`. A route that
 * trusted the token alone would therefore act as the member for a team-owned
 * run that a member started by hand, and as the synthetic `team:{id}` actor
 * for one that a schedule started.
 */
import { and, eq } from "drizzle-orm";
import { parsePrincipal, type Principal } from "@valet/engine";
import type { AppQueryable } from "../lib/drizzle.js";
import { agentSessions, workflowDefinitions, workflowRuns } from "../schema/index.js";
import { parseWorkflowSessionId } from "./engine-deps.js";

/**
 * `undefined` when `sessionId` is not a workflow session: no `wf:` prefix, or
 * an `agent_sessions` row exists for it. Workflow sessions never have one,
 * and every other session kind does, so a row decides the question even if
 * a future id scheme ever produced a `wf:`-prefixed coding or child session.
 *
 * `null` when it is one but its owner cannot be established: the id is
 * malformed, the run is gone (its workflow was deleted or belongs to another
 * org), or the stored owner is not a recognizable principal. Callers fail
 * closed on `null`; they must not fall back to the token's actor.
 *
 * A run that an unattended run started (`workflows.start_run` from a tool
 * node) can be stamped owned by a USER whose id is the parent's synthetic
 * actor, `org:{id}` or `team:{id}` (`workflows/service.ts`
 * `startWorkflowRun`). No person owns such a run, so it resolves as the
 * principal that id names. It must not reach the user ladder, whose last
 * tier is the org PAT.
 */
export async function workflowSessionOwner(
  db: AppQueryable,
  sessionId: string,
  orgId: string,
): Promise<Principal | null | undefined> {
  if (!sessionId.startsWith("wf:")) return undefined;
  const appRows = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  if (appRows.length > 0) return undefined;
  let runId: string;
  try {
    runId = parseWorkflowSessionId(sessionId).runId;
  } catch {
    return null;
  }
  const rows = await db
    .select({ ownerType: workflowRuns.ownerType, ownerId: workflowRuns.ownerId })
    .from(workflowRuns)
    .innerJoin(workflowDefinitions, eq(workflowDefinitions.id, workflowRuns.workflowId))
    .where(and(eq(workflowRuns.id, runId), eq(workflowDefinitions.orgId, orgId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const owner = parsePrincipal(`${row.ownerType}:${row.ownerId}`);
  if (owner?.type !== "user") return owner;
  const named = parsePrincipal(owner.id);
  if (!named) return owner;
  if (named.type === "user") return null;
  if (named.type === "org" && named.id !== orgId) return null;
  return named;
}
