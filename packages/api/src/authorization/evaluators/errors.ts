export type LocalEvaluatorErrorCode =
  | "bundle_conflict"
  | "bundle_digest_mismatch"
  | "bundle_not_found"
  | "bundle_not_loaded"
  | "bundle_replacement_conflict"
  | "command_start"
  | "command_timeout"
  | "decision_contract"
  | "engine_trap"
  | "evaluation_budget"
  | "incompatible_bundle"
  | "invalid_bundle_or_evaluation"
  | "limit"
  | "malformed_request"
  | "memory_limit"
  | "policy"
  | "rejected_builtin"
  | "stale_artifact"
  | "timeout"
  | "worker_failure"
  | "worker_queue"
  | "worker_readiness"
  | "malformed_output";

export class LocalEvaluatorError extends Error {
  constructor(
    readonly code: LocalEvaluatorErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LocalEvaluatorError";
  }
}
