import { randomUUID } from "node:crypto";
import {
  adaptResourceAccess,
  buildRouteResourceObligationPlan,
  type AuthorizationPrincipal,
  type RouteResourceObligationPlanV1,
} from "@valet/engine/authorization";
import type { AppDb } from "../lib/drizzle.js";
import type { CanonicalAuthorizationService } from "./canonical-authorization-service.js";
import { RESOURCE_ACCESS_REGISTRY, type ResourceKind, type ResourceOperation } from "./route-resource-policy.js";

export interface ResourceAuthorizationContext {
  organizationId: string;
  actorUserId: string;
  principal: AuthorizationPrincipal;
  /** One trusted request, job, or tool delivery. A stable retry uses the same value. */
  deliveryId: string;
}

/** Background jobs use an app principal. They do not inherit a user's authority. */
export function systemResourceAuthorizationContext(organizationId: string, appId: string, deliveryId: string): ResourceAuthorizationContext {
  return { organizationId, actorUserId: appId, principal: { type: "app", id: appId }, deliveryId };
}

export interface ResourceAuthorizationInput extends ResourceAuthorizationContext {
  resourceKind: ResourceKind;
  operation: ResourceOperation;
  resource?: { id?: string; ownerType?: "user" | "team" | "org"; ownerId?: string; version?: number };
}

export interface ResourceAuthorizationPort {
  authorize(input: ResourceAuthorizationInput): Promise<RouteResourceObligationPlanV1>;
}

export class ResourceAuthorizationError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(readonly effect: "deny" | "require_approval" | "indeterminate") {
    super(effect === "require_approval" ? "Resource access requires approval. Ask an administrator to resolve the decision." : effect === "deny" ? "Resource access was denied. Ask an administrator to review access." : "Resource authorization could not be completed. Retry with the same delivery identity.");
    this.name = "ResourceAuthorizationError";
    this.code = `resource_authorization_${effect}`;
    this.statusCode = effect === "deny" ? 403 : effect === "require_approval" ? 409 : 503;
  }
}

export class CanonicalResourceAuthorizationService implements ResourceAuthorizationPort {
  constructor(
    private readonly service: CanonicalAuthorizationService,
    _db: AppDb,
    private readonly now: () => number = Date.now,
  ) {}

  async authorize(input: ResourceAuthorizationInput): Promise<RouteResourceObligationPlanV1> {
    const descriptor = RESOURCE_ACCESS_REGISTRY.find((entry) => entry.resourceKind === input.resourceKind && entry.operation === input.operation);
    if (!descriptor) throw new ResourceAuthorizationError("deny");
    // Resource authorization is always a fresh decision. The caller's
    // delivery ID can identify execution replay, but it cannot pin an allow.
    const delivery = `resource:${randomUUID()}:${input.resourceKind}:${input.operation}`;
    const resource = input.resource ?? {};
    try {
      const adapted = adaptResourceAccess({
        schemaVersion: 1,
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        principal: input.principal,
        requestId: delivery,
        operationId: `${delivery}:operation`,
        evaluationTimeMs: this.now(),
        descriptor: { schemaVersion: 1, service: descriptor.service, actionId: descriptor.actionId, resourceKind: descriptor.resourceKind, operation: descriptor.operation, riskLevel: descriptor.riskLevel },
        resource: { ...(resource.id ? { id: resource.id } : {}), ...(resource.ownerType && resource.ownerId ? { ownerType: resource.ownerType, ownerId: resource.ownerId } : {}) },
        safeMetadata: { ...(resource.id ? { resourceId: resource.id } : {}), ...(resource.ownerType ? { ownerType: resource.ownerType } : {}), ...(resource.ownerId ? { ownerId: resource.ownerId } : {}), ...(resource.version !== undefined ? { version: resource.version } : {}) },
      });
      const envelope = await this.service.authorize(adapted.request);
      if (envelope.decision.effect !== "allow") throw new ResourceAuthorizationError(envelope.decision.effect);
      return buildRouteResourceObligationPlan(envelope.decision);
    } catch (error) {
      if (error instanceof ResourceAuthorizationError) throw error;
      throw new ResourceAuthorizationError("indeterminate");
    }
  }
}

export async function authorizeDirectResource(
  port: ResourceAuthorizationPort,
  context: ResourceAuthorizationContext,
  resourceKind: Extract<ResourceKind, "session" | "assistant" | "team">,
  operation: Extract<ResourceOperation, "update" | "delete">,
  resource: NonNullable<ResourceAuthorizationInput["resource"]>,
): Promise<void> {
  const plan = await port.authorize({ ...context, resourceKind, operation, resource });
  if (plan.resultLimit !== undefined || plan.fieldMask !== undefined || plan.redactions.length > 0 || plan.readOnly) throw new ResourceAuthorizationError("deny");
}

export function newResourceDelivery(idempotencyKey?: string): string {
  return idempotencyKey ?? randomUUID();
}
