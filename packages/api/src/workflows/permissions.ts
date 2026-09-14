/**
 * Workflow permissions preview + bulk pre-approval.
 *
 * `analyzeWorkflowPermissions` predicts, per tool node in the stored
 * definition, how the policy ladder would resolve the node's action for its
 * stored owner if a run started now. It uses the same canonical evaluator as
 * the run-time invoker (`plugins/action-invoker.ts`) with `appliesIn:
 * "workflow"` and NO execution id — a run that has not started has no
 * exec-scoped grants, so the grant rung never matches here.
 *
 * `allowWorkflowPermissions` writes one per-user `allow` override for each
 * gating action of a personal workflow. Team workflows refuse this operation;
 * their policies are managed in the team's settings. The pairs come from the stored
 * definition, never from the request — the same server-derivation rule that
 * removed `grantActions` from the approval route (approval-UX spec,
 * Deviations #3). The bounded `upsertOverride` rejects an override that
 * would bypass an org `deny`/`require_approval` policy; those come back as
 * `blocked` with the rejection reason.
 *
 * Approval nodes are deliberately not analyzed: an author-placed approval
 * node is an intended gate, not a permission requirement.
 */
import { upsertOverride } from "../policies/admin.js";
import { adaptWorkflowAction, authorizationSha256Hex, canonicalAuthorizationJson } from "@valet/engine/authorization";
import { actionProjection } from "../authorization/action-projections.js";
import { findAction } from "../plugins/action-invoker.js";
import { qualifiedActionId } from "../plugins/action-id.js";
import type {
  AllowWorkflowPermissionsResponse,
  WorkflowNodePermissionWire,
  WorkflowDefinitionSummary,
} from "../wire/types.js";
import { getWorkflowDefinition, type WorkflowOwner, type WorkflowServiceDeps } from "./service.js";

/** A tool node's identity, narrowed from the stored definition JSON. The
 * definition was validated at save time, but tool-node rows can predate the
 * catalog or be inserted by imports, so this narrows instead of casting. */
interface ToolNodeRef {
  nodeId: string;
  service: string;
  action: string;
  params: Record<string, unknown> | undefined;
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

/** Predicts the policy resolution of every tool node for the stored owner.
 * Returns null when the workflow does not exist for this owner (the caller
 * 404s). Actions absent from the static plugin catalog (dynamic MCP
 * actions) report `mode: "unknown"` — no risk level exists to resolve with
 * until discovery runs, and discovery touches credentials, which a read
 * endpoint must not do. */
export async function analyzeWorkflowPermissions(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  workflowId: string,
): Promise<WorkflowNodePermissionWire[] | null> {
  const summary = await getWorkflowDefinition(deps, owner, workflowId);
  if (!summary) return null;
  return analyzeDefinitionPermissions(deps, owner, summary);
}

async function analyzeDefinitionPermissions(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  summary: WorkflowDefinitionSummary,
): Promise<WorkflowNodePermissionWire[]> {
  const refs = toolNodeRefs(summary.definition);
  if (refs.length === 0) return [];

  const now = Date.now();
  const service = deps.canonicalAuthorizationService;
  if (!service) throw new Error("Canonical authorization service is unavailable.");
  const nodes: WorkflowNodePermissionWire[] = [];
  const workflowVersion = authorizationSha256Hex(canonicalAuthorizationJson(summary.definition));
  for (const ref of refs) {
    const entry = deps.actionPluginByService?.get(ref.service);
    const action = entry ? findAction(entry.actionPlugin.actions, ref.service, ref.action) : undefined;
    if (!entry || !action) { nodes.push({ nodeId: ref.nodeId, service: ref.service, action: ref.action, actionId: null, mode: "unknown" }); continue; }
    const actionId = qualifiedActionId(ref.service, action);
    const invocationId = authorizationSha256Hex(canonicalAuthorizationJson({ workflowId: summary.id, workflowVersion, nodeId: ref.nodeId, owner: summary.ownerId }));
    const adapted = adaptWorkflowAction({ schemaVersion: 1, organizationId: owner.orgId, actor: { type: "user", id: owner.userId }, owner: { type: summary.ownerType, id: summary.ownerId }, ...(summary.ownerType === "team" ? { teamId: summary.ownerId } : {}), requestId: invocationId, workflowDefinitionId: summary.id, workflowVersion, workflowExecutionId: `analysis:${summary.id}`, nodeId: ref.nodeId, invocationId, action: { service: ref.service, actionId, catalogActionId: actionId, sourcePluginService: ref.service, sourceActionId: actionId, sourceToolId: ref.nodeId, riskLevel: action.riskLevel, parameters: ref.params ?? {}, parameterProjection: actionProjection(actionId) }, evaluationTimeMs: now, dynamicFacts: {} });
    const envelope = await service.preview(adapted.request);
    const provenance = envelope.decision.reasonCode === "organization_policy" ? "org_policy" : envelope.decision.reasonCode === "personal_override" ? "override" : envelope.decision.reasonCode;
    nodes.push({ nodeId: ref.nodeId, service: ref.service, action: ref.action, actionId, riskLevel: action.riskLevel, mode: envelope.decision.effect, provenance });
  }
  return nodes;
}

export type AllowWorkflowPermissionsOutcome =
  | { ok: true; result: AllowWorkflowPermissionsResponse }
  | { ok: false; badRequest: string }
  | null;

/** Writes a per-user `allow` override for each gating action of the
 * personal workflow (all of them, or the `actionIds` subset). Returns null when the
 * workflow does not exist for this owner. */
export async function allowWorkflowPermissions(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  workflowId: string,
  actionIds: string[] | undefined,
): Promise<AllowWorkflowPermissionsOutcome> {
  const summary = await getWorkflowDefinition(deps, owner, workflowId);
  if (!summary) return null;
  if (summary.ownerType === "team") {
    return {
      ok: false,
      badRequest: "Personal pre-approval does not apply to team workflows. Ask a team admin to select this team's workspace and open Settings → Policies.",
    };
  }
  const analysis = await analyzeDefinitionPermissions(deps, owner, summary);

  // Dedupe: one override per qualified actionId, however many nodes call it.
  const gating = new Map<string, string>();
  for (const node of analysis) {
    if (node.mode === "require_approval" && node.actionId !== null) {
      gating.set(node.actionId, node.service);
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
            `Request only actionIds reported with mode "require_approval" by GET .../permissions.`,
        };
      }
    }
    targets = [...new Set(actionIds)];
  }

  const manager = deps.canonicalPolicyManager;
  const service = deps.canonicalAuthorizationService;
  if (!manager || !service) throw new Error("Canonical authorization service is unavailable.");
  const idempotencyKey = authorizationSha256Hex(canonicalAuthorizationJson({ workflowId, owner: owner.userId, targets }));
  const { allowed, blocked } = await manager.mutateAndActivate(owner.orgId, { actorId: owner.userId, operation: "workflow_preapproval", idempotencyKey }, async (tx, context) => {
    const activeIdentity = await context.overrideBoundsIdentity();
    const now = Date.now();
    const allowed: string[] = [];
    const blocked: { actionId: string; reason: string }[] = [];
    for (const actionId of targets) {
      const bounds = await service.validateOverrideBounds(owner.orgId, owner.userId, { actionId }, "allow", activeIdentity);
      if (!bounds.ok) {
        blocked.push({ actionId, reason: bounds.error });
        continue;
      }
      const result = await upsertOverride(tx, owner.orgId, owner.userId, { actionId, mode: "allow", now });
      if (result.ok) allowed.push(actionId);
      else blocked.push({ actionId, reason: result.error });
    }
      return { allowed, blocked };
  });
  return { ok: true, result: { allowed, blocked } };
}
