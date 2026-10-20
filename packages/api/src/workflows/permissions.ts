/** Permission preview and durable grants scoped to one workflow and its owner.
 * Explicit policy restrictions remain authoritative; human approval nodes are separate.
 */
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { AppQueryable } from "../lib/drizzle.js";
import { pendingWorkflowAccountConsent, saveWorkflowAccountConsent, revokeWorkflowAccountConsent } from "../services/workflow-account-consent.js";
import { credentials, teams, workflowActionGrants } from "../schema/index.js";
import { membersSharing } from "../services/credential-shares.js";
import { findCredentialDeclaration } from "../services/integration-availability.js";
import { canAdministerTeam } from "../services/teams.js";
import { resolvePolicyDecision, restrictivePolicyAnywhere, type PolicyResolutionInput, type PolicyResolutionRows } from "../policies/resolution.js";
import { loadPolicyRows } from "../policies/service.js";
import { parsePath } from "../policies/matchers.js";
import { isDeadConnection } from "../services/credential-resolution.js";
import { prepareActionArgs } from "@valet/engine";
import { findAction, qualifiedActionId } from "../plugins/action-invoker.js";
import { readToolScope } from "@valet/shared";
import { entryService, isAgentStep, isExactAction } from "./tool-scope.js";
import type {
  AllowWorkflowPermissionsResponse,
  GetWorkflowPermissionsResponse,
  WorkflowNodePermissionWire,
  WorkflowDefinitionSummary,
} from "../wire/types.js";
import { getWorkflowDefinition, revokeWorkflowGrants, type WorkflowOwner, type WorkflowServiceDeps } from "./service.js";

/** Permission operations need the app database and action catalog, not a running engine. */
export type WorkflowPermissionDeps = Pick<WorkflowServiceDeps, "db" | "actionPluginByService">;

/** A tool node's identity, narrowed from the stored definition JSON. The
 * definition was validated at save time, but tool-node rows can predate the
 * catalog or be inserted by imports, so this narrows instead of casting. */
interface ToolNodeRef {
  nodeId: string;
  service: string;
  action: string;
  params: Record<string, unknown> | undefined;
  /** An exact action an agent step declares. The agent supplies every parameter. */
  agentStep?: true;
}

function toolNodeRefs(definition: unknown): ToolNodeRef[] {
  if (typeof definition !== "object" || definition === null) return [];
  const nodes = (definition as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];
  const refs: ToolNodeRef[] = [];
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) continue;
    const n = node as Record<string, unknown>;
    if (typeof n.id !== "string") continue;
    if (n.type === "tool") {
      const ref = toToolRef(n.id, n);
      if (ref) refs.push(ref);
      continue;
    }
    // A foreach body can be a tool node, and the foreach executor dispatches
    // it through the same policy enforcement as a top-level tool node. The
    // ref carries the FOREACH node's id so the editor badge lands on the
    // card that is actually drawn. Body nesting depth is 1 by the dag/v1
    // types — a foreach cannot contain another foreach.
    if (n.type === "foreach" && typeof n.body === "object" && n.body !== null) {
      const body = n.body as Record<string, unknown>;
      if (body.type !== "tool") continue;
      const ref = toToolRef(n.id, body);
      if (ref) refs.push(ref);
    }
  }
  return refs;
}

/** Narrows one tool-node object to a ref, or null when service/action are
 * not both strings. `nodeId` is the DISPLAYED node's id — for a foreach
 * body that is the foreach node itself. */
function toToolRef(nodeId: string, n: Record<string, unknown>): ToolNodeRef | null {
  if (typeof n.service !== "string" || typeof n.action !== "string") return null;
  const params =
    typeof n.params === "object" && n.params !== null && !Array.isArray(n.params)
      ? (n.params as Record<string, unknown>)
      : undefined;
  return { nodeId, service: n.service, action: n.action, params };
}

/** The `toolScope.actions` entries of each agent step, top-level or a
 * foreach body. `nodeId` is the DISPLAYED node's id, as for tool bodies. */
function agentStepNodes(definition: unknown): { nodeId: string; entries: string[] }[] {
  if (typeof definition !== "object" || definition === null) return [];
  const nodes = (definition as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];
  const steps: { nodeId: string; entries: string[] }[] = [];
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) continue;
    const n = node as Record<string, unknown>;
    if (typeof n.id !== "string") continue;
    const step = n.type === "foreach" && typeof n.body === "object" && n.body !== null ? n.body as Record<string, unknown> : n;
    if (isAgentStep(step)) steps.push({ nodeId: n.id, entries: readToolScope(step.toolScope)?.actions ?? [] });
  }
  return steps;
}

/** The exact actions agent steps declare. A `service.*` entry gets no grant. */
function agentStepRefs(definition: unknown): ToolNodeRef[] {
  return agentStepNodes(definition).flatMap(({ nodeId, entries }) => entries.filter(isExactAction).map((entry) => ({
    nodeId, service: entryService(entry), action: entry.slice(entry.indexOf(".") + 1), params: undefined, agentStep: true as const,
  })));
}

/** Credential services referenced by tool steps, including dynamic tools, and by every agent-step entry. */
export function workflowCredentialServices(deps: WorkflowPermissionDeps, definition: unknown): string[] {
  const services = [...toolNodeRefs(definition).map((ref) => ref.service),
    ...agentStepNodes(definition).flatMap((step) => step.entries.map(entryService))];
  return [...new Set(services.map((service) =>
    deps.actionPluginByService?.get(service)?.actionPlugin.credentialService ?? service))].filter(service => service !== "github");
}

/** Identifies the reviewed definition, owner, and credential services. */
export function workflowPermissionDefinitionToken(orgId: string, summary: Pick<WorkflowDefinitionSummary, "id" | "ownerType" | "ownerId" | "definition">, credentialServices: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify({ orgId, workflowId: summary.id,
    ownerType: summary.ownerType, ownerId: summary.ownerId, definition: summary.definition, credentialServices: [...credentialServices].sort() })).digest("hex");
}

/** Predicts the policy resolution of every tool node for the stored owner.
 * Returns null when the workflow does not exist for this owner (the caller
 * 404s). Actions absent from the static plugin catalog (dynamic MCP
 * actions) report `mode: "unknown"` — no risk level exists to resolve with
 * until discovery runs, and discovery touches credentials, which a read
 * endpoint must not do. */
export async function analyzeWorkflowPermissions(
  deps: WorkflowPermissionDeps,
  owner: WorkflowOwner,
  workflowId: string,
): Promise<GetWorkflowPermissionsResponse | null> {
  const summary = await getWorkflowDefinition(deps, owner, workflowId);
  if (!summary) return null;
  const services = workflowCredentialServices(deps, summary.definition);
  const result: GetWorkflowPermissionsResponse = { definitionToken: workflowPermissionDefinitionToken(owner.orgId, summary, services),
    nodes: await analyzeDefinitionPermissions(deps, owner, summary) };
  if (summary.ownerType === "team") {
    const [team] = await deps.db.select({ name: teams.name }).from(teams)
      .where(and(eq(teams.id, summary.ownerId), eq(teams.orgId, owner.orgId))).limit(1);
    if (team) result.accountConsent = { teamId: summary.ownerId, teamName: team.name, services,
      pending: await pendingWorkflowAccountConsent(deps.db, { orgId: owner.orgId, workflowId: summary.id, teamId: summary.ownerId, userId: owner.userId, services }) };
  }
  return result;
}

/** The paths, as segments, of the parameters that are templates a run fills in. */
function templatedPaths(value: unknown, prefix: string[] = []): string[][] {
  if (typeof value === "string") return value.includes("{{") ? [prefix] : [];
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, entry]) => templatedPaths(entry, [...prefix, key]));
}

/** True when a policy or override for this action matches on a parameter
 * the step fills in at run time, so the run can resolve differently. */
function dependsOnTemplates(
  rows: PolicyResolutionRows,
  target: { service: string; actionId: string },
  paths: string[][],
): boolean {
  if (paths.length === 0) return false;
  // Matcher paths parse the way the matcher reads them (`to[0]` is `to.0`,
  // `""` is the whole object). A path the matcher cannot parse counts.
  const overlaps = (path: string) => {
    let matcher: string[];
    try {
      matcher = parsePath(path).map(String);
    } catch {
      return true;
    }
    return paths.some((t) => t.length <= matcher.length
      ? t.every((segment, i) => segment === matcher[i])
      : matcher.every((segment, i) => segment === t[i]));
  };
  return [...rows.policies, ...rows.overrides].some((row) =>
    (row.actionId === target.actionId || (row.actionId === null && (row.service === null || row.service === target.service)))
    && row.paramMatchers.some((matcher) => overlaps(matcher.path)));
}

export async function analyzeDefinitionPermissions(
  deps: WorkflowPermissionDeps,
  owner: WorkflowOwner,
  summary: WorkflowDefinitionSummary,
): Promise<WorkflowNodePermissionWire[]> {
  const refs = [...toolNodeRefs(summary.definition), ...agentStepRefs(summary.definition)];
  if (refs.length === 0) return [];

  const now = Date.now();
  // One row load for the whole definition: the scope has no per-node
  // component (no session/execution id — a run that has not started has no
  // grants), so a per-node `resolveActionPolicy` would re-read the same two
  // row sets N times. The pure core then decides per node from one
  // consistent snapshot.
  const rows = await loadPolicyRows(deps.db, {
    orgId: owner.orgId,
    workflowId: summary.id,
    userId: summary.ownerType === "user" ? summary.ownerId : owner.userId,
    teamId: summary.ownerType === "team" ? summary.ownerId : undefined,
  });
  // A team's own live connections, read as rows: the preview reads no secret
  // and refreshes no token. A dead connection does not count: the run skips
  // it for a member's share, as `readTeamCredential` does. Shares are read
  // per service the way the run reads them (`membersSharing`: current
  // members only).
  const teamId = summary.ownerType === "team" ? summary.ownerId : undefined;
  const teamOwn = teamId === undefined ? undefined : new Set((await deps.db
    .select({ service: credentials.service, type: credentials.type, expiresAt: credentials.expiresAt, metadata: credentials.metadata })
    .from(credentials)
    .where(and(eq(credentials.ownerType, "team"), eq(credentials.ownerId, teamId))))
    .filter((row) => !isDeadConnection(row, now)).map((row) => row.service));
  const sharedServices = new Map<string, boolean>();
  const nodes: WorkflowNodePermissionWire[] = [];
  for (const ref of refs) {
    const entry = deps.actionPluginByService?.get(ref.service);
    // The invoker uses a member's shared account only after the team's own
    // connection, an organization-provided one, and a team 1Password item,
    // never for GitHub, and asks that member. The preview reads no vault, so
    // the flag says the run may ask.
    const credentialService = entry?.actionPlugin.credentialService ?? ref.service;
    let sharedAccount = false;
    if (teamId !== undefined && teamOwn !== undefined && !teamOwn.has(credentialService) && credentialService !== "github"
      && !findCredentialDeclaration(entry ? [entry.plugin] : [], credentialService)?.requires?.orgCredential) {
      if (!sharedServices.has(credentialService)) {
        sharedServices.set(credentialService, (await membersSharing(deps.db, teamId, credentialService)).length > 0);
      }
      sharedAccount = sharedServices.get(credentialService) === true;
    }
    const action = entry ? findAction(entry.actionPlugin.actions, ref.service, ref.action) : undefined;
    const agentStep = ref.agentStep ? { agentStep: true as const } : {};
    if (!entry || !action) {
      // An agent step names a dynamic action exactly, so its id is known.
      const actionId = ref.agentStep ? `${ref.service}.${ref.action}` : null;
      nodes.push({ nodeId: ref.nodeId, service: ref.service, action: ref.action, actionId,
        mode: "unknown", ...agentStep, ...(sharedAccount ? { sharedAccount: true as const } : {}),
        ...(actionId !== null && dynamicActionGranted(rows, ref.service, actionId, now) ? { granted: true as const } : {}) });
      continue;
    }
    const actionId = qualifiedActionId(ref.service, action);
    // Preview what the run decides: schema defaults applied, as the invoker does.
    const prepared = ref.params === undefined ? undefined : prepareActionArgs(action.parameters, ref.params);
    // An agent step's call resolves as a session call with values the agent picks.
    const input: PolicyResolutionInput = ref.agentStep
      ? { service: ref.service, actionId, riskLevel: action.riskLevel, params: {}, appliesIn: "session", partialParams: true, agentStep: true, now }
      : { service: ref.service, actionId, riskLevel: action.riskLevel, params: prepared?.ok ? prepared.args : ref.params, appliesIn: "workflow", now };
    const decision = resolvePolicyDecision(rows, input, entry.actionPlugin.defaultApprovalMode);
    // The run refuses the grant under a rule scoped to workflows, so the review blocks it too.
    const restriction = ref.agentStep && decision.mode === "require_approval" ? restrictivePolicyAnywhere(rows, input) : undefined;
    const provenance = restriction ? (restriction.principalType === "team" ? "team_policy" : "org_policy") : decision.provenance.source;
    // The mode reads templates literally, as the workflow grant does; the
    // flag says when a rule keys on a value the run renders.
    const runtimeParams = dependsOnTemplates(rows, { service: ref.service, actionId }, templatedPaths(ref.params));
    nodes.push({
      nodeId: ref.nodeId,
      service: ref.service,
      action: ref.action,
      actionId,
      riskLevel: action.riskLevel,
      mode: decision.mode,
      provenance,
      ...(runtimeParams ? { runtimeParams: true as const } : {}),
      ...(sharedAccount ? { sharedAccount: true as const } : {}),
      ...agentStep,
    });
  }
  return nodes;
}

export type AllowWorkflowPermissionsOutcome =
  /** `definition` is the one the grants were read from, so a write can check
   * the steps have not changed since. */
  | { ok: true; result: AllowWorkflowPermissionsResponse; grants: (typeof workflowActionGrants.$inferInsert)[]; definition: unknown; definitionToken: string; credentialServices: string[] }
  | { ok: false; badRequest: string; stale?: true }
  | null;

/** A step a run stops at unless the workflow's permissions allow it. An agent
 * step's dynamic action has no risk to read before a run, so it counts until
 * a saved grant covers it. */
export function needsGrant(node: Pick<WorkflowNodePermissionWire, "mode" | "agentStep" | "granted">): boolean {
  return node.mode === "require_approval" || (node.agentStep === true && node.mode === "unknown" && node.granted !== true);
}

const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;

/** Whether a saved grant covers an agent step's dynamic action, as the run
 * resolves it (`resolution.ts`: no explicit rule may gate it). The action's
 * risk is unknown before a run, so a rule at any risk level counts. */
function dynamicActionGranted(rows: PolicyResolutionRows, service: string, actionId: string, now: number): boolean {
  if (!rows.workflowGrants?.some((grant) => grant.actionId === actionId)) return false;
  return !RISK_LEVELS.some((riskLevel) => restrictivePolicyAnywhere(rows,
    { service, actionId, riskLevel, params: {}, appliesIn: "session", partialParams: true, agentStep: true, now }));
}

/** The Tool step a run is parked on, and the policy source that held it. */
export interface ParkedToolGate {
  nodeId: string;
  actionId: string;
  provenance: string | undefined;
}

/** Sources a workflow grant can replace: defaults, not rules a person wrote. */
const DEFAULT_SOURCES: ReadonlySet<string> = new Set(["risk_default", "plugin_default"]);

/** A Tool step's dynamic action has no risk to read before a run, so the
 * review reports it as "unknown". A run that parked on it read the risk.
 * When a default held it, the run's approval card can grant that action. */
function grantsParkedGate(node: WorkflowNodePermissionWire, parked: ParkedToolGate): boolean {
  const actionId = node.action.includes(".") ? node.action : `${node.service}.${node.action}`;
  return node.nodeId === parked.nodeId && node.mode === "unknown" && node.agentStep !== true
    && actionId === parked.actionId && parked.provenance !== undefined && DEFAULT_SOURCES.has(parked.provenance);
}

/** Grants only the stored workflow's declared gating actions, never caller-invented actions. */
export async function prepareWorkflowPermissions(
  deps: WorkflowPermissionDeps,
  owner: WorkflowOwner,
  workflowId: string,
  actionIds: string[] | undefined,
  parked?: ParkedToolGate,
): Promise<AllowWorkflowPermissionsOutcome> {
  const summary = await getWorkflowDefinition(deps, owner, workflowId);
  if (!summary) return null;
  const credentialServices = workflowCredentialServices(deps, summary.definition);
  const ownAccountsOnly = actionIds?.length === 0 && summary.ownerType === "team"
    && owner.humanAccountConsent === true && !owner.agentEditor && owner.principal?.type === "user";
  if (!ownAccountsOnly && !(await canGrantWorkflowPermissions(deps, owner, summary))) {
    return { ok: false, badRequest: "Only the workflow owner or a team admin can grant action permissions. To allow your accounts, choose Allow my shared accounts." };
  }
  const analysis = await analyzeDefinitionPermissions(deps, owner, summary);

  // Dedupe: one override per qualified actionId, however many nodes call it.
  const gating = new Map<string, string>();
  for (const node of analysis) {
    if (needsGrant(node) && node.actionId !== null) {
      gating.set(node.actionId, node.service);
    } else if (parked && grantsParkedGate(node, parked)) {
      gating.set(parked.actionId, node.service);
    }
  }

  let targets: string[];
  if (actionIds === undefined) {
    targets = [...gating.keys()];
  } else {
    for (const id of actionIds) {
      if (!gating.has(id)) {
        return {
          ok: false,
          badRequest:
            `"${id}" is not a gating action of this workflow. ` +
            `Request only actionIds that GET .../permissions reports with mode "require_approval", or agent-step actions it reports as "unknown".`,
        };
      }
    }
    targets = [...new Set(actionIds)];
  }

  const now = Date.now();
  const allowed: string[] = [];
  const grants: (typeof workflowActionGrants.$inferInsert)[] = [];
  const blocked: { actionId: string; reason: string }[] = [];
  for (const actionId of targets) {
    const node = analysis.find((node) => node.actionId === actionId);
    if (node?.provenance === "org_policy" || node?.provenance === "team_policy" || node?.provenance === "override") {
      blocked.push({ actionId, reason: "An explicit policy requires approval. Ask its administrator to review it." });
      continue;
    }
    grants.push({
      id: JSON.stringify([owner.orgId, workflowId, summary.ownerType, summary.ownerId, actionId]),
      orgId: owner.orgId, workflowId, ownerType: summary.ownerType, ownerId: summary.ownerId,
      actionId, grantedBy: owner.userId, createdAt: now,
    });
    allowed.push(actionId);
  }
  return { ok: true, result: { allowed, blocked }, grants, definition: summary.definition, definitionToken: workflowPermissionDefinitionToken(owner.orgId, summary, credentialServices), credentialServices };
}

/** Who may approve a workflow's actions for every later run: the owning user, or an admin of the owning team. */
export async function canGrantWorkflowPermissions(deps: WorkflowPermissionDeps, owner: WorkflowOwner, summary: Pick<WorkflowDefinitionSummary, "ownerType" | "ownerId">) {
  if (owner.principal?.type === "team") return false;
  return summary.ownerType === "user" ? summary.ownerId === owner.userId
    : summary.ownerType === "team" && await canAdministerTeam(deps.db, summary.ownerId, owner.userId);
}

export async function revokeWorkflowPermissions(deps: WorkflowPermissionDeps, owner: WorkflowOwner, workflowId: string): Promise<boolean> {
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM workflow_definitions WHERE id = ${workflowId} AND org_id = ${owner.orgId} FOR UPDATE`);
    const scopedDeps = { ...deps, db: tx };
    const summary = await getWorkflowDefinition(scopedDeps, owner, workflowId);
    if (!summary || !(await canGrantWorkflowPermissions(scopedDeps, owner, summary))) return false;
    await revokeWorkflowGrants(tx, owner.orgId, workflowId);
    return true;
  });
}

/** A member can withdraw their own account consent without resetting teammates or action permissions. */
export async function revokeOwnWorkflowAccounts(deps: WorkflowPermissionDeps, owner: WorkflowOwner, workflowId: string): Promise<boolean> {
  if (!owner.humanAccountConsent || owner.agentEditor || owner.principal?.type !== "user") return false;
  return deps.db.transaction(async tx => {
    await tx.execute(sql`SELECT id FROM workflow_definitions WHERE id = ${workflowId} AND org_id = ${owner.orgId} FOR UPDATE`);
    const summary = await getWorkflowDefinition({ ...deps, db: tx }, owner, workflowId);
    if (summary?.ownerType !== "team") return false;
    await revokeWorkflowAccountConsent(tx, owner.orgId, workflowId, owner.userId);
    return true;
  });
}

export async function persistWorkflowPermissions(db: AppQueryable, grants: (typeof workflowActionGrants.$inferInsert)[]) {
  if (grants.length) await db.insert(workflowActionGrants).values(grants).onConflictDoNothing();
}

export async function allowWorkflowPermissions(deps: WorkflowPermissionDeps, owner: WorkflowOwner, workflowId: string, actionIds: string[] | undefined, definitionToken: string): Promise<AllowWorkflowPermissionsOutcome> {
  return deps.db.transaction(async tx => {
    await tx.execute(sql`SELECT id FROM workflow_definitions WHERE id = ${workflowId} AND org_id = ${owner.orgId} FOR UPDATE`);
    const scopedDeps = { ...deps, db: tx };
    const summary = await getWorkflowDefinition(scopedDeps, owner, workflowId);
    if (!summary) return null;
    const stale: AllowWorkflowPermissionsOutcome = { ok: false, stale: true,
      badRequest: "This workflow changed after you reviewed it. Refresh the review, then allow its permissions." };
    if (workflowPermissionDefinitionToken(owner.orgId, summary, workflowCredentialServices(scopedDeps, summary.definition)) !== definitionToken) return stale;
    const prepared = await prepareWorkflowPermissions(scopedDeps, owner, workflowId, actionIds);
    if (!prepared?.ok) return prepared;
    if (prepared.definitionToken !== definitionToken) return stale;
    await persistWorkflowPermissions(tx, prepared.grants);
    if (owner.humanAccountConsent && !owner.agentEditor && owner.principal?.type === "user" && summary.ownerType === "team") {
      await saveWorkflowAccountConsent(tx, {
        orgId: owner.orgId, workflowId, teamId: summary.ownerId, userId: owner.userId,
        services: prepared.credentialServices,
      });
    }
    return prepared;
  });
}
