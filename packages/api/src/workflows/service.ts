/**
 * Owner-scoped workflow definition/run operations, shared by the HTTP
 * routes (`routes/workflows.ts`) and the agent-facing action plugin
 * (`workflows/actions.ts`). Cross-owner access returns null (routes map
 * that to 404) so an owned row and a missing row stay indistinguishable.
 */
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  validateWorkflowDefinition,
  type RunParams,
  type ValidateEnvironment,
  type WorkflowDefinition,
  type WorkflowStore,
  type WorkflowTriggerPayload,
} from "@valet/workflow";
import type { RunHost } from "@valet/workflow";
import type { ActionPlugin, ValetPlugin } from "@valet/engine";
import { NotFoundError } from "@valet/shared";
import type { AppDb } from "../lib/drizzle.js";
import { actionInvocations, workflowDefinitions, workflowRuns, workflowVersions, workflowWebhooks } from "../schema/index.js";
import { definitionVersionId } from "./definition-version.js";
import { isTeamMember, listTeamsForUser, lockTeamForOwnership } from "../services/teams.js";
import { isOrgMember } from "../services/org.js";
import {
  writeExecutionGrant,
  writeAlwaysAllowPolicy,
  AlwaysAllowNotAdminError,
  updateInvocationOutcome,
} from "../policies/service.js";
import type {
  GetWorkflowRunResponse,
  WorkflowDefinitionSummary,
  WorkflowRunSummary,
} from "../wire/types.js";

export interface WorkflowServiceDeps {
  db: AppDb;
  workflowStore: WorkflowStore;
  workflowRunHost: RunHost;
  /** Plugin catalog index — enables save-time validation of tool nodes'
   * service/action pairs (validator env hook). Optional so tests that
   * exercise definition CRUD without a plugin catalog stay lightweight. */
  actionPluginByService?: Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>;
  /** Full plugin list — trigger tools need the event catalogs
   * (`plugin.triggers`) for event-key validation and discovery. */
  plugins?: ValetPlugin[];
}

export interface WorkflowOwner {
  userId: string;
  orgId: string;
}

export function newWorkflowId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * `validateWorkflowDefinition` takes a `WorkflowDefinition`, not `unknown` —
 * it assumes `.nodes`/`.edges` already exist as arrays and iterates them
 * directly (a malformed shape would throw a `TypeError`, not produce a
 * validation error). Callers carry `unknown` JSON, so this narrows the
 * bare-minimum top-level shape first (object with array `nodes`/`edges`)
 * before handing off to the real validator, which then checks node/edge
 * *contents* in detail. The final cast is safe: every field the validator
 * dereferences has just been checked to exist with the right container type.
 */
export function validateDefinitionInput(
  value: unknown,
  env?: ValidateEnvironment,
): { ok: true; definition: WorkflowDefinition } | { ok: false; errors: string[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, errors: ["definition must be an object"] };
  }
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.nodes)) {
    return { ok: false, errors: ["definition.nodes must be an array"] };
  }
  if (!Array.isArray(obj.edges)) {
    return { ok: false, errors: ["definition.edges must be an array"] };
  }
  const definition = value as WorkflowDefinition;
  const result = validateWorkflowDefinition(definition, env);
  if (!result.ok) return { ok: false, errors: result.errors };
  return { ok: true, definition };
}

function rowToDefinition(row: typeof workflowDefinitions.$inferSelect): WorkflowDefinitionSummary {
  return {
    id: row.id,
    name: row.name,
    definition: row.definition,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ownerType: row.ownerType === "team" ? "team" : "user",
    ownerId: row.ownerId,
  };
}

/** True when `owner` (the caller) may act on `row` — either the row's
 * direct user owner, or a live member of the row's owning team.
 * Membership is re-checked on every call, never cached: per the
 * orchestrator spec's access model, leaving a team must drop access on
 * the caller's very next request, not at the next snapshot. */
async function isAuthorizedFor(
  db: AppDb,
  owner: WorkflowOwner,
  row: typeof workflowDefinitions.$inferSelect,
): Promise<boolean> {
  return isAuthorizedForOwner(db, owner, row);
}

/** Shared by definitions (`isAuthorizedFor` above) and runs (`ownedRun`,
 * `getWorkflowRunDetail` below) — a run started against a team-owned
 * workflow carries the SAME `{ownerType, ownerId}` shape (scheduler.ts /
 * events/dispatcher.ts copy it straight from the definition row at start
 * time), so both need the identical direct-or-team-member check. */
async function isAuthorizedForOwner(
  db: AppDb,
  owner: WorkflowOwner,
  target: { ownerType: string; ownerId: string },
): Promise<boolean> {
  if (target.ownerType === "user") return target.ownerId === owner.userId;
  if (target.ownerType === "team") return isTeamMember(db, target.ownerId, owner.userId);
  return false;
}

/** Exported so other workflow-domain services (`webhook-service.ts`,
 * `schedule-service.ts`, `trigger-service.ts`) share this exact ownership
 * check instead of hand-duplicating it or checking `orgId` alone (which
 * lets any org member act on a workflow they don't own — see those
 * callers' own comments for the incident this closes). A query this
 * security-relevant should have exactly one definition. */
export async function ownedDefinitionRow(
  db: AppDb,
  owner: WorkflowOwner,
  id: string,
): Promise<typeof workflowDefinitions.$inferSelect | null> {
  const rows = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return (await isAuthorizedFor(db, owner, row)) ? row : null;
}

export async function listWorkflowDefinitions(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
): Promise<WorkflowDefinitionSummary[]> {
  const myTeams = await listTeamsForUser(deps.db, owner.userId);
  const teamIds = myTeams.map((t) => t.id);
  const ownerMatch = and(eq(workflowDefinitions.ownerType, "user"), eq(workflowDefinitions.ownerId, owner.userId));
  const teamMatch =
    teamIds.length > 0
      ? and(eq(workflowDefinitions.ownerType, "team"), inArray(workflowDefinitions.ownerId, teamIds))
      : undefined;
  const rows = await deps.db
    .select()
    .from(workflowDefinitions)
    .where(teamMatch ? or(ownerMatch, teamMatch) : ownerMatch)
    .orderBy(desc(workflowDefinitions.updatedAt));
  return rows.map(rowToDefinition);
}

export async function getWorkflowDefinition(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  id: string,
): Promise<WorkflowDefinitionSummary | null> {
  const row = await ownedDefinitionRow(deps.db, owner, id);
  return row ? rowToDefinition(row) : null;
}

export async function createWorkflowDefinition(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  input: { name: string; definition: unknown; teamId?: string },
): Promise<WorkflowDefinitionSummary> {
  const now = Date.now();
  const id = newWorkflowId("wf");
  const values = { id, orgId: owner.orgId, name: input.name, definition: input.definition, createdAt: now, updatedAt: now };

  let ownerType: "user" | "team" = "user";
  let ownerId = owner.userId;

  // `typeof === "string"`, not `!== undefined`: `input` ultimately comes
  // from an unchecked JSON body cast at the route (`CreateWorkflowRequest`
  // isn't runtime-validated), so an explicit `teamId: null` from a client
  // that always sends the field is a real, expected shape — it must fall
  // through to a personal workflow, not misroute into the team branch and
  // 404 with a confusing "team null not found".
  if (typeof input.teamId === "string") {
    const teamId = input.teamId;
    // The membership check and the insert happen inside one transaction
    // holding `lockTeamForOwnership`'s advisory lock, so this
    // can't race `deleteTeam` (`services/teams.ts`) — without it, a
    // workflow could be inserted for a team whose membership/team rows
    // are deleted in the gap between this check and the insert, stranding
    // it permanently (see that lock's own doc comment for why
    // `db.transaction` alone isn't enough here).
    await deps.db.transaction(async (tx) => {
      await lockTeamForOwnership(tx, teamId);
      // Non-member and unknown-team look identical here (both a plain
      // `false`) — same "cross-owner access 404s, never 403s" convention
      // as the rest of this file, so a team's existence is never leaked
      // to a non-member's probe.
      if (!(await isTeamMember(tx, teamId, owner.userId))) {
        throw new NotFoundError("team", teamId);
      }
      await tx.insert(workflowDefinitions).values({ ...values, ownerType: "team", ownerId: teamId });
    });
    ownerType = "team";
    ownerId = teamId;
  } else {
    await deps.db.insert(workflowDefinitions).values({ ...values, ownerType: "user", ownerId: owner.userId });
  }

  await snapshotVersion(deps, id, 1, input.name, input.definition, now);
  return { id, name: input.name, definition: input.definition, createdAt: now, updatedAt: now, ownerType, ownerId };
}

/** Immutable per-save snapshot backing the UI's version history. */
async function snapshotVersion(
  deps: WorkflowServiceDeps,
  workflowId: string,
  version: number,
  name: string,
  definition: unknown,
  now: number,
): Promise<void> {
  await deps.db.insert(workflowVersions).values({
    id: newWorkflowId("wfv"),
    workflowId,
    version,
    name,
    definition,
    createdAt: now,
  });
}

async function nextVersionNumber(deps: WorkflowServiceDeps, workflowId: string): Promise<number> {
  const rows = await deps.db
    .select({ version: workflowVersions.version })
    .from(workflowVersions)
    .where(eq(workflowVersions.workflowId, workflowId))
    .orderBy(desc(workflowVersions.version))
    .limit(1);
  return (rows[0]?.version ?? 0) + 1;
}

export interface WorkflowVersionSummary {
  version: number;
  name: string;
  createdAt: number;
}

export interface WorkflowVersionDetail extends WorkflowVersionSummary {
  definition: unknown;
}

/** Newest-first version summaries; null when the workflow isn't owned. */
export async function listWorkflowVersions(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  id: string,
): Promise<WorkflowVersionSummary[] | null> {
  const row = await ownedDefinitionRow(deps.db, owner, id);
  if (!row) return null;
  const rows = await deps.db
    .select({
      version: workflowVersions.version,
      name: workflowVersions.name,
      createdAt: workflowVersions.createdAt,
    })
    .from(workflowVersions)
    .where(eq(workflowVersions.workflowId, id))
    .orderBy(desc(workflowVersions.version));
  return rows;
}

/** One stored version with its definition; null when unowned/missing. */
export async function getWorkflowVersion(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  id: string,
  version: number,
): Promise<WorkflowVersionDetail | null> {
  const row = await ownedDefinitionRow(deps.db, owner, id);
  if (!row) return null;
  const rows = await deps.db
    .select()
    .from(workflowVersions)
    .where(and(eq(workflowVersions.workflowId, id), eq(workflowVersions.version, version)))
    .limit(1);
  const v = rows[0];
  if (!v) return null;
  return { version: v.version, name: v.name, createdAt: v.createdAt, definition: v.definition };
}

/** Returns null when the workflow doesn't exist (or isn't owned). */
export async function updateWorkflowDefinition(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  id: string,
  input: { name?: string; definition?: unknown },
): Promise<WorkflowDefinitionSummary | null> {
  const row = await ownedDefinitionRow(deps.db, owner, id);
  if (!row) return null;

  const now = Date.now();
  // In-flight runs are unaffected: `workflow_runs.definition` snapshots the
  // definition at run-start time (plan decision 17), so updating the
  // definitions row here never reaches back into a running/parked run.
  await deps.db
    .update(workflowDefinitions)
    .set({
      name: input.name ?? row.name,
      definition: input.definition !== undefined ? input.definition : row.definition,
      updatedAt: now,
    })
    .where(eq(workflowDefinitions.id, id));

  // Version history: snapshot only when the definition actually changed —
  // a rename alone shouldn't mint a version.
  if (
    input.definition !== undefined &&
    definitionVersionId(input.definition) !== definitionVersionId(row.definition)
  ) {
    await snapshotVersion(
      deps,
      id,
      await nextVersionNumber(deps, id),
      input.name ?? row.name,
      input.definition,
      now,
    );
  }

  return {
    id,
    name: input.name ?? row.name,
    definition: input.definition !== undefined ? input.definition : row.definition,
    createdAt: row.createdAt,
    updatedAt: now,
    ownerType: row.ownerType === "team" ? "team" : "user",
    ownerId: row.ownerId,
  };
}

export type DeleteWorkflowResult = "deleted" | "not_found" | "has_active_runs";

/**
 * Hard-deletes a workflow definition. Refuses while the workflow has
 * non-settled runs — runs snapshot their definition so they WOULD keep
 * executing, but they'd be orphaned from every list view; forcing a
 * cancel-first flow keeps the run ledger navigable. Settled runs are kept
 * (they're history, reachable via their runId).
 */
export async function deleteWorkflowDefinition(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  id: string,
): Promise<DeleteWorkflowResult> {
  const row = await ownedDefinitionRow(deps.db, owner, id);
  if (!row) return "not_found";

  const runRows = await deps.db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(eq(workflowRuns.workflowId, id));
  for (const r of runRows) {
    const run = await deps.workflowStore.getRun(r.id);
    if (run && run.status !== "settled") return "has_active_runs";
  }

  await deps.db.delete(workflowDefinitions).where(eq(workflowDefinitions.id, id));
  await deps.db.delete(workflowVersions).where(eq(workflowVersions.workflowId, id));
  // No FK/cascade on workflow_webhooks (it's keyed by workflowId, a plain
  // text column) — without this, a deleted workflow's hookId secret would
  // sit in the table forever, unreachable through any owner-facing route
  // (every webhook-service.ts entry point re-checks ownedDefinitionRow,
  // which is now gone) but never actually removed.
  await deps.db.delete(workflowWebhooks).where(eq(workflowWebhooks.workflowId, id));
  return "deleted";
}

/** Returns null when the workflow doesn't exist (or isn't owned). */
export async function startWorkflowRun(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  workflowId: string,
  input?: Record<string, unknown>,
): Promise<{ runId: string } | null> {
  const row = await ownedDefinitionRow(deps.db, owner, workflowId);
  if (!row) return null;

  const definition = row.definition;
  const versionId = definitionVersionId(definition);
  const runId = newWorkflowId("wfrun");

  const trigger: WorkflowTriggerPayload = {
    type: "manual",
    timestamp: new Date().toISOString(),
    data: input ?? {},
    metadata: {},
  };
  const params: RunParams = {
    workflowId,
    definitionVersionId: versionId,
    input: trigger,
  };

  await deps.workflowRunHost.start(runId, params, definition, {
    ownerType: "user",
    ownerId: owner.userId,
  });
  return { runId };
}

export async function listWorkflowRuns(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  workflowId: string,
): Promise<WorkflowRunSummary[] | null> {
  const row = await ownedDefinitionRow(deps.db, owner, workflowId);
  if (!row) return null;

  // `WorkflowStore` has no "list runs by workflowId" method — it's a small,
  // portable port (decision 6) and this is an API-only read concern, so the
  // list is built by asking the app db for the definition's run ids, then
  // re-fetching each through the store for a consistent shape. `workflow_runs`
  // doesn't index by owner alone, but every row here is already scoped by
  // `workflowId`, which we've just verified is owned.
  const runRows = await deps.db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(eq(workflowRuns.workflowId, workflowId))
    .orderBy(desc(workflowRuns.createdAt));

  const runs: WorkflowRunSummary[] = [];
  for (const r of runRows) {
    const run = await deps.workflowStore.getRun(r.id);
    if (!run) continue;
    runs.push({
      runId: run.runId,
      workflowId: run.params.workflowId,
      status: run.status,
      outcome: run.outcome,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    });
  }
  return runs;
}

/** Owner-gated run lookup shared by cancel/approval below. */
async function ownedRun(deps: WorkflowServiceDeps, owner: WorkflowOwner, runId: string) {
  const run = await deps.workflowStore.getRun(runId);
  if (!run || !run.owner || !(await isAuthorizedForOwner(deps.db, owner, run.owner))) {
    return null;
  }
  return run;
}

export type ResolveApprovalOutcome =
  | "ok" | "not_found" | "not_parked" | "already_resolved" | "timed_out"
  | "forbidden_always" | "org_mismatch" | "human_only";

/** Scan `definition` (unknown at runtime) for the node with `nodeId`. */
function findNodeInDefinition(definition: unknown, nodeId: string): Record<string, unknown> | undefined {
  if (typeof definition !== "object" || definition === null) return undefined;
  const def = definition as Record<string, unknown>;
  if (!Array.isArray(def.nodes)) return undefined;
  for (const node of def.nodes) {
    if (typeof node !== "object" || node === null) continue;
    const n = node as Record<string, unknown>;
    if (n.id === nodeId) return n;
    // foreach body node
    if (n.type === "foreach" && typeof n.body === "object" && n.body !== null) {
      const body = n.body as Record<string, unknown>;
      if (body.id === nodeId) return body;
    }
  }
  return undefined;
}

async function definitionOrgId(db: AppDb, workflowId: string): Promise<string | null> {
  const rows = await db
    .select({ orgId: workflowDefinitions.orgId })
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.id, workflowId))
    .limit(1);
  return rows[0]?.orgId ?? null;
}

/** Terminates a run. `not_found` covers unknown AND un-owned run ids. */
export async function cancelWorkflowRun(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  runId: string,
): Promise<"ok" | "not_found"> {
  const run = await ownedRun(deps, owner, runId);
  if (!run) return "not_found";
  await deps.workflowRunHost.terminate(runId);

  // Stamp pending gate audit rows for this run as cancelled.
  try {
    if (run.params.workflowId) {
      const orgId = await definitionOrgId(deps.db, run.params.workflowId);
      if (orgId) {
        const rows = await deps.db
          .select({ invocationId: actionInvocations.invocationId })
          .from(actionInvocations)
          .where(
            and(
              eq(actionInvocations.orgId, orgId),
              sql`${actionInvocations.invocationId} LIKE ${`pol:wf:workflow:${runId}:%`}`,
              eq(actionInvocations.status, "pending"),
            ),
          );
        for (const row of rows) {
          await updateInvocationOutcome(deps.db, row.invocationId, orgId, { status: "cancelled" });
        }
      }
    }
  } catch (err) {
    console.error(`cancel gate stamp failed for run ${runId}:`, err);
  }

  return "ok";
}

/** Resolves an approval gate: validates the run is parked on the right signal,
 * writes any policy grants requested, inserts the resolution signal, and wakes
 * the run. Returns a rich outcome so callers can map to appropriate HTTP codes. */
export async function resolveWorkflowApproval(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  input: {
    runId: string;
    nodeId: string;
    approved: boolean;
    note?: string;
    scope?: "once" | "run" | "always";
    iteration?: number;
    via: "web" | "agent";
  },
): Promise<ResolveApprovalOutcome> {
  const run = await ownedRun(deps, owner, input.runId);
  if (!run) return "not_found";
  const iter = input.iteration ?? 0;
  const suffix = iter > 0 ? `:${iter}` : "";
  const signalType = `approval:${input.nodeId}${suffix}`;

  const wait = run.status === "parked"
    ? run.waitingOn.find((w) => w.kind === "signal" && w.signalType === signalType)
    : undefined;
  if (!wait || wait.kind !== "signal") return "not_parked";
  if (wait.timeoutAt !== undefined && Date.now() >= wait.timeoutAt) return "timed_out";

  const existing = await deps.workflowStore.listSignals(input.runId, { unconsumed: true });
  if (existing.some((s) => s.signalType === signalType)) return "already_resolved";

  const node = findNodeInDefinition(run.definition, input.nodeId);
  const isPolicyGate = node?.type === "tool";
  if (isPolicyGate && input.via === "agent") return "human_only";

  const orgId = await definitionOrgId(deps.db, run.params.workflowId);
  if (orgId === null || !(await isOrgMember(deps.db, orgId, owner.userId))) return "org_mismatch";

  if (input.approved && isPolicyGate) {
    const n = node as Record<string, unknown>;
    const service = typeof n.service === "string" ? n.service : "";
    const action = typeof n.action === "string" ? n.action : "";
    const actionId = action.includes(".") ? action : `${service}.${action}`;
    const now = Date.now();
    if (input.scope === "always") {
      try {
        await writeAlwaysAllowPolicy(deps.db, { orgId, actionId, grantedBy: owner.userId, now });
      } catch (err) {
        if (err instanceof AlwaysAllowNotAdminError) return "forbidden_always";
        throw err;
      }
    }
    if (input.scope === "always" || input.scope === "run") {
      await writeExecutionGrant(deps.db, input.runId, {
        orgId,
        service,
        actionId,
        grantedBy: owner.userId,
        now,
      });
    }
  }

  await deps.workflowStore.insertSignal({
    runId: input.runId,
    signalId: `approval:${input.nodeId}${suffix}:resolution`,
    signalType,
    payload: {
      approved: input.approved,
      resolvedBy: owner.userId,
      note: input.note,
      scope: input.scope,
      resolvedVia: input.via,
    },
    createdAt: Date.now(),
  });
  if (isPolicyGate) {
    await updateInvocationOutcome(
      deps.db,
      `pol:wf:workflow:${input.runId}:${input.nodeId}${suffix}`,
      orgId,
      { status: input.approved ? "approved" : "denied", resolvedBy: owner.userId },
    );
  }
  await deps.workflowRunHost.wake(input.runId);
  return "ok";
}

/** Returns null when the run doesn't exist or isn't owned by `owner`. */
export async function getWorkflowRunDetail(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  runId: string,
): Promise<GetWorkflowRunResponse | null> {
  const run = await deps.workflowStore.getRun(runId);
  if (!run || !run.owner || !(await isAuthorizedForOwner(deps.db, owner, run.owner))) {
    return null;
  }

  const [checkpoints, signals] = await Promise.all([
    deps.workflowStore.getCheckpoints(runId),
    deps.workflowStore.listSignals(runId, { unconsumed: true }),
  ]);

  return {
    run: {
      runId: run.runId,
      workflowId: run.params.workflowId,
      status: run.status,
      outcome: run.outcome,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      waitingOn: run.waitingOn,
      definition: run.definition,
      params: run.params,
    },
    checkpoints: checkpoints.map((cp) => ({
      nodeId: cp.nodeId,
      iteration: cp.iteration,
      status: cp.status,
      result: cp.result,
      error: cp.error,
      createdAt: cp.createdAt,
    })),
    signals: signals.map((s) => ({
      signalId: s.signalId,
      signalType: s.signalType,
      payload: s.payload,
      createdAt: s.createdAt,
    })),
  };
}
