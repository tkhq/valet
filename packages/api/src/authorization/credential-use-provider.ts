import { createHash } from "node:crypto";
import type { Credential, CredentialProvider, PolicyDecision, Principal } from "@valet/engine";
import {
  adaptCredentialUse,
  buildDelegatedExecutionObligationPlan,
  decisionDigestOf,
  type PolicyDecisionEnvelope,
} from "@valet/engine/authorization";
import type { AppDb } from "../lib/drizzle.js";
import { canonicalDecisionId, type CanonicalAuthorizationService } from "./canonical-authorization-service.js";
import { completeCanonicalExecution, reserveCanonicalExecution } from "./canonical-execution-lifecycle.js";

export class CredentialUseDeniedError extends Error {
  readonly code: "credential_use_denied" | "credential_use_approval_required" | "credential_use_replay_unavailable" | "credential_provider_failed";

  constructor(code: CredentialUseDeniedError["code"], message: string) {
    super(message);
    this.name = "CredentialUseDeniedError";
    this.code = code;
  }
}

type AuthorizationService = Pick<CanonicalAuthorizationService, "authorize">;
type PersistedResult = { authorized: true; found: boolean };

export interface CredentialUseBinding {
  organizationId: string;
  actorUserId: string;
  principal: Principal;
  owner: Principal;
  service: string;
  credentialClass: string;
  actionId: string;
  operation: "plugin" | "workflow" | "repository" | "internal" | "inject" | "resolve";
  sessionId?: string;
  childSessionId?: string;
  workflowExecutionId?: string;
  resource?: { type: string; id?: string };
  invocationId: string;
}

function parseResult(value: unknown): PersistedResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stored credential authorization result is invalid.");
  const record = value as Record<string, unknown>;
  if (record.authorized !== true || typeof record.found !== "boolean") throw new Error("Stored credential authorization result is invalid.");
  return { authorized: true, found: record.found };
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

function operationId(binding: CredentialUseBinding, service: string): string {
  return `credential-use:${createHash("sha256").update(JSON.stringify({
    invocationId: binding.invocationId,
    service,
    actionId: binding.actionId,
    owner: binding.owner,
    sessionId: binding.sessionId,
    childSessionId: binding.childSessionId,
    workflowExecutionId: binding.workflowExecutionId,
    resource: binding.resource,
  })).digest("hex")}`;
}

/** Authorizes and reserves immediately before one credential side effect. */
export async function authorizeCredentialUseOperation<T>(
  deps: { db: AppDb; authorization: AuthorizationService; binding: CredentialUseBinding; now?: () => number },
  execute: () => Promise<T>,
  found: (value: T) => boolean,
  service = deps.binding.service,
): Promise<T> {
  const now = deps.now ?? Date.now;
  const id = operationId(deps.binding, service);
  const adapted = adaptCredentialUse({
    schemaVersion: 1,
    organizationId: deps.binding.organizationId,
    actorUserId: deps.binding.actorUserId,
    principal: deps.binding.principal,
    requestId: id,
    operationId: id,
    evaluationTimeMs: now(),
    ...(deps.binding.sessionId ? { sessionId: deps.binding.sessionId } : {}),
    service,
    credentialClass: deps.binding.credentialClass,
    owner: deps.binding.owner,
    operation: deps.binding.operation,
    actionId: deps.binding.actionId,
    target: {
      ...(deps.binding.sessionId ? { sessionId: deps.binding.sessionId } : {}),
      ...(deps.binding.childSessionId ? { childSessionId: deps.binding.childSessionId } : {}),
      ...(deps.binding.workflowExecutionId ? { workflowExecutionId: deps.binding.workflowExecutionId } : {}),
    },
    ...(deps.binding.resource ? { resource: deps.binding.resource } : {}),
  });
  const envelope = await deps.authorization.authorize(adapted.request);
  const plan = buildDelegatedExecutionObligationPlan(envelope.decision);
  if (envelope.decision.effect === "deny") {
    throw new CredentialUseDeniedError("credential_use_denied", "Policy denied this credential use. Change the credential policy or action and retry.");
  }
  if (envelope.decision.effect === "require_approval") {
    throw new CredentialUseDeniedError("credential_use_approval_required", "Human approval is not yet supported for credential use. Change the credential policy to allow or deny. For plugin actions, require approval on the action instead.");
  }
  if (plan.credentialOwner && (plan.credentialOwner.ownerType !== deps.binding.owner.type || plan.credentialOwner.ownerId !== deps.binding.owner.id)) {
    throw new CredentialUseDeniedError("credential_use_denied", "Policy restricted this credential to a different owner. Select an allowed credential and retry.");
  }
  const digest = createHash("sha256").update(adapted.canonicalBytes).digest("hex");
  const decision = executionDecision(envelope, canonicalDecisionId(deps.binding.organizationId, adapted.request.idempotencyKey), digest);
  const reserved = await reserveCanonicalExecution(deps.db, decision, digest, parseResult, now);
  if (reserved.kind !== "execute") {
    throw new CredentialUseDeniedError("credential_use_replay_unavailable", "This credential read was already attempted. Retry the action with a new invocation.");
  }
  try {
    const value = await execute();
    await completeCanonicalExecution(deps.db, decision, digest, reserved.attemptId, {
      outcome: "completed",
      result: { authorized: true, found: found(value) },
    }, (result) => result, parseResult, now);
    return value;
  } catch (error) {
    await completeCanonicalExecution(deps.db, decision, digest, reserved.attemptId, {
      outcome: "failed",
      error: "credential_provider_failed",
    }, (value) => value, parseResult, now);
    if (error instanceof CredentialUseDeniedError) throw error;
    throw new CredentialUseDeniedError("credential_provider_failed", "The credential provider failed. Reconnect the credential and retry.");
  }
}

/** Authorizes immediately before one credential provider read. */
export function withCredentialUseAuthorization(
  inner: CredentialProvider,
  deps: { db: AppDb; authorization: AuthorizationService; binding: CredentialUseBinding; now?: () => number },
): CredentialProvider {
  const cache = new Map<string, Promise<Credential | null>>();
  return {
    get(service): Promise<Credential | null> {
      const targetService = service ?? deps.binding.service;
      const existing = cache.get(targetService);
      if (existing) return existing;
      const pending = authorizeCredentialUseOperation(deps, () => inner.get(targetService), (credential) => credential !== null, targetService);
      cache.set(targetService, pending);
      return pending;
    },
    async request(service, reason): Promise<Credential> {
      const credential = await this.get(service);
      if (!credential) {
        throw new Error(`credential ${service} not connected: ${reason}`);
      }
      return credential;
    },
  };
}
