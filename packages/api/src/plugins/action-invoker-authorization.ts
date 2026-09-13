import { adaptWorkflowAction, type JsonObject, type PluginAction, type SafeParameterProjectionV1 } from "@valet/engine";
import type { WorkflowInvokeActionRequest } from "@valet/workflow";
import type { ActionInvocationContext } from "./action-invoker.js";
import { qualifiedActionId } from "./action-id.js";

/** Inert fixture bridge from current workflow invocation shapes to the canonical adapter. */
export function adaptWorkflowInvocation(input: {
  readonly request: WorkflowInvokeActionRequest;
  readonly context: ActionInvocationContext;
  readonly action: PluginAction;
  readonly projection: SafeParameterProjectionV1;
  readonly workflowDefinitionId: string;
  readonly workflowVersion: string;
  readonly nodeId: string;
  readonly requestId: string;
  readonly evaluationTimeMs: number;
  readonly dynamicFacts: JsonObject;
}) {
  const actionId = qualifiedActionId(input.request.service, input.action);
  return adaptWorkflowAction({
    schemaVersion: 1, organizationId: input.context.orgId, actor: { type: "user", id: input.context.userId }, owner: input.context.owner,
    ...(input.context.owner.type === "team" ? { teamId: input.context.owner.id } : {}), requestId: input.requestId,
    workflowDefinitionId: input.workflowDefinitionId, workflowVersion: input.workflowVersion,
    workflowExecutionId: input.context.workflowExecutionId ?? "", nodeId: input.nodeId, invocationId: input.request.invocationId,
    action: { service: input.request.service, actionId, catalogActionId: actionId, sourcePluginService: input.request.service, sourceActionId: actionId, sourceToolId: input.nodeId, riskLevel: input.action.riskLevel, parameters: input.request.params, parameterProjection: input.projection },
    evaluationTimeMs: input.evaluationTimeMs, dynamicFacts: input.dynamicFacts,
  });
}
