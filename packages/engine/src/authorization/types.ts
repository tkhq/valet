export type AuthorizationKind =
  | "tool.action"
  | "workflow.action"
  | "tool.builtin"
  | "plugin.entitlement"
  | "route.access"
  | "resource.access"
  | "delegation.create"
  | "agent.signal"
  | "sandbox.capability"
  | "credential.use"
  | "credential.delegate"
  | "egress.connect";

export type AuthorizationEffect = "allow" | "deny" | "require_approval";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface AuthorizationPrincipal {
  type: "user" | "team" | "org" | "app";
  id: string;
}

export interface AuthorizationInvocation {
  type: "interactive" | "workflow" | "route" | "resource";
  id: string;
}

export interface AuthorizationSubject {
  orgId: string;
  principal: AuthorizationPrincipal;
  invocation: AuthorizationInvocation;
  actorUserId?: string;
  sessionId?: string;
  threadId?: string;
  workflowExecutionId?: string;
  workflowNodeId?: string;
  parentSessionId?: string;
}

export interface AuthorizationAction {
  id: string;
  service?: string;
  riskLevel?: string;
  parameters?: JsonObject;
}

export interface AuthorizationResource {
  type: string;
  id?: string;
  ownerType?: string;
  ownerId?: string;
}

export interface ApprovalFact {
  resolutionId: string;
  decisionDigest: string;
  requestSubjectDigest: string;
  effect: "approved" | "rejected";
  resolvedBy: string;
  resolvedAtMs: number;
}

export interface AuthorizationRequest {
  schemaVersion: 1;
  requestId: string;
  idempotencyKey: string;
  kind: AuthorizationKind;
  subject: AuthorizationSubject;
  action: AuthorizationAction;
  resource?: AuthorizationResource;
  context: JsonObject;
  facts: JsonObject;
  approval?: ApprovalFact;
}

export type Obligation =
  | { type: "approval_tier"; tier: string }
  | { type: "credential_owner"; ownerType: string; ownerId: string }
  | { type: "egress_hosts"; hosts: string[] }
  | { type: "sandbox_capabilities"; capabilities: string[] }
  | { type: "target_idempotency"; required: true };

export interface RedactionDirective {
  target: "audit" | "explanation" | "user_output";
  jsonPaths: string[];
}

export interface ApprovalRequirement {
  tier: string;
  approverType: "user" | "team" | "org";
  approverId?: string;
  replay: "once" | "session" | "workflow";
  expiresAtMs?: number;
}

export interface PolicyDecisionV1 {
  effect: AuthorizationEffect;
  reasonCode: string;
  matchedRuleIds: string[];
  obligations: Obligation[];
  redactions: RedactionDirective[];
  approvalRequirement?: ApprovalRequirement;
}

export interface EvaluatorIdentity {
  kind: "local_valet" | "tvc_attested";
  engineDigest: string;
}

export interface TvcDecisionProof {
  formatVersion: number;
  keyId: string;
  claimsDigest: string;
  signature: string;
  attestationDocument: string;
}

export interface FactProvenance {
  source: "host_asserted" | "trusted_issuer";
  issuer?: string;
  digest?: string;
}

export interface PolicyDecisionEnvelope {
  schemaVersion: 1;
  requestId: string;
  requestSubjectDigest: string;
  inputDigest: string;
  policyDigest: string;
  compiledBundleDigest: string;
  evaluator: EvaluatorIdentity;
  decision: PolicyDecisionV1;
  evaluatedAtMs: number;
  proof?: TvcDecisionProof;
}

export interface AuthorizationIdentity {
  idempotencyKey: string;
  requestSubjectDigest: string;
}
