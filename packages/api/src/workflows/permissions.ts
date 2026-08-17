/**
 * Workflow permissions preview + bulk pre-approval.
 *
 * `analyzeWorkflowPermissions` predicts, per tool node in the stored
 * definition, how the policy ladder would resolve the node's action for one
 * user if a run started now. It runs the same `resolveActionPolicy` core as
 * the run-time invoker (`plugins/action-invoker.ts`) with `appliesIn:
 * "workflow"` and NO execution id — a run that has not started has no
 * exec-scoped grants, so the grant rung never matches here.
 *
 * `allowWorkflowPermissions` writes one per-user `allow` override for each
 * gating action. The `(service, actionId)` pairs come from the stored
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
import { resolveActionPolicy } from "../policies/service.js";
import { findAction, qualifiedActionId } from "../plugins/action-invoker.js";
import type {
  AllowWorkflowPermissionsResponse,
  WorkflowNodePermissionWire,
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
    if (n.type !== "tool") continue;
    if (typeof n.id !== "string" || typeof n.service !== "string" || typeof n.action !== "string") continue;
    const params =
      typeof n.params === "object" && n.params !== null && !Array.isArray(n.params)
        ? (n.params as Record<string, unknown>)
        : undefined;
    refs.push({ nodeId: n.id, service: n.service, action: n.action, params });
  }
  return refs;
}

/** Predicts the policy resolution of every tool node for `owner.userId`.
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

  const refs = toolNodeRefs(summary.definition);
  const now = Date.now();
  const nodes: WorkflowNodePermissionWire[] = [];
  for (const ref of refs) {
    const entry = deps.actionPluginByService?.get(ref.service);
    const action = entry ? findAction(entry.actionPlugin.actions, ref.service, ref.action) : undefined;
    if (!entry || !action) {
      nodes.push({ nodeId: ref.nodeId, service: ref.service, action: ref.action, actionId: null, mode: "unknown" });
      continue;
    }
    const actionId = qualifiedActionId(ref.service, action);
    const decision = await resolveActionPolicy(deps.db, {
      orgId: owner.orgId,
      userId: owner.userId,
      service: ref.service,
      actionId,
      riskLevel: action.riskLevel,
      params: ref.params,
      appliesIn: "workflow",
      pluginDefault: entry.actionPlugin.defaultApprovalMode,
      now,
    });
    nodes.push({
      nodeId: ref.nodeId,
      service: ref.service,
      action: ref.action,
      actionId,
      riskLevel: action.riskLevel,
      mode: decision.mode,
      provenance: decision.provenance.source,
    });
  }
  return nodes;
}

export type AllowWorkflowPermissionsOutcome =
  | { ok: true; result: AllowWorkflowPermissionsResponse }
  | { ok: false; badRequest: string }
  | null;

/** Writes a per-user `allow` override for each gating action of the
 * workflow (all of them, or the `actionIds` subset). Returns null when the
 * workflow does not exist for this owner. */
export async function allowWorkflowPermissions(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  workflowId: string,
  actionIds: string[] | undefined,
): Promise<AllowWorkflowPermissionsOutcome> {
  const analysis = await analyzeWorkflowPermissions(deps, owner, workflowId);
  if (analysis === null) return null;

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

  const now = Date.now();
  const allowed: string[] = [];
  const blocked: { actionId: string; reason: string }[] = [];
  for (const actionId of targets) {
    const result = await upsertOverride(
      deps.db,
      owner.orgId,
      owner.userId,
      { actionId, mode: "allow", now },
      deps.actionPluginByService ?? new Map(),
    );
    if (result.ok) allowed.push(actionId);
    else blocked.push({ actionId, reason: result.error });
  }
  return { ok: true, result: { allowed, blocked } };
}
