import type { ActionPlugin, PluginAction, RiskLevel, ValetPlugin } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { writeExecutionGrant } from "../policies/service.js";
import { qualifiedActionId } from "./action-id.js";

export type ActionPluginIndex = ReadonlyMap<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>;

export interface TrustedActionGrant {
  readonly service: string;
  readonly actionId: string;
  readonly riskLevel: RiskLevel;
}

/** Resolve only a static action that belongs to the requested service. */
export function resolveTrustedActionGrant(
  plugins: ActionPluginIndex,
  service: string,
  requestedActionId: string,
): TrustedActionGrant | undefined {
  const entry = plugins.get(service);
  if (!entry) return undefined;
  const expectedId = requestedActionId.includes(".") ? requestedActionId : `${service}.${requestedActionId}`;
  if (!expectedId.startsWith(`${service}.`)) return undefined;
  const action: PluginAction | undefined = entry.actionPlugin.actions.find(
    (candidate) => qualifiedActionId(service, candidate) === expectedId,
  );
  return action ? { service, actionId: expectedId, riskLevel: action.riskLevel } : undefined;
}

export async function writeTrustedApprovalGrants(
  db: AppDb,
  plugins: ActionPluginIndex,
  input: {
    runId: string;
    orgId: string;
    signalId: string;
    resolvedBy: string;
    now: number;
    grants: ReadonlyArray<{ service: string; actionId: string }>;
  },
): Promise<void> {
  const resolved = input.grants.map((grant) => {
    const binding = resolveTrustedActionGrant(plugins, grant.service, grant.actionId);
    if (!binding) throw new Error(`Approval grant names unknown or cross-service action ${grant.service}:${grant.actionId}.`);
    return binding;
  });
  for (const grant of resolved) {
    await writeExecutionGrant(db, input.runId, {
      orgId: input.orgId,
      ...grant,
      sourceApprovalId: input.signalId,
      expiresAt: input.now + 72 * 60 * 60 * 1000,
      grantedBy: input.resolvedBy,
      now: input.now,
    });
  }
}
