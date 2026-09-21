import { createHash, randomUUID } from "node:crypto";
import type { PolicyDecision, Sandbox, SandboxCreateOpts, SandboxProvider, SessionStore } from "@valet/engine";
import { adaptSandboxCapability, buildDelegatedExecutionObligationPlan, decisionDigestOf, type PolicyDecisionEnvelope } from "@valet/engine/authorization";
import type { AppDb } from "../lib/drizzle.js";
import { canonicalDecisionId, type CanonicalAuthorizationService } from "./canonical-authorization-service.js";
import { completeCanonicalExecution, reserveCanonicalExecution } from "./canonical-execution-lifecycle.js";

export class SandboxCapabilityDeniedError extends Error {
  readonly code: "sandbox_capability_denied" | "sandbox_capability_approval_unsupported" | "sandbox_capability_unsupported";
  constructor(code: SandboxCapabilityDeniedError["code"], message: string) {
    super(message);
    this.name = "SandboxCapabilityDeniedError";
    this.code = code;
  }
}

type AuthorizationService = Pick<CanonicalAuthorizationService, "authorize">;
type PersistedResult = { authorized: true };

function parseResult(value: unknown): PersistedResult {
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).authorized !== true) throw new Error("Stored sandbox authorization result is invalid.");
  return { authorized: true };
}

function executionDecision(envelope: PolicyDecisionEnvelope, decisionId: string, executionInputDigest: string): PolicyDecision {
  return {
    mode: envelope.decision.effect,
    provenance: { baseMode: envelope.decision.effect, source: "canonical_service" },
    canonical: {
      reasonCode: envelope.decision.reasonCode,
      obligations: envelope.decision.obligations,
      redactions: envelope.decision.redactions,
      ...(envelope.decision.approvalRequirement ? { approvalRequirement: envelope.decision.approvalRequirement } : {}),
      requestId: envelope.requestId,
      requestSubjectDigest: envelope.requestSubjectDigest,
      inputDigest: envelope.inputDigest,
      policyDigest: envelope.policyDigest,
      sourceBundleDigest: envelope.sourceBundleDigest,
      evaluatorKind: envelope.evaluator.kind,
      engineDigest: envelope.evaluator.engineDigest,
      decisionDigest: decisionDigestOf(envelope.decision),
      executionInputDigest,
      decisionId,
    },
  };
}

const SANDBOX_CAPABILITY_OBLIGATIONS = new Set(["sandbox.full", "sandbox.docker"]);

export function applySandboxCapabilityObligations(opts: SandboxCreateOpts, allowed: readonly string[] | undefined): SandboxCreateOpts {
  if (allowed === undefined) return opts;
  if (allowed.some((capability) => !SANDBOX_CAPABILITY_OBLIGATIONS.has(capability))) {
    throw new SandboxCapabilityDeniedError("sandbox_capability_denied", "Policy returned an unsupported sandbox capability. Remove the capability obligation and retry.");
  }
  const set = new Set(allowed);
  return {
    ...opts,
    profile: opts.profile === "full" && set.has("sandbox.full") ? "full" : "headless",
    docker: opts.docker === true && set.has("sandbox.docker"),
  };
}

/** Authorizes at the provider create seam. No sandbox effect can precede this wrapper. */
export function withSandboxCapabilityAuthorization(inner: SandboxProvider, deps: { db: AppDb; engineStore: SessionStore; authorization: AuthorizationService; now?: () => number }): SandboxProvider {
  const now = deps.now ?? Date.now;
  const wrapped: SandboxProvider = {
    backend: inner.backend,
    capabilities: () => inner.capabilities(),
    create: async (opts): Promise<Sandbox> => {
      if (!opts.sessionId) throw new SandboxCapabilityDeniedError("sandbox_capability_denied", "Sandbox creation needs a session identity. Retry from the session.");
      const session = await deps.engineStore.getSession(opts.sessionId);
      if (!session) throw new SandboxCapabilityDeniedError("sandbox_capability_denied", "Sandbox creation needs an active session. Reopen the session and retry.");
      if (opts.docker === true && inner.capabilities().dockerSupport !== true) throw new SandboxCapabilityDeniedError("sandbox_capability_unsupported", "This sandbox provider does not enforce Docker capability. Select a supported provider or disable Docker.");
      const operationId = `sandbox-create:${opts.sessionId}:${randomUUID()}`;
      const requested = {
        profile: opts.profile ?? "headless" as "headless" | "full",
        ...(opts.resources?.cpu === undefined ? {} : { cpuClass: "custom" }),
        ...(opts.resources?.memory === undefined ? {} : { memoryClass: "custom" }),
        docker: opts.docker === true,
        browser: opts.profile === "full",
        nestedKubernetes: false,
        tunnels: false,
        ports: [],
        capabilities: opts.docker === true ? ["sandbox.docker"] : [],
      };
      const adapted = adaptSandboxCapability({
        schemaVersion: 1,
        organizationId: session.orgId,
        actorUserId: session.userId,
        principal: session.owner,
        requestId: operationId,
        operationId,
        evaluationTimeMs: now(),
        sessionId: opts.sessionId,
        operation: "provision",
        requested,
        effective: requested,
      });
      const envelope = await deps.authorization.authorize(adapted.request);
      const plan = buildDelegatedExecutionObligationPlan(envelope.decision);
      if (envelope.decision.effect === "deny") throw new SandboxCapabilityDeniedError("sandbox_capability_denied", "Policy denied this sandbox capability. Change the sandbox settings or policy and retry.");
      if (envelope.decision.effect === "require_approval") throw new SandboxCapabilityDeniedError("sandbox_capability_approval_unsupported", "Sandbox capability approval is not available at this boundary. Change the policy to allow or deny.");
      const capabilityObligation = envelope.decision.obligations.some((obligation) => obligation.type === "sandbox_capabilities")
        ? plan.sandboxCapabilities
        : undefined;
      const effective = applySandboxCapabilityObligations(opts, capabilityObligation);
      const executionInputDigest = createHash("sha256").update(adapted.canonicalBytes).digest("hex");
      const decision = executionDecision(envelope, canonicalDecisionId(session.orgId, adapted.request.idempotencyKey), executionInputDigest);
      const reserved = await reserveCanonicalExecution(deps.db, decision, executionInputDigest, parseResult, now);
      if (reserved.kind !== "execute") throw new Error("Sandbox provision replay cannot restore a provider handle. Reopen the session and retry.");
      try {
        const sandbox = await inner.create(effective);
        await completeCanonicalExecution(deps.db, decision, executionInputDigest, reserved.attemptId, { outcome: "completed", result: { authorized: true } }, (value) => value, parseResult, now);
        return sandbox;
      } catch (error) {
        await completeCanonicalExecution(deps.db, decision, executionInputDigest, reserved.attemptId, { outcome: "failed", error: "sandbox_provider_failed" }, (value) => value, parseResult, now);
        throw error;
      }
    },
    restore: (id) => inner.restore(id),
    destroy: (id) => inner.destroy(id),
    status: (id) => inner.status(id),
  };
  if (inner.release) wrapped.release = inner.release.bind(inner);
  if (inner.deriveId) wrapped.deriveId = inner.deriveId.bind(inner);
  if (inner.list) wrapped.list = inner.list.bind(inner);
  if (inner.suspend) wrapped.suspend = inner.suspend.bind(inner);
  if (inner.resume) wrapped.resume = inner.resume.bind(inner);
  if (inner.updateCreds) wrapped.updateCreds = inner.updateCreds.bind(inner);
  return wrapped;
}
