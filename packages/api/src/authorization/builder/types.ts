import type { AuthorizationEffect, AuthorizationKind, JsonValue } from "@valet/engine/authorization";

export type FieldType = "string" | "number" | "boolean" | "string_set" | "timestamp";
export type Sensitivity = "public" | "sensitive" | "secret_reference_only";
export type ComparisonOperator = "eq" | "neq" | "regex" | "in" | "not_in" | "gt" | "gte" | "lt" | "lte" | "exists" | "not_exists" | "suffix";
export type DraftAuthority = "organization" | "team" | "personal" | "session" | "workflow";

export interface PolicyFieldDescriptor {
  readonly path: string;
  readonly label: string;
  readonly location: "target" | "fact" | "attribute";
  readonly type: FieldType;
  readonly sensitivity: Sensitivity;
  readonly operators: readonly ComparisonOperator[];
  readonly operatorDescriptions?: Readonly<Partial<Record<ComparisonOperator, string>>>;
}
export interface PolicyTargetOptionV1 {
  readonly actionId: string;
  readonly service: string;
  readonly label: string;
  readonly riskLevel: "low" | "medium" | "high" | "critical";
  readonly method?: string;
  readonly template?: string;
  readonly resourceKind?: string;
  readonly operation: string;
  readonly approvalSupported: boolean;
}
export type PolicyContextRegistry = Readonly<Record<AuthorizationKind, PolicyContextDescriptor>>;
export interface PolicyContextsResponseV1 { readonly schemaVersion: 1; readonly contexts: PolicyContextRegistry; }
export interface PolicyContextDescriptor {
  readonly schemaVersion: 1;
  readonly kind: AuthorizationKind;
  readonly label: string;
  readonly subjectKinds: readonly ("user" | "team" | "org" | "app")[];
  readonly fields: readonly PolicyFieldDescriptor[];
  readonly targets: readonly PolicyTargetOptionV1[];
  readonly effects: readonly AuthorizationEffect[];
  readonly humanApproval: boolean;
  readonly fallback: "deny" | "require_approval";
  readonly publishable: boolean;
  readonly appliesIn: boolean;
  readonly obligations: readonly ("approval_tier" | "credential_owner" | "egress_hosts" | "sandbox_capabilities" | "target_idempotency" | "redact")[];
}

export interface PolicyMatcherDraftV1 {
  readonly id: string;
  readonly field: string;
  readonly operator: ComparisonOperator;
  readonly value?: JsonValue;
}
export interface PolicyMatcherGroupV1 {
  readonly id: string;
  readonly mode: "all" | "any" | "not";
  readonly matchers: readonly PolicyMatcherDraftV1[];
}
export interface PolicyRuleDraftV1 {
  readonly ruleId: string;
  readonly context: AuthorizationKind;
  readonly authority: DraftAuthority;
  readonly owner: {
    readonly kind: "org" | "team" | "user" | "session" | "workflow";
    readonly id: string;
  };
  readonly subjects: readonly ("user" | "team" | "org" | "app")[];
  readonly target: Readonly<Record<string, JsonValue>>;
  readonly matcherGroups: readonly PolicyMatcherGroupV1[];
  readonly effect: AuthorizationEffect;
  readonly appliesIn?: "any" | "session" | "workflow";
  readonly expiresAtMs?: number;
  readonly approval?: {
    readonly tier: string;
    readonly replay: "once" | "session" | "workflow";
  };
  readonly obligations: readonly {
    readonly type: PolicyContextDescriptor["obligations"][number];
    readonly paths?: readonly string[];
  }[];
  readonly description: string;
  readonly metadata: Readonly<Record<string, string>>;
}
export interface PolicyDraftV1 {
  readonly schemaVersion: 1;
  readonly draftId: string;
  readonly rules: readonly PolicyRuleDraftV1[];
}
export interface NormalizedPolicyDraftV1 extends PolicyDraftV1 {
  readonly normalizedIdentity: string;
}
export interface DraftValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface PolicyPreviewRequestV1 {
  readonly schemaVersion: 1;
  readonly draft: NormalizedPolicyDraftV1;
  readonly sampleFacts: Readonly<Record<string, JsonValue>>;
}
export interface PolicySourceRangeV1 {
  readonly ruleId: string;
  readonly startLine: number;
  readonly endLine: number;
}
export type PolicyPreviewResultV1 =
  | {
      readonly status: "ready";
      readonly identity: string;
      readonly rego: string;
      readonly data: string;
      readonly ranges: readonly PolicySourceRangeV1[];
      readonly usage?: {
        readonly workUnits: number;
        readonly workLimit: number;
      };
      readonly effect?: AuthorizationEffect;
      readonly reason?: string;
    }
  | {
      readonly status: "invalid" | "unsupported";
      readonly issues: readonly DraftValidationIssue[];
    };
export interface PolicyPreviewProvider {
  preview(request: PolicyPreviewRequestV1, signal: AbortSignal): Promise<PolicyPreviewResultV1>;
}
export type { AuthorizationKind, JsonValue } from "@valet/engine/authorization";

export type PolicyAuthoringStatus = "draft" | "in_review" | "approved_for_publication";
export type PolicyAuthoringOperation = "view" | "create" | "edit" | "submit_review" | "review" | "prepare_publication" | "restore_draft";
export interface PolicyAuthoringScope {
  readonly organizationId: string;
  readonly teamId?: string;
}
export interface PolicyValidationSummary {
  readonly valid: boolean;
  readonly publishable: boolean;
  readonly issues: readonly DraftValidationIssue[];
}
export interface PolicyAuthoringDocument {
  readonly schemaVersion: 1;
  readonly documentId: string;
  readonly scope: PolicyAuthoringScope;
  readonly status: PolicyAuthoringStatus;
  readonly revision: number;
  readonly stateVersion: number;
  readonly reviewCycle?: number;
  readonly normalizedIdentity: string;
  readonly sourceBundleDigest?: string;
  readonly policyDigest?: string;
  readonly engineDigest?: string;
  readonly validation: PolicyValidationSummary;
  readonly createdBy: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}
export interface PolicyMutationBase {
  readonly schemaVersion: 1;
  readonly expectedRevision: number;
  readonly expectedStateVersion: number;
  readonly idempotencyKey: string;
}
export interface CreatePolicyDraftRequest extends PolicyMutationBase {
  readonly draft: PolicyDraftV1;
}
export interface EditPolicyDraftRequest extends PolicyMutationBase {
  readonly draft: PolicyDraftV1;
}
export interface ReviewPolicyDraftRequest extends PolicyMutationBase {
  readonly verdict: "approve" | "reject";
  readonly requestId: string;
}
export interface PolicyPreviewServerRequest {
  readonly schemaVersion: 1;
  readonly draft: PolicyDraftV1;
  readonly sampleFacts: Readonly<Record<string, JsonValue>>;
  readonly clientNormalizedIdentity?: string;
}
export interface PolicyRevisionDiffV1 {
  readonly schemaVersion: 1;
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly addedRuleIds: readonly string[];
  readonly removedRuleIds: readonly string[];
  readonly changedRuleIds: readonly string[];
  readonly regoChanged: boolean;
  readonly dataChanged: boolean;
  readonly provenanceChanged: boolean;
  readonly fromIdentity: string;
  readonly toIdentity: string;
  readonly fromSourceBundleDigest?: string;
  readonly toSourceBundleDigest?: string;
}
