import { adaptInteractiveAction, type CurrentPolicyDynamicFactsV2, type InteractiveActionAdapterInputV1, type SafeParameterProjectionV1 } from "./authorization/index.js";
import type { ActionPlugin, PluginAction } from "./plugin-catalog.js";
import type { ToolContext } from "./types.js";

/** Inert fixture bridge from current catalog shapes to the canonical adapter. */
export function adaptPluginCatalogAction(input: {
  readonly plugin: ActionPlugin;
  readonly action: PluginAction;
  readonly params: unknown;
  readonly projection: SafeParameterProjectionV1;
  readonly context: Pick<ToolContext, "userId" | "orgId" | "sessionId" | "threadId" | "owner" | "queueItemId">;
  readonly requestId: string;
  readonly resumeKey: string;
  readonly gateOrdinal: number;
  readonly evaluationTimeMs: number;
  readonly dynamicFacts: { readonly currentPolicy?: CurrentPolicyDynamicFactsV2 };
  readonly approvalBindingContext?: { readonly requestSubjectDigest: string; readonly originalDecisionDigest: string };
}) {
  if (typeof input.context.queueItemId !== "string" || input.context.queueItemId.length === 0) throw new TypeError("Canonical interactive action identity requires queueItemId.");
  const actionId = input.action.id.includes(".") ? input.action.id : `${input.plugin.service}.${input.action.id}`;
  const owner = input.context.owner ?? { type: "user" as const, id: input.context.userId };
  const adapterInput: InteractiveActionAdapterInputV1 = {
    schemaVersion: 1, organizationId: input.context.orgId, actor: { type: "user", id: input.context.userId }, owner,
    ...(owner.type === "team" ? { teamId: owner.id } : {}), requestId: input.requestId,
    sessionId: input.context.sessionId, threadId: input.context.threadId, queueItemId: input.context.queueItemId,
    resumeKey: input.resumeKey, gateOrdinal: input.gateOrdinal,
    action: { service: input.plugin.service, actionId, catalogActionId: actionId, sourcePluginService: input.plugin.service, sourceActionId: actionId, sourceToolId: "call_tool", riskLevel: input.action.riskLevel, parameters: input.params, parameterProjection: input.projection },
    evaluationTimeMs: input.evaluationTimeMs, dynamicFacts: input.dynamicFacts, ...(input.approvalBindingContext ? { approvalBindingContext: input.approvalBindingContext } : {}),
  };
  return adaptInteractiveAction(adapterInput);
}
