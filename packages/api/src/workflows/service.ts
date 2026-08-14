/**
 * Owner-scoped workflow definition/run operations, shared by the HTTP
 * routes (`routes/workflows.ts`) and the agent-facing action plugin
 * (`workflows/actions.ts`). Cross-owner access returns null (routes map
 * that to 404) so an owned row and a missing row stay indistinguishable.
 */
import { and, desc, eq, inArray, or } from "drizzle-orm";
import {
  validateWorkflowDefinition,
  type ListRunsFilter,
  type NodeCheckpoint,
  type RunParams,
  type ValidateEnvironment,
  type WorkflowDefinition,
  type WorkflowRunListItem,
  type WorkflowStore,
  type WorkflowTriggerPayload,
} from "@valet/workflow";
import type { RunHost } from "@valet/workflow";
import type { ActionPlugin, ValetPlugin } from "@valet/engine";
import { NotFoundError } from "@valet/shared";
import type { AppDb } from "../lib/drizzle.js";
import { workflowDefinitions, workflowVersions, workflowWebhooks } from "../schema/index.js";
import { definitionVersionId } from "./definition-version.js";
import { isTeamMember, listTeamsForUser, lockTeamForOwnership } from "../services/teams.js";
import type {
  GetWorkflowRunResponse,
  ListWorkflowRunsResponse,
  WorkflowDefinitionSummary,
  WorkflowRunCheckpoint,
  WorkflowRunOutcome,
  WorkflowRunStatus,
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

/** The "definitions this caller may read" predicate — their own, plus every
 * team they are a live member of. Shared by the definitions list and
 * `ownedWorkflowIds` so the two can never disagree about reach. Membership
 * is re-read on every call for the same reason `isAuthorizedFor` does. */
async function ownedDefinitionFilter(db: AppDb, owner: WorkflowOwner) {
  const myTeams = await listTeamsForUser(db, owner.userId);
  const teamIds = myTeams.map((t) => t.id);
  const ownerMatch = and(eq(workflowDefinitions.ownerType, "user"), eq(workflowDefinitions.ownerId, owner.userId));
  const teamMatch =
    teamIds.length > 0
      ? and(eq(workflowDefinitions.ownerType, "team"), inArray(workflowDefinitions.ownerId, teamIds))
      : undefined;
  return teamMatch ? or(ownerMatch, teamMatch) : ownerMatch;
}

/** Ids of every workflow the caller may read. The cross-workflow run list
 * scopes on these: `WorkflowStore.listRuns` takes no owner filter, so
 * authorization stays here in application code (batch-fanout design
 * decision 5). */
export async function ownedWorkflowIds(db: AppDb, owner: WorkflowOwner): Promise<string[]> {
  const rows = await db
    .select({ id: workflowDefinitions.id })
    .from(workflowDefinitions)
    .where(await ownedDefinitionFilter(db, owner));
  return rows.map((r) => r.id);
}

export async function listWorkflowDefinitions(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
): Promise<WorkflowDefinitionSummary[]> {
  const rows = await deps.db
    .select()
    .from(workflowDefinitions)
    .where(await ownedDefinitionFilter(deps.db, owner))
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

  const active = await deps.workflowStore.listRuns({
    workflowIds: [id],
    status: ["pending", "running", "parked", "terminalizing"],
    limit: 1,
  });
  if (active.runs.length > 0) return "has_active_runs";

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

/** Page size when the caller names none, and the ceiling it is clamped to.
 * Exported so callers can name the accepted range in their error message. */
export const RUN_PAGE_LIMIT_DEFAULT = 50;
export const RUN_PAGE_LIMIT_MAX = 200;

/** The run filter values callers may pass, and their guards. Defined once
 * here so the HTTP route and the agent action reject the same set. */
export const RUN_STATUS_VALUES = ["pending", "running", "parked", "terminalizing", "settled"] as const;
export const RUN_OUTCOME_VALUES = ["completed", "failed", "cancelled"] as const;

export function isRunStatus(value: string): value is WorkflowRunStatus {
  return RUN_STATUS_VALUES.some((v) => v === value);
}

export function isRunOutcome(value: string): value is WorkflowRunOutcome {
  return RUN_OUTCOME_VALUES.some((v) => v === value);
}

function clampRunLimit(limit: number | undefined): number {
  if (limit === undefined) return RUN_PAGE_LIMIT_DEFAULT;
  return Math.min(Math.max(Math.trunc(limit), 1), RUN_PAGE_LIMIT_MAX);
}

function toRunSummary(item: WorkflowRunListItem): WorkflowRunSummary {
  return {
    runId: item.runId,
    workflowId: item.workflowId,
    status: item.status,
    outcome: item.outcome,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    parentRunId: item.parentRunId,
    parentNodeId: item.parentNodeId,
    parentIteration: item.parentIteration,
  };
}

/** Paging controls every run list shares. */
export interface RunPageOptions {
  limit?: number;
  cursor?: string;
}

/** One workflow's runs, newest first. Null when the workflow isn't owned. */
export async function listWorkflowRuns(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  workflowId: string,
  page: RunPageOptions = {},
): Promise<ListWorkflowRunsResponse | null> {
  const row = await ownedDefinitionRow(deps.db, owner, workflowId);
  if (!row) return null;

  const result = await deps.workflowStore.listRuns({
    workflowIds: [workflowId],
    limit: clampRunLimit(page.limit),
    cursor: page.cursor,
  });
  return { runs: result.runs.map(toRunSummary), nextCursor: result.nextCursor };
}

/** Filters the cross-workflow run list accepts, on top of `RunPageOptions`. */
export interface OwnerRunsFilter extends RunPageOptions {
  /** Narrows to these workflows. Omit for every workflow the caller may read. */
  workflowIds?: string[];
  status?: ListRunsFilter["status"];
  outcome?: ListRunsFilter["outcome"];
  /** Children of one run — this is how a batch parent's items come back in one query. */
  parentRunId?: string;
  since?: number;
}

/**
 * Runs across every workflow the caller may read, newest first. Null when
 * the caller named a workflow id they cannot read — the route answers 404,
 * so an unreadable workflow and a missing one stay indistinguishable.
 *
 * Runs of a deleted definition are unreachable here, as they were through
 * the per-workflow list: they stay reachable by run id.
 */
export async function listRunsForOwner(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  filter: OwnerRunsFilter = {},
): Promise<ListWorkflowRunsResponse | null> {
  const readable = await ownedWorkflowIds(deps.db, owner);
  let workflowIds = readable;
  if (filter.workflowIds !== undefined) {
    const readableSet = new Set(readable);
    if (filter.workflowIds.some((id) => !readableSet.has(id))) return null;
    workflowIds = filter.workflowIds;
  }
  if (workflowIds.length === 0) return { runs: [] };

  const result = await deps.workflowStore.listRuns({
    workflowIds,
    status: filter.status,
    outcome: filter.outcome,
    parentRunId: filter.parentRunId,
    since: filter.since,
    limit: clampRunLimit(filter.limit),
    cursor: filter.cursor,
  });
  return { runs: result.runs.map(toRunSummary), nextCursor: result.nextCursor };
}

/**
 * Projects one checkpoint for the wire. The interpreter records a session
 * node's `sessionId` and a workflow node's `childRunId` in the checkpoint's
 * `effects` bag (`nodes/submission-node.ts`, `nodes/workflow-call.ts`);
 * both are what turns a run page into a link to the work the node started.
 * The rest of `effects` (receipts, repair state) is interpreter bookkeeping
 * and stays off the wire.
 */
export function toRunCheckpoint(cp: NodeCheckpoint): WorkflowRunCheckpoint {
  const effects = cp.effects;
  return {
    nodeId: cp.nodeId,
    iteration: cp.iteration,
    status: cp.status,
    result: cp.result,
    error: cp.error,
    createdAt: cp.createdAt,
    sessionId: typeof effects?.sessionId === "string" ? effects.sessionId : undefined,
    childRunId: typeof effects?.childRunId === "string" ? effects.childRunId : undefined,
  };
}

/** Owner-gated run lookup shared by cancel/approval below. */
async function ownedRun(deps: WorkflowServiceDeps, owner: WorkflowOwner, runId: string) {
  const run = await deps.workflowStore.getRun(runId);
  if (!run || !run.owner || !(await isAuthorizedForOwner(deps.db, owner, run.owner))) {
    return null;
  }
  return run;
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
  return "ok";
}

/** Resolves an approval gate: inserts the approval signal and wakes the
 * run. The caller decides WHO may resolve (the HTTP route lets the session
 * user; the agent tool rides a high-risk decision gate). */
export async function resolveWorkflowApproval(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  input: { runId: string; nodeId: string; approved: boolean; note?: string },
): Promise<"ok" | "not_found"> {
  const run = await ownedRun(deps, owner, input.runId);
  if (!run) return "not_found";
  await deps.workflowStore.insertSignal({
    runId: input.runId,
    signalId: `approval:${input.nodeId}:resolution`,
    signalType: `approval:${input.nodeId}`,
    payload: { approved: input.approved, resolvedBy: owner.userId, note: input.note },
    createdAt: Date.now(),
  });
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
    checkpoints: checkpoints.map(toRunCheckpoint),
    signals: signals.map((s) => ({
      signalId: s.signalId,
      signalType: s.signalType,
      payload: s.payload,
      createdAt: s.createdAt,
    })),
  };
}
