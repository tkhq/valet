// Portable authorization contracts. One request shape covers every policy
// domain, and one decision shape comes back from the evaluator. The request
// follows the subject, action, resource, and context split, so it maps
// directly to an AuthZEN evaluation request.

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

/** Whose authority the request uses. Matches the user, team, and org owner types. */
export interface AuthorizationPrincipal {
  type: "user" | "team" | "org";
  id: string;
}

/** The durable operation that the request belongs to. A replay after a restart has the same invocation. */
export interface AuthorizationInvocation {
  type: "interactive" | "workflow" | "route" | "resource";
  id: string;
}

export interface AuthorizationSubject {
  orgId: string;
  principal: AuthorizationPrincipal;
  invocation: AuthorizationInvocation;
  /** The person who caused the request when the principal is a team or org. */
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

/**
 * How strong an approval is. `session`: a signed-in person clicked Approve.
 * `presence`: a proof of presence that a third party verified, such as a
 * passkey tap Turnkey checked. In AuthZEN terms a `presence` requirement is a
 * `step-up` obligation with RFC 8176 `amr_values` `pop` and `user`.
 */
export type ApprovalAssurance = "session" | "presence";

/**
 * The approval object of the AuthZEN Access Request and Approval Profile
 * (section 8.1). `state` is the verifier's proof, carried unchanged; the
 * verifier checks its integrity, issuer, and binding before it trusts it.
 */
export interface AuthzenApprovalObject {
  id: string;
  approved_at: string;
  approved_until: string;
  state?: JsonValue;
}

/** A recorded human approval. It applies only to the request subject it names. */
export interface ApprovalFact {
  resolutionId: string;
  decisionDigest: string;
  requestSubjectDigest: string;
  effect: "approved" | "rejected";
  resolvedBy: string;
  resolvedAtMs: number;
  /** Absent means `session`. */
  assurance?: ApprovalAssurance;
  /** The proof behind a `presence` approval, as an AuthZEN approval object. */
  approval?: AuthzenApprovalObject;
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
  /** Values the host resolved before evaluation, such as memberships and session state. */
  facts: JsonObject;
  approval?: ApprovalFact;
}

/** Work the enforcement point must do before it acts on an allow decision. */
export type Obligation =
  | { type: "approval_tier"; tier: string; assurance?: ApprovalAssurance }
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
  /** The approval strength the requirement needs. Absent means `session`. */
  assurance?: ApprovalAssurance;
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

/** Proof material that an attested evaluator returns. A local evaluator returns none. */
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

/** One decision, bound to the exact request, policy, and evaluator that produced it. */
export interface PolicyDecisionEnvelope {
  schemaVersion: 1;
  requestId: string;
  requestSubjectDigest: string;
  inputDigest: string;
  policyDigest: string;
  sourceBundleDigest: string;
  evaluator: EvaluatorIdentity;
  decision: PolicyDecisionV1;
  evaluatedAtMs: number;
  proof?: TvcDecisionProof;
}

export interface AuthorizationIdentity {
  idempotencyKey: string;
  requestSubjectDigest: string;
}
