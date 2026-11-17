import type { AuthorizationRequest, EvaluatorIdentity, PolicyDecisionEnvelope } from "@valet/engine";

/** Evaluates one request against the active policy bundle. One deployment has one active evaluator. */
export interface AuthorizationEvaluator {
  readonly identity: EvaluatorIdentity;
  evaluate(request: AuthorizationRequest): Promise<PolicyDecisionEnvelope>;
}

/** The host entry point for every authorization decision. Enforcement points call it and act on the result. */
export interface AuthorizationService {
  authorize(request: AuthorizationRequest): Promise<PolicyDecisionEnvelope>;
}
