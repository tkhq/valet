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
  type ListRunsFilter,
  type NodeCheckpoint,
  type RunParams,
  type TriggerInputError,
  type ValidateEnvironment,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowRunListItem,
  type WorkflowStore,
  type WorkflowTriggerPayload,
} from "@valet/workflow";
import type { RunHost } from "@valet/workflow";
import type { ActionPlugin, ValetPlugin } from "@valet/engine";
import { NotFoundError } from "@valet/shared";
import type { AppDb } from "../lib/drizzle.js";
import {
  actionInvocations,
  eventSubscriptions,
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
  GlobalWorkflowRunSummary,
  ListAllWorkflowRunsResponse,
  ListWorkflowRunsResponse,
  WorkflowDefinitionSummary,
  WorkflowPendingGate,
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

const WORKFLOW_OWNER_TYPES: ReadonlySet<string> = new Set(["user", "team", "org"]);

export function isWorkflowOwnerType(value: string): value is WorkflowOwnerType {
  return WORKFLOW_OWNER_TYPES.has(value);
}

/**
 * The `?ownerType=&ownerId=` list filter, or `{}` when absent. Returns an
 * error string when one half is present and the other is not — the same shape
 * `GET /api/assistants` and `GET /api/sessions` take, so one client builds one
 * query for all of them. Shared by the workflow definitions, runs, and
 * triggers routes so every workflow list scopes the same way.
 */
export function parseWorkflowOwnerFilter(
  ownerType: string | undefined,
  ownerId: string | undefined,
): { scope?: WorkflowOwnerRef; error?: string } {
  if (ownerType === undefined && ownerId === undefined) return {};
  if (ownerType === undefined || ownerId === undefined) {
    return { error: "Filter by owner with both ownerType and ownerId, or send neither." };
  }
  if (!isWorkflowOwnerType(ownerType)) {
    return { error: "ownerType must be 'user', 'team' or 'org'." };
  }
  return { scope: { ownerType, ownerId } };
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

/**
 * The sync core of `isAuthorizedForOwner`, against a pre-fetched team-id
 * set instead of a live per-team query. `canAccessTriggerRow` and
 * `ownedDefinitionFilterWith` build on it, so the owner arms exist in
 * exactly one place. Callers get the set from `callerTeamIds`, re-read per
 * request for the same leave-a-team reason `isAuthorizedForOwner` states.
 */
export function isAuthorizedForOwnerWith(
  teamIds: Set<string>,
  owner: WorkflowOwner,
  target: { ownerType: string; ownerId: string },
): boolean {
  if (target.ownerType === "user") return target.ownerId === owner.userId;
  if (target.ownerType === "team") return teamIds.has(target.ownerId);
  return false;
}

/** Ids of every team the caller is a live member of — the one membership
 * read behind `ownedDefinitionFilter` and `triggerAccessSets`. */
async function callerTeamIds(db: AppDb, userId: string): Promise<Set<string>> {
  const myTeams = await listTeamsForUser(db, userId);
  return new Set(myTeams.map((t) => t.id));
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
  return ownedDefinitionFilterWith(await callerTeamIds(db, owner.userId), owner);
}

/** SQL form of `isAuthorizedForOwnerWith` over `workflow_definitions` —
 * the same owner arms, pushed into the WHERE clause. Takes the team set so
 * `triggerAccessSets` can reuse one membership read across both queries. */
function ownedDefinitionFilterWith(teamIds: Set<string>, owner: WorkflowOwner) {
  const ownerMatch = and(eq(workflowDefinitions.ownerType, "user"), eq(workflowDefinitions.ownerId, owner.userId));
  const teamMatch =
    teamIds.size > 0
      ? and(eq(workflowDefinitions.ownerType, "team"), inArray(workflowDefinitions.ownerId, [...teamIds]))
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

/** The two sets `canAccessTriggerRow` checks against, loaded once per
 * request so a list filter does not re-query per row. */
export interface TriggerAccessSets {
  teamIds: Set<string>;
  workflowIds: Set<string>;
}

export async function triggerAccessSets(db: AppDb, owner: WorkflowOwner): Promise<TriggerAccessSets> {
  const teamIds = await callerTeamIds(db, owner.userId);
  const rows = await db
    .select({ id: workflowDefinitions.id })
    .from(workflowDefinitions)
    .where(ownedDefinitionFilterWith(teamIds, owner));
  return { teamIds, workflowIds: new Set(rows.map((r) => r.id)) };
}

/**
 * The one access rule for schedule and event-trigger rows (the Triggers
 * surface): the caller may see and change a row when they own it, are a
 * member of the owning team, or may reach its target workflow.
 *
 * The workflow-reach arm is not redundant with the owner arms. Event
 * triggers written before they followed their workflow carry the CREATOR as
 * row owner on a team workflow, and rows that pre-date the team owner column
 * were widened to the org — for both, the target workflow is the accurate
 * authority. The
 * owner arms are `isAuthorizedForOwnerWith` — the same core rule the
 * workflow surfaces use, in set form so list filtering stays O(rows).
 *
 * Checking `orgId` alone here was TKAI-227: every org member could read,
 * edit, delete, and fire everyone's personal triggers — including the
 * prompt text of personal orchestrator schedules.
 */
export function canAccessTriggerRow(
  owner: WorkflowOwner,
  sets: TriggerAccessSets,
  row: { ownerType: string; ownerId: string; workflowId?: string | null },
): boolean {
  if (isAuthorizedForOwnerWith(sets.teamIds, owner, row)) return true;
  return row.workflowId != null && sets.workflowIds.has(row.workflowId);
}

/** The same read as `ownedWorkflowIds`, with the display name each id needs
 * when the rows leave their own workflow's page. `scope` narrows to one owner
 * — the hub's Runs tab under the switcher — the same way `listWorkflowDefinitions`
 * does; it carries no authorization (the caller was already checked for the
 * scope), so an unscoped call still returns the caller's full reach. */
async function ownedWorkflowNames(
  db: AppDb,
  owner: WorkflowOwner,
  scope?: WorkflowOwnerRef,
): Promise<Map<string, string>> {
  const where = scope
    ? and(eq(workflowDefinitions.ownerType, scope.ownerType), eq(workflowDefinitions.ownerId, scope.ownerId))
    : await ownedDefinitionFilter(db, owner);
  const rows = await db
    .select({ id: workflowDefinitions.id, name: workflowDefinitions.name })
    .from(workflowDefinitions)
    .where(where);
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * Trigger-row access for ONE workspace scope — the Triggers hub under the
 * switcher. A row belongs to the scope when the scope owns it, or when it
 * targets a workflow the scope owns (the same workflow-reach arm
 * `canAccessTriggerRow` keeps for legacy rows whose owner column pre-dates the
 * team/workflow binding). `workflowIds` are the scope's workflows, loaded once
 * per request. The caller has already been authorized for the scope.
 */
export interface ScopedTriggerAccess {
  scope: WorkflowOwnerRef;
  workflowIds: Set<string>;
}

export async function scopedTriggerAccess(
  db: AppDb,
  scope: WorkflowOwnerRef,
): Promise<ScopedTriggerAccess> {
  const rows = await db
    .select({ id: workflowDefinitions.id })
    .from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.ownerType, scope.ownerType), eq(workflowDefinitions.ownerId, scope.ownerId)));
  return { scope, workflowIds: new Set(rows.map((r) => r.id)) };
}

/**
 * The deliberate difference from `canAccessTriggerRow`: a caller's OWN
 * personal row does NOT match a team scope. The hub shows one workspace, not
 * the caller's union across workspaces, so the owner arm compares the row to
 * the SCOPE, not to the caller.
 */
export function canAccessTriggerRowInScope(
  access: ScopedTriggerAccess,
  row: { ownerType: string; ownerId: string; workflowId?: string | null },
): boolean {
  if (row.ownerType === access.scope.ownerType && row.ownerId === access.scope.ownerId) return true;
  return row.workflowId != null && access.workflowIds.has(row.workflowId);
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
  const where = scope
    ? and(eq(workflowDefinitions.ownerType, scope.ownerType), eq(workflowDefinitions.ownerId, scope.ownerId))
    : await ownedDefinitionFilter(deps.db, owner);
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

// ─── Aggregation node ────────────────────────────────────────────────────────
//
// A fan-out graph ends in several branch tips, and the reader almost always
// wants one result. Writing that join node by hand is where the template
// path contract bites hardest: an `llm` branch exposes its text at
// `result.text`, a `session` branch at `result.response`, and a branch with
// an `outputSchema` puts its fields under `result.output`. A path written
// against the wrong family resolves to nothing, and the run then SUCCEEDS
// with a hole where the branch output should be.
//
// This inserts the join node instead of asking a person to type it. Two
// properties are deliberate:
//
//   1. It is an ORDINARY node in `definition.nodes` — a `set` or an `llm` —
//      appended with one edge per branch. It appears on the canvas, it can
//      be renamed, re-prompted, rewired, or deleted like any other node,
//      and its behaviour is fully described by the saved definition. It is
//      NOT a flag that makes the interpreter build a hidden node at run
//      time: a hidden node cannot be seen in the editor, cannot be edited,
//      and would make the graph a person reads differ from the graph that
//      ran.
//   2. It never rewires the existing graph. Edges are only added, never
//      moved or removed, so this can never silently change what the
//      workflow already did.

/** How the aggregate node combines its branches. */
export type AggregateMode = "collect" | "summarize";

export interface AggregateNodeInput {
  /** Id for the new node. A taken id gets a numeric suffix. Default `aggregate`. */
  nodeId?: string;
  /** Branches to combine. Default: every node with no outgoing edge. */
  sources?: string[];
  /** `collect` (default) writes a `set` node; `summarize` writes an `llm` node. */
  mode?: AggregateMode;
  /** Required for `summarize`. */
  model?: string;
  /** Appended to the summarize prompt, in the author's own words. */
  instructions?: string;
}

export type AddAggregateNodeResult =
  | { ok: true; definition: WorkflowDefinitionSummary; nodeId: string; sources: string[] }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "stored_definition_invalid" | "would_be_invalid"; errors: string[] }
  | { ok: false; reason: "no_branches" | "unknown_sources" | "model_required"; message: string };

/**
 * The template path that reads what a node produced.
 *
 * Every shape here is the checkpoint `result` its executor writes:
 * `llm.ts` returns `{ text, output? }`, `session.ts` and `orchestrator.ts`
 * return `{ sessionId, response, output? }`, `workflow-call.ts` returns
 * `{ runId, output }`, and `foreach.ts` returns the `ForeachResult`
 * aggregate. A node with an `outputSchema` is read at its structured
 * `output`, because that is the field the author declared.
 */
export function aggregateSourcePath(node: WorkflowNode): string {
  const base = `nodes.${node.id}.result`;
  switch (node.type) {
    case "llm":
      return node.outputSchema !== undefined ? `${base}.output` : `${base}.text`;
    case "session":
    case "orchestrator":
      return node.outputSchema !== undefined ? `${base}.output` : `${base}.response`;
    case "workflow":
      return `${base}.output`;
    case "foreach":
      return `${base}.items`;
    default:
      // `tool` returns the action's own response, `set` returns its rendered
      // values, and neither has a documented sub-field to prefer.
      return base;
  }
}

/** Every node id the definition uses, foreach body ids included — a new id must miss all of them. */
function usedNodeIds(definition: WorkflowDefinition): Set<string> {
  const ids = new Set<string>();
  for (const node of definition.nodes) {
    ids.add(node.id);
    if (node.type === "foreach") ids.add(node.body.id);
  }
  return ids;
}

function uniqueNodeId(definition: WorkflowDefinition, preferred: string): string {
  const taken = usedNodeIds(definition);
  if (!taken.has(preferred)) return preferred;
  for (let n = 2; ; n++) {
    const candidate = `${preferred}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Branch tips: nodes with no outgoing edge, minus the node types that
 * cannot be a branch result. A `trigger` with no outgoing edge is a broken
 * graph, not a branch, and a `stop` node ends the run rather than producing
 * a value for somebody else to read.
 */
function branchTips(definition: WorkflowDefinition): WorkflowNode[] {
  const hasOutgoing = new Set(definition.edges.map((e) => e.from));
  return definition.nodes.filter(
    (n) => !hasOutgoing.has(n.id) && n.type !== "stop" && n.type !== "trigger",
  );
}

/** The `set` node body: one field per branch, named after the branch. */
function collectValues(sources: WorkflowNode[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const source of sources) values[source.id] = `{{ ${aggregateSourcePath(source)} }}`;
  return values;
}

/** The `llm` node prompt: each branch under its own heading, so the model can tell them apart. */
function summarizePrompt(sources: WorkflowNode[], instructions?: string): string {
  const lines: string[] = [];
  for (const source of sources) {
    lines.push(`## ${source.id}`, `{{ ${aggregateSourcePath(source)} }}`, "");
  }
  lines.push(
    instructions && instructions.trim().length > 0
      ? instructions.trim()
      : "Write one combined summary. Keep every point that appears in only one section. Say where two sections disagree. Add nothing they did not say.",
  );
  return lines.join("\n");
}

/** Places the new node to the right of its branches, vertically centred on them. */
function placeAggregate(
  definition: WorkflowDefinition,
  nodeId: string,
  sources: WorkflowNode[],
): WorkflowDefinition["ui"] {
  const ui = definition.ui;
  if (!ui) return undefined;
  const points = sources.map((s) => ui.nodes[s.id]?.position).filter((p): p is { x: number; y: number } => !!p);
  if (points.length === 0) return ui;
  const x = Math.max(...points.map((p) => p.x)) + 260;
  const y = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  return { ...ui, nodes: { ...ui.nodes, [nodeId]: { position: { x, y } } } };
}

/**
 * Appends an aggregation node that reads every branch, and saves the result
 * as a new version. `env` is the same validator environment the save routes
 * use, so a definition that would not pass a normal save is not written by
 * this path either.
 */
export async function addAggregateNode(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  workflowId: string,
  input: AggregateNodeInput = {},
  env?: ValidateEnvironment,
): Promise<AddAggregateNodeResult> {
  const row = await ownedDefinitionRow(deps.db, owner, workflowId);
  if (!row) return { ok: false, reason: "not_found" };

  const parsed = validateDefinitionInput(row.definition, env);
  if (!parsed.ok) return { ok: false, reason: "stored_definition_invalid", errors: parsed.errors };
  const definition = parsed.definition;

  const mode: AggregateMode = input.mode ?? "collect";
  if (mode === "summarize" && (input.model === undefined || input.model.length === 0)) {
    return {
      ok: false,
      reason: "model_required",
      message: 'mode "summarize" writes an llm node. Name the model to use, or use mode "collect".',
    };
  }

  const byId = new Map(definition.nodes.map((n) => [n.id, n]));
  let sources: WorkflowNode[];
  if (input.sources !== undefined) {
    const unknown = input.sources.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      return {
        ok: false,
        reason: "unknown_sources",
        message: `no node in this workflow has the id ${unknown.join(", ")}. Name ids from the workflow's own nodes.`,
      };
    }
    sources = input.sources.map((id) => {
      const node = byId.get(id);
      if (!node) throw new Error(`node ${id} vanished between the check and the read`);
      return node;
    });
  } else {
    sources = branchTips(definition);
  }

  if (sources.length < 2) {
    return {
      ok: false,
      reason: "no_branches",
      message:
        "an aggregation node needs at least two branches to combine. Add the parallel branches first, or name the source nodes explicitly.",
    };
  }

  const nodeId = uniqueNodeId(definition, input.nodeId ?? "aggregate");
  const aggregateNode: WorkflowNode =
    mode === "summarize"
      ? {
          id: nodeId,
          type: "llm",
          // Checked above; the narrowing is for the type, not the value.
          model: input.model ?? "",
          system: "You merge several separate analyses into one. Use only what they say.",
          prompt: summarizePrompt(sources, input.instructions),
        }
      : { id: nodeId, type: "set", values: collectValues(sources) };

  const edges: WorkflowEdge[] = sources.map((source) => ({ from: source.id, to: nodeId }));
  const next: WorkflowDefinition = {
    ...definition,
    nodes: [...definition.nodes, aggregateNode],
    edges: [...definition.edges, ...edges],
    ui: placeAggregate(definition, nodeId, sources),
  };

  const checked = validateDefinitionInput(next, env);
  if (!checked.ok) return { ok: false, reason: "would_be_invalid", errors: checked.errors };

  const saved = await updateWorkflowDefinition(deps, owner, workflowId, { definition: next });
  if (!saved) return { ok: false, reason: "not_found" };
  return { ok: true, definition: saved, nodeId, sources: sources.map((s) => s.id) };
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

  // Triggers must not outlive the workflow: orphaned schedules would be
  // disabled by the scheduler eventually, but the triggers list would show
  // ghosts until then. Event subscriptions targeting the workflow are
  // app-db rows with no FK, so remove them explicitly.
  await deps.db.delete(workflowSchedules).where(eq(workflowSchedules.workflowId, id));
  const subs = await deps.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.orgId, owner.orgId));
  for (const sub of subs) {
    // `target` is a free-form jsonb column; guard the shape before reading
    // so a malformed row cannot abort the cleanup loop mid-delete.
    if (typeof sub.target !== "object" || sub.target === null) continue;
    const target = sub.target as { kind?: string; workflowId?: string };
    if (target.kind === "workflow" && target.workflowId === id) {
      await deps.db.delete(eventSubscriptions).where(eq(eventSubscriptions.id, sub.id));
    }
  }

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
  const parked = item.status === "parked";
  return {
    runId: item.runId,
    workflowId: item.workflowId,
    status: item.status,
    outcome: item.outcome,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    needsApproval:
      (parked &&
        item.waitingOn.some((w) => w.kind === "signal" && w.signalType.startsWith("approval:"))) ||
      undefined,
    // Parked only: name the blocking conditions in the list itself, so a
    // surprising park (e.g. a policy gate on a tool node) is visible
    // without a per-run detail fetch. The list query carries `waiting_on`
    // for exactly this — reading it here costs no extra round trip.
    waitingOn:
      parked && item.waitingOn.length > 0
        ? item.waitingOn.map((w) => ({
            kind: w.kind,
            nodeId: w.nodeId,
            ...(w.kind === "signal" ? { signalType: w.signalType } : {}),
            ...(w.kind === "timer" ? { wakeAt: w.wakeAt } : {}),
          }))
        : undefined,
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
  /**
   * One workspace, for the hub's Runs tab under the switcher. Narrows the
   * readable set to workflows THIS owner owns, instead of every workflow the
   * caller may reach. Carries no authorization: the route has already checked
   * the caller may reach `scope` (`isAuthorizedForOwner`), the same contract
   * `listWorkflowDefinitions`'s `scope` takes.
   */
  scope?: WorkflowOwnerRef;
}

/**
 * Runs across every workflow the caller may read, newest first. Null when
 * the caller named a workflow id they cannot read — the route answers 404,
 * so an unreadable workflow and a missing one stay indistinguishable.
 *
 * Each row carries `workflowName`. A cross-workflow list has no per-workflow
 * heading, so the name must travel with the run or the reader cannot tell
 * the rows apart. The names come from the same definition read the
 * authorization check already does, so this costs no extra query.
 *
 * Runs of a deleted definition are unreachable here, as they were through
 * the per-workflow list: they stay reachable by run id.
 */
export async function listRunsForOwner(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  filter: OwnerRunsFilter = {},
): Promise<ListAllWorkflowRunsResponse | null> {
  const nameById = await ownedWorkflowNames(deps.db, owner, filter.scope);
  const readable = [...nameById.keys()];
  let workflowIds = readable;
  if (filter.workflowIds !== undefined) {
    if (filter.workflowIds.some((id) => !nameById.has(id))) return null;
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
  const runs = result.runs.map((run) => {
    const summary = toRunSummary(run);
    // The id is the fallback label: a run whose definition was renamed
    // between the two reads is still identifiable, and never blank.
    return { ...summary, workflowName: nameById.get(summary.workflowId) ?? summary.workflowId };
  });
  return { runs, nextCursor: result.nextCursor };
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
    // A `session` or `orchestrator` node's dispatch receipt names the THREAD
    // it submitted to (`workflow/src/nodes/submission-node.ts` persists
    // `effects.receipt`). Without it here, "Open session" could only name
    // the session — and for the caller's own assistant that redirects to
    // /chat, which then lands on the NEWEST thread rather than the run's.
    threadId: threadIdOf(effects),
  };
}

/** `effects.receipt.threadId`, when the node recorded one. `effects` is
 * stored JSON, so every hop is checked rather than asserted. */
function threadIdOf(effects: NodeCheckpoint["effects"]): string | undefined {
  const receipt = effects?.receipt;
  if (typeof receipt !== "object" || receipt === null) return undefined;
  const threadId = (receipt as Record<string, unknown>).threadId;
  return typeof threadId === "string" ? threadId : undefined;
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
    // Guaranteed non-null by the authorization guard at the top. The web run
    // page adopts this into the workspace switcher. The store types
    // `ownerType` as a bare string; the persisted column only ever holds the
    // three owner kinds, so the cast restores the wire union.
    owner: {
      type: run.owner!.ownerType as "user" | "team" | "org",
      id: run.owner!.ownerId,
    },
    checkpoints: checkpoints.map(toRunCheckpoint),
    signals: signals.map((s) => ({
      signalId: s.signalId,
      signalType: s.signalType,
      payload: s.payload,
      createdAt: s.createdAt,
    })),
    pendingGates,
  };
}

