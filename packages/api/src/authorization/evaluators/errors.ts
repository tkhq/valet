export type LocalEvaluatorErrorCode =
  | "bundle_conflict"
  | "bundle_not_found"
  | "bundle_replacement_conflict"
  | "incompatible_bundle"
  | "invalid_bundle_or_evaluation"
  | "limit"
  | "malformed_output"
  | "malformed_request"
  | "memory_limit"
  | "timeout"
  | "worker_failure";

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
