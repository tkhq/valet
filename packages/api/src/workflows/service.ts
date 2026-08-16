/**
 * Owner-scoped workflow definition/run operations, shared by the HTTP
 * routes (`routes/workflows.ts`) and the agent-facing action plugin
 * (`workflows/actions.ts`). Cross-owner access returns null (routes map
 * that to 404) so an owned row and a missing row stay indistinguishable.
 */
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  resolveTriggerInput,
  triggerDataSchema,
  validateWorkflowDefinition,
  type RunParams,
  type TriggerInputError,
  type ValidateEnvironment,
  type WorkflowDefinition,
  type WorkflowStore,
  type WorkflowTriggerPayload,
} from "@valet/workflow";
import type { RunHost } from "@valet/workflow";
import type { ActionPlugin, ValetPlugin } from "@valet/engine";
import { NotFoundError } from "@valet/shared";
import type { AppDb } from "../lib/drizzle.js";
import {
  actionInvocations,
  workflowDefinitions,
  workflowRuns,
  workflowSchedules,
  workflowVersions,
  workflowWebhooks,
} from "../schema/index.js";
import { definitionVersionId } from "./definition-version.js";
import { isTeamMember, listTeamsForUser, lockTeamForOwnership } from "../services/teams.js";
import { isOrgAdmin, isOrgMember } from "../services/org.js";
import {
  writeExecutionGrant,
  writeAlwaysAllowPolicy,
  AlwaysAllowNotAdminError,
  updateInvocationOutcome,
} from "../policies/service.js";
import type {
  GetWorkflowRunResponse,
  WorkflowDefinitionSummary,
  WorkflowPendingGate,
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

/** The owner types `workflow_definitions.owner_type` holds. Read off the
 * column so the two can never drift. */
export type WorkflowOwnerType = (typeof workflowDefinitions.$inferSelect)["ownerType"];

/** One owner, in the `{owner_type, owner_id}` shape every workflow row
 * carries. `listWorkflowDefinitions` takes one to narrow its result to a
 * single owner. */
export interface WorkflowOwnerRef {
  ownerType: WorkflowOwnerType;
  ownerId: string;
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
 * time), so both need the identical direct-or-team-member check.
 *
 * Exported for the list route's `?ownerType=&ownerId=` filter, which asks
 * this same question about an owner named in a query string before it
 * narrows to it. Sharing the check is what keeps "which workflows may I
 * list" and "which workflow may I open" from drifting apart. An org owner
 * is false here: no rule admits anybody to an org-owned workflow yet, so
 * one is neither listable nor openable. */
export async function isAuthorizedForOwner(
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

/**
 * The caller's own workflows unioned with every team they belong to.
 * `scope` narrows that to one owner — a workspace picker asking for one
 * team's workflows. It carries no authorization: the caller has already
 * checked the user may reach that owner (`isAuthorizedForOwner`), because
 * an id that arrives in a query string is a request, not a permission.
 */
export async function listWorkflowDefinitions(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  scope?: WorkflowOwnerRef,
): Promise<WorkflowDefinitionSummary[]> {
  // A scoped list reads one owner, so it never needs the team roster.
  const myTeams = scope ? [] : await listTeamsForUser(deps.db, owner.userId);
  const teamIds = myTeams.map((t) => t.id);
  const ownerMatch = and(eq(workflowDefinitions.ownerType, "user"), eq(workflowDefinitions.ownerId, owner.userId));
  const teamMatch =
    teamIds.length > 0
      ? and(eq(workflowDefinitions.ownerType, "team"), inArray(workflowDefinitions.ownerId, teamIds))
      : undefined;
  const where = scope
    ? and(eq(workflowDefinitions.ownerType, scope.ownerType), eq(workflowDefinitions.ownerId, scope.ownerId))
    : teamMatch
      ? or(ownerMatch, teamMatch)
      : ownerMatch;
  const rows = await deps.db
    .select()
    .from(workflowDefinitions)
    .where(where)
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
  // Same reasoning as webhooks: workflow_schedules.workflow_id is a plain
  // text column with no cascade, and the scheduler sweeps ALL enabled rows
  // regardless of owner reachability — an orphan keeps firing forever
  // against a workflow that no longer exists.
  await deps.db.delete(workflowSchedules).where(eq(workflowSchedules.workflowId, id));
  return "deleted";
}

/** Returns null when the workflow doesn't exist (or isn't owned); an
 * `invalidInput` result when the caller's input fails the trigger's
 * declared dataSchema (routes map that to 400). */
export async function startWorkflowRun(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  workflowId: string,
  input?: Record<string, unknown>,
): Promise<{ runId: string } | { invalidInput: TriggerInputError[] } | null> {
  const row = await ownedDefinitionRow(deps.db, owner, workflowId);
  if (!row) return null;

  const definition = row.definition;
  const versionId = definitionVersionId(definition);
  const runId = newWorkflowId("wfrun");

  const resolved = resolveTriggerInput(triggerDataSchema(definition), input ?? {});
  if (resolved.errors.length > 0) return { invalidInput: resolved.errors };

  const trigger: WorkflowTriggerPayload = {
    type: "manual",
    timestamp: new Date().toISOString(),
    data: resolved.input,
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
    const needsApproval =
      run.status === "parked" &&
      run.waitingOn.some(
        (w) => w.kind === "signal" && w.signalType.startsWith("approval:"),
      );
    runs.push({
      runId: run.runId,
      workflowId: run.params.workflowId,
      status: run.status,
      outcome: run.outcome,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      needsApproval: needsApproval || undefined,
      // Parked only: name the blocking conditions in the list itself, so a
      // surprising park (e.g. a policy gate on a tool node) is visible
      // without a per-run detail fetch.
      waitingOn:
        run.status === "parked" && run.waitingOn.length > 0
          ? run.waitingOn.map((w) => ({
              kind: w.kind,
              nodeId: w.nodeId,
              ...(w.kind === "signal" ? { signalType: w.signalType } : {}),
              ...(w.kind === "timer" ? { wakeAt: w.wakeAt } : {}),
            }))
          : undefined,
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

/** Scan `definition` (unknown at runtime) for the node with `nodeId`. Searches
 * `definition.nodes` directly and, for each `type === "foreach"` node, also checks
 * `node.body.id`. Nested foreach is not a legal definition shape today. */
export function findNodeInDefinition(definition: unknown, nodeId: string): Record<string, unknown> | undefined {
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

export type RetryWorkflowRunResult =
  | { runId: string }
  | { invalidInput: TriggerInputError[] }
  | "not_found"
  | "not_retryable"
  | "workflow_deleted";

/**
 * Starts a fresh run of the same workflow, reusing the failed run's trigger
 * input. Only settled runs with outcome `failed` or `cancelled` are
 * retryable. The new run snapshots the CURRENT definition, not the old run's
 * snapshot — the usual retry motive is "I fixed the workflow; run it again".
 * `invalidInput` surfaces when the current definition's trigger schema no
 * longer accepts the original input. `not_found` covers unknown AND un-owned
 * run ids.
 */
export async function retryWorkflowRun(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  runId: string,
): Promise<RetryWorkflowRunResult> {
  const run = await ownedRun(deps, owner, runId);
  if (!run) return "not_found";
  if (run.status !== "settled" || run.outcome === "completed") return "not_retryable";

  const started = await startWorkflowRun(
    deps,
    owner,
    run.params.workflowId,
    triggerData(run.params.input),
  );
  if (!started) return "workflow_deleted";
  return started;
}

/**
 * Extracts the `data` field from a stored trigger payload (`unknown` at
 * rest). Every trigger path (manual start, webhook, schedule) writes a
 * `WorkflowTriggerPayload` whose `data` is an object, so a missing or
 * non-object `data` can only come from a run predating that shape — the
 * retry then starts with no input rather than failing.
 */
function triggerData(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const data = (input as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  return data as Record<string, unknown>;
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

  const orgId = await definitionOrgId(deps.db, run.params.workflowId);
  if (orgId === null || !(await isOrgMember(deps.db, orgId, owner.userId))) return "org_mismatch";

  const node = findNodeInDefinition(run.definition, input.nodeId);
  const isPolicyGate = node?.type === "tool";
  if (isPolicyGate && input.via === "agent") return "human_only";

  // Auth check for "always" scope must happen BEFORE the signal insert so a
  // forbidden_always response never writes anything (no signal, no grant).
  if (input.approved && input.scope === "always" && isPolicyGate) {
    const adminOk = await isOrgAdmin(deps.db, orgId, owner.userId);
    if (!adminOk) return "forbidden_always";
  }

  // insertSignal is first-write-wins (ON CONFLICT DO NOTHING). Insert the signal
  // first so two concurrent resolutions can only race here — the loser gets the
  // existing row back with a different payload and returns "already_resolved"
  // without writing any grants or audit rows. Grant/policy writes happen only
  // after the insert confirms this caller won the race. wake() is called after
  // all writes; the executor does not consume the signal until its next drive,
  // so the ordering is safe.
  const submitted = {
    approved: input.approved,
    resolvedBy: owner.userId,
    scope: input.scope,
  };
  const signalId = `approval:${input.nodeId}${suffix}:resolution`;
  const stored = await deps.workflowStore.insertSignal({
    runId: input.runId,
    signalId,
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
  // Compare the returned row's payload to what we submitted. If another caller
  // won the race the stored payload will differ — do not stamp audit for the loser.
  const storedPayload = stored.payload as { approved?: boolean; resolvedBy?: string; scope?: string } | undefined;
  if (
    storedPayload?.resolvedBy !== submitted.resolvedBy ||
    storedPayload?.approved !== submitted.approved ||
    storedPayload?.scope !== submitted.scope
  ) {
    return "already_resolved";
  }

  if (input.approved && isPolicyGate) {
    const n = node as Record<string, unknown>;
    const service = typeof n.service === "string" ? n.service : "";
    const action = typeof n.action === "string" ? n.action : "";
    const actionId = action.includes(".") ? action : `${service}.${action}`;
    const now = Date.now();
    if (input.scope === "always") {
      // Admin eligibility was already checked above (before the signal insert).
      // AlwaysAllowNotAdminError should not fire here, but re-throw defensively
      // for unexpected cases.
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

  // Build pendingGates from run.waitingOn entries that are approval signals.
  const pendingGates: WorkflowPendingGate[] = [];
  for (const w of run.waitingOn) {
    if (w.kind !== "signal" || !w.signalType.startsWith("approval:")) continue;

    // signalType format: `approval:{nodeId}` (top-level) or `approval:{nodeId}:{iteration}`.
    const afterPrefix = w.signalType.slice("approval:".length);
    // Find the last colon that is followed only by digits — that is the iteration suffix.
    const iterSuffixMatch = afterPrefix.match(/^(.*):(\d+)$/);
    let nodeId: string;
    let iteration: number | undefined;
    if (iterSuffixMatch) {
      nodeId = iterSuffixMatch[1];
      iteration = parseInt(iterSuffixMatch[2], 10);
    } else {
      nodeId = afterPrefix;
      iteration = undefined;
    }

    const node = findNodeInDefinition(run.definition, nodeId);
    const isToolNode = node?.type === "tool";

    if (isToolNode && node) {
      // Find the matching intent checkpoint for gate effects.
      const iter = iteration ?? 0;
      const intentCp = checkpoints.find(
        (cp) => cp.nodeId === nodeId && cp.iteration === iter && cp.status === "intent",
      );
      const effects = intentCp?.effects;

      const gate: WorkflowPendingGate = {
        nodeId,
        kind: "policy_gate",
      };
      if (iteration !== undefined) gate.iteration = iteration;
      if (typeof node.service === "string") gate.service = node.service;
      if (typeof node.action === "string") gate.action = node.action;
      if (node.onDeny === "fail" || node.onDeny === "skip") gate.onDeny = node.onDeny;
      if (typeof w.timeoutAt === "number") gate.timeoutAt = w.timeoutAt;

      // Pull gate effects from the intent checkpoint (typeof-narrowed, no casts).
      if (effects !== undefined && typeof effects === "object" && effects !== null) {
        if ("riskLevel" in effects && typeof effects.riskLevel === "string") {
          gate.riskLevel = effects.riskLevel;
        }
        if ("provenance" in effects && typeof effects.provenance === "string") {
          gate.provenance = effects.provenance;
        }
        if ("gateParams" in effects) {
          gate.gateParams = effects.gateParams;
        }
        if ("gateParamsTruncated" in effects && typeof effects.gateParamsTruncated === "boolean") {
          gate.gateParamsTruncated = effects.gateParamsTruncated;
        }
        if ("gateItem" in effects) {
          gate.gateItem = effects.gateItem;
        }
        if ("timeoutAt" in effects && typeof effects.timeoutAt === "number") {
          gate.timeoutAt = effects.timeoutAt;
        }
      }

      pendingGates.push(gate);
    } else {
      // Approval node (non-tool).
      const gate: WorkflowPendingGate = {
        nodeId,
        kind: "approval",
      };
      if (iteration !== undefined) gate.iteration = iteration;
      if (node && typeof node.prompt === "string") gate.prompt = node.prompt;
      if (typeof w.timeoutAt === "number") gate.timeoutAt = w.timeoutAt;
      pendingGates.push(gate);
    }
  }

  const needsApproval = pendingGates.length > 0 || undefined;

  return {
    run: {
      runId: run.runId,
      workflowId: run.params.workflowId,
      status: run.status,
      outcome: run.outcome,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      needsApproval,
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
    pendingGates,
  };
}
