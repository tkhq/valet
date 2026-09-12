import type {
  AuthorizationRequest,
  EvaluatorIdentity,
  PolicyDecisionEnvelope,
} from "@valet/engine";

export interface AuthorizationEvaluator {
  readonly identity: EvaluatorIdentity;
  evaluate(request: AuthorizationRequest): Promise<PolicyDecisionEnvelope>;
}

export interface AuthorizationService {
  authorize(request: AuthorizationRequest): Promise<PolicyDecisionEnvelope>;
}
