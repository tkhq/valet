import { requestSubjectDigest, type AuthorizationRequest, type EvaluatorIdentity, type PolicyDecisionEnvelope } from "@valet/engine/authorization";
import type { AuthorizationEvaluator } from "../contracts.js";
import type { SourceBundleHost } from "../bundles/host.js";
import { LocalEvaluatorError } from "./errors.js";
import { type RuntimeIdentity, type WasmPolicyRuntime } from "./wasm-runtime.js";

interface RuntimeEvaluation {
  readonly sourceBundleDigest: string;
  readonly policyDigest: string;
  readonly engineDigest: string;
  readonly inputDigest: string;
  readonly decisionDigest: string;
  readonly decision: PolicyDecisionEnvelope["decision"];
}

export class LocalValetEvaluator implements AuthorizationEvaluator {
  readonly identity: EvaluatorIdentity;

  private constructor(
    private readonly host: SourceBundleHost,
    private readonly runtime: WasmPolicyRuntime,
    identity: RuntimeIdentity,
  ) {
    this.identity = Object.freeze({ kind: "local_valet", engineDigest: identity.engineDigest });
  }

  static async create(host: SourceBundleHost, runtime: WasmPolicyRuntime): Promise<LocalValetEvaluator> {
    return new LocalValetEvaluator(host, runtime, await runtime.identity());
  }

  async evaluate(request: AuthorizationRequest): Promise<PolicyDecisionEnvelope> {
    const loaded = await this.host.loadActive(request.subject.orgId);
    const result = await this.runtime.run<RuntimeEvaluation>({
      operation: "evaluate",
      sourceBundleDigest: loaded.identity.sourceBundleDigest,
      input: request,
      explain: "off",
    });
    if (
      result.engineDigest !== this.identity.engineDigest ||
      result.sourceBundleDigest !== loaded.identity.sourceBundleDigest ||
      result.policyDigest !== loaded.identity.policyDigest
    ) {
      throw new LocalEvaluatorError("worker_failure", "Policy evaluation identity did not match the loaded bundle.");
    }
    return {
      schemaVersion: 1,
      requestId: request.requestId,
      requestSubjectDigest: requestSubjectDigest(request),
      inputDigest: result.inputDigest,
      policyDigest: result.policyDigest,
      sourceBundleDigest: result.sourceBundleDigest,
      evaluator: this.identity,
      decision: result.decision,
      decisionDigest: result.decisionDigest,
      evaluatedAtMs: Date.now(),
    };
  }
}
