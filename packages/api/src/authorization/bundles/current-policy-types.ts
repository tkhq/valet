import type { ApprovalMode, RiskLevel } from "@valet/engine";
import type { CurrentPolicyDynamicFactsV2, JsonValue } from "@valet/engine/authorization";
import type { ParamMatcherOp } from "../../policies/matchers.js";

export type CurrentPolicyMode = ApprovalMode;
export type CurrentPolicyAppliesIn = "any" | "session" | "workflow";

export interface CurrentPolicyMatcherV1 {
  readonly path: string;
  readonly op: ParamMatcherOp;
  readonly value?: JsonValue;
}

export interface CurrentPolicyTargetV1 {
  readonly service?: string;
  readonly actionId?: string;
  readonly riskLevel?: RiskLevel;
}

export interface CurrentOrganizationPolicyV1 extends CurrentPolicyTargetV1 {
  readonly id: string;
  readonly organizationId: string;
  readonly principalType: "org";
  readonly principalId: string;
  readonly mode: CurrentPolicyMode;
  readonly paramMatchers: readonly CurrentPolicyMatcherV1[];
  readonly appliesIn: CurrentPolicyAppliesIn;
  readonly expiresAtMs: number | null;
  readonly revokedAtMs: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly sourceTable: "action_policies";
  readonly sourcePath?: string;
}

export interface CurrentTeamPolicyV1 extends CurrentPolicyTargetV1 {
  readonly id: string;
  readonly organizationId: string;
  readonly principalType: "team";
  readonly principalId: string;
  readonly mode: CurrentPolicyMode;
  readonly paramMatchers: readonly CurrentPolicyMatcherV1[];
  readonly appliesIn: CurrentPolicyAppliesIn;
  readonly expiresAtMs: number | null;
  readonly revokedAtMs: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly sourceTable: "action_policies";
  readonly sourcePath?: string;
}

export interface CurrentPersonalOverrideV1 extends CurrentPolicyTargetV1 {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly mode: CurrentPolicyMode;
  readonly paramMatchers: readonly CurrentPolicyMatcherV1[];
  readonly revokedAtMs?: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly sourceTable: "action_policy_overrides";
  readonly sourcePath?: string;
}

export interface CurrentPluginDefaultV1 {
  readonly id: string;
  readonly service: string;
  readonly mode: CurrentPolicyMode;
  readonly sourcePath: string;
}

export interface CurrentRiskDefaultV1 {
  readonly id: string;
  readonly riskLevel: RiskLevel;
  readonly mode: CurrentPolicyMode;
  readonly sourcePath: string;
}

export interface CurrentPolicySourceSnapshotV1 {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly policyVersion: string;
  readonly sourceRevision: string;
  readonly teamIds: readonly string[];
  readonly organizationPolicies: readonly CurrentOrganizationPolicyV1[];
  readonly teamPolicies: readonly CurrentTeamPolicyV1[];
  readonly personalOverrides: readonly CurrentPersonalOverrideV1[];
  readonly pluginDefaults: readonly CurrentPluginDefaultV1[];
  readonly riskDefaults: readonly CurrentRiskDefaultV1[];
  readonly bundleDefault: {
    readonly id: string;
    readonly actionEffect: "require_approval";
    readonly unsupportedContextEffect: "deny";
    readonly sourcePath: string;
  };
}

export interface CurrentRuntimeGrantSourceV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly organizationId: string;
  readonly policyKey: string;
  readonly service: string;
  readonly actionId: string;
  readonly riskLevel: RiskLevel;
  readonly appliesIn: "session" | "workflow";
  readonly sessionId?: string;
  readonly workflowExecutionId?: string;
  readonly issuerId: string;
  readonly sourceApprovalId: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly revokedAtMs: number | null;
}

export interface CurrentApprovalResolutionSourceV1 {
  readonly schemaVersion: 1;
  readonly resolutionId: string;
  readonly approvalId: string;
  readonly gateId: string;
  readonly organizationId: string;
  readonly requestSubjectDigest: string;
  readonly originalDecisionDigest: string;
  readonly approverId: string;
  readonly verdict: "approved" | "rejected";
  readonly appliesIn: "session" | "workflow";
  readonly sessionId?: string;
  readonly workflowExecutionId?: string;
  readonly resolvedAtMs: number;
  readonly expiresAtMs: number;
  readonly resolutionVersion: 1;
}

export type { CurrentPolicyDynamicFactsV2 };
/** @deprecated Use CurrentPolicyDynamicFactsV2 from the engine authorization contract. */
export type CurrentPolicyDynamicFactsV1 = CurrentPolicyDynamicFactsV2;
