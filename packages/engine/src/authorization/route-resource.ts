import { authorizationIdentity, canonicalAuthorizationJson, resourceAuthorizationSubject, routeAuthorizationSubject } from "./identity.js";
import { trustedJsonClone } from "./trusted-json.js";
import { validateCurrentPolicyDynamicFactsV2, type CurrentPolicyDynamicFactsV2 } from "./current-policy-facts.js";
import type { AuthorizationPrincipal, AuthorizationRequest, JsonObject, PolicyDecisionV1, RedactionDirective } from "./types.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/;
const ACTION = /^[a-z][a-z0-9_-]*\.[a-z0-9][a-z0-9_.:-]*$/;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);
const RISKS = new Set(["low", "medium", "high", "critical"]);

export type RouteResourceAdapterErrorCode = "invalid_shape" | "invalid_identity" | "invalid_descriptor" | "unsafe_metadata";
export class RouteResourceAdapterError extends TypeError {
  constructor(readonly code: RouteResourceAdapterErrorCode) {
    super(`Canonical route/resource adapter rejected the input (${code}).`);
    this.name = "RouteResourceAdapterError";
  }
}

interface CommonInput {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly principal: AuthorizationPrincipal;
  readonly requestId: string;
  readonly operationId: string;
  readonly evaluationTimeMs: number;
  readonly safeMetadata?: JsonObject;
  readonly dynamicFacts?: { readonly currentPolicy?: CurrentPolicyDynamicFactsV2 };
  readonly approvalBindingContext?: { readonly requestSubjectDigest: string; readonly originalDecisionDigest: string };
  readonly approvalScopeId?: string;
}

export interface ApiRouteAdapterInputV1 extends CommonInput {
  readonly descriptor: {
    readonly schemaVersion: 1;
    readonly service: string;
    readonly actionId: string;
    readonly method: string;
    readonly routeTemplate: string;
    readonly riskLevel: string;
  };
}

export interface ResourceAccessAdapterInputV1 extends CommonInput {
  readonly descriptor: {
    readonly schemaVersion: 1;
    readonly service: string;
    readonly actionId: string;
    readonly resourceKind: string;
    readonly operation: string;
    readonly riskLevel: string;
  };
  readonly resource: {
    readonly id?: string;
    readonly ownerType?: "user" | "team" | "org";
    readonly ownerId?: string;
  };
}

export interface RouteResourceAdapterOutputV1 {
  readonly schemaVersion: 1;
  readonly request: AuthorizationRequest;
  readonly canonicalBytes: string;
  readonly requestSubjectDigest: string;
}

export function adaptApiRoute(input: ApiRouteAdapterInputV1): RouteResourceAdapterOutputV1 {
  common(input);
  exact(input.descriptor, ["schemaVersion", "service", "actionId", "method", "routeTemplate", "riskLevel"]);
  descriptor(input.descriptor);
  if (!METHODS.has(input.descriptor.method) || !input.descriptor.routeTemplate.startsWith("/") || input.descriptor.routeTemplate.length > 256) fail("invalid_descriptor");
  return output(input, "api.route", routeAuthorizationSubject({ orgId: input.organizationId, principal: input.principal, actorUserId: input.actorUserId, operationId: input.operationId }), {
    method: input.descriptor.method,
    template: input.descriptor.routeTemplate,
    actionId: input.descriptor.actionId,
    riskLevel: input.descriptor.riskLevel,
    metadata: metadata(input.safeMetadata),
  });
}

export function adaptResourceAccess(input: ResourceAccessAdapterInputV1): RouteResourceAdapterOutputV1 {
  common(input);
  exact(input.descriptor, ["schemaVersion", "service", "actionId", "resourceKind", "operation", "riskLevel"]);
  descriptor(input.descriptor);
  for (const value of [input.descriptor.resourceKind, input.descriptor.operation]) validId(value);
  exact(input.resource, ["id", "ownerType", "ownerId"]);
  if (input.resource.id !== undefined) validId(input.resource.id);
  if ((input.resource.ownerType === undefined) !== (input.resource.ownerId === undefined)) fail("invalid_identity");
  if (input.resource.ownerType !== undefined && !["user", "team", "org"].includes(input.resource.ownerType)) fail("invalid_identity");
  if (input.resource.ownerId !== undefined) validId(input.resource.ownerId);
  return output(input, "resource.access", resourceAuthorizationSubject({ orgId: input.organizationId, principal: input.principal, actorUserId: input.actorUserId, operationId: input.operationId }), {
    kind: input.descriptor.resourceKind,
    operation: input.descriptor.operation,
    metadata: metadata(input.safeMetadata),
  }, { type: input.descriptor.resourceKind, ...input.resource });
}

function common(input: CommonInput): void {
  for (const value of [input.organizationId, input.actorUserId, input.requestId, input.operationId, input.principal.id]) validId(value);
  if (input.schemaVersion !== 1 || !["user", "team", "org", "app"].includes(input.principal.type) || !Number.isSafeInteger(input.evaluationTimeMs) || input.evaluationTimeMs < 0) fail("invalid_identity");
  if (input.principal.type === "user" && input.principal.id !== input.actorUserId) fail("invalid_identity");
  if (input.principal.type === "org" && input.principal.id !== input.organizationId) fail("invalid_identity");
}

function descriptor(value: { schemaVersion: number; service: string; actionId: string; riskLevel: string }): void {
  if (value.schemaVersion !== 1 || !/^[a-z][a-z0-9_-]*$/.test(value.service) || !ACTION.test(value.actionId) || !value.actionId.startsWith(`${value.service}.`) || !RISKS.has(value.riskLevel)) fail("invalid_descriptor");
}

function metadata(value: JsonObject | undefined): JsonObject {
  try {
    const clone = trustedJsonClone(value ?? {}) as JsonObject;
    if (new TextEncoder().encode(canonicalAuthorizationJson(clone)).length > 8_192) fail("unsafe_metadata");
    return clone;
  } catch (error) {
    if (error instanceof RouteResourceAdapterError) throw error;
    fail("unsafe_metadata");
  }
}

function output(input: CommonInput & { descriptor: { service: string; actionId: string; riskLevel: string } }, kind: "api.route" | "resource.access", subject: AuthorizationRequest["subject"], parameters: JsonObject, resource?: AuthorizationRequest["resource"]): RouteResourceAdapterOutputV1 {
  const facts: JsonObject = input.dynamicFacts?.currentPolicy === undefined ? {} : { currentPolicy: validateCurrentPolicyDynamicFactsV2(input.dynamicFacts.currentPolicy, { organizationId: input.organizationId, service: input.descriptor.service, actionId: input.descriptor.actionId, riskLevel: input.descriptor.riskLevel as "low" | "medium" | "high" | "critical", appliesIn: kind === "api.route" ? "route" : "resource", scopeId: input.approvalScopeId ?? input.operationId, evaluationTimeMs: input.evaluationTimeMs, ...input.approvalBindingContext }) };
  const partial = {
    schemaVersion: 1 as const,
    requestId: input.requestId,
    kind,
    subject,
    action: { id: input.descriptor.actionId, service: input.descriptor.service, riskLevel: input.descriptor.riskLevel, parameters },
    ...(resource === undefined ? {} : { resource }),
    context: { schemaVersion: 1, evaluationTimeMs: input.evaluationTimeMs, ...(input.approvalBindingContext ?? {}), ...(input.approvalScopeId === undefined ? {} : { approvalScopeId: input.approvalScopeId }) },
    facts,
  };
  const identity = authorizationIdentity(partial);
  const request = deepFreeze({ ...partial, idempotencyKey: identity.idempotencyKey });
  return deepFreeze({ schemaVersion: 1, request, canonicalBytes: canonicalAuthorizationJson(request), requestSubjectDigest: identity.requestSubjectDigest });
}

function exact(value: unknown, keys: readonly string[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) fail("invalid_shape");
}
function validId(value: unknown): asserts value is string { if (typeof value !== "string" || !ID.test(value)) fail("invalid_identity"); }
function fail(code: RouteResourceAdapterErrorCode): never { throw new RouteResourceAdapterError(code); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { for (const entry of Object.values(value)) deepFreeze(entry); Object.freeze(value); } return value; }


export interface RouteResourceObligationPlanV1 {
  readonly schemaVersion: 1;
  readonly resultLimit?: number;
  readonly fieldMask?: readonly string[];
  readonly readOnly: boolean;
  readonly redactions: readonly RedactionDirective[];
}

export function buildRouteResourceObligationPlan(decision: PolicyDecisionV1): RouteResourceObligationPlanV1 {
  let resultLimit: number | undefined, fieldMask: string[] | undefined, readOnly = false;
  for (const obligation of decision.obligations) {
    if (obligation.type === "result_limit") {
      if (!Number.isSafeInteger(obligation.maximum) || obligation.maximum < 1 || obligation.maximum > 1000) fail("invalid_descriptor");
      resultLimit = Math.min(resultLimit ?? obligation.maximum, obligation.maximum);
    } else if (obligation.type === "field_mask") {
      if (!Array.isArray(obligation.fields) || obligation.fields.length === 0 || obligation.fields.some((field) => typeof field !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(field))) fail("invalid_descriptor");
      const next = [...new Set(obligation.fields)].sort();
      fieldMask = fieldMask === undefined ? next : fieldMask.filter((field) => next.includes(field));
      if (fieldMask.length === 0) fail("invalid_descriptor");
    } else if (obligation.type === "read_only" && obligation.required === true) readOnly = true;
    else fail("invalid_descriptor");
  }
  const redactions = decision.redactions.map((entry) => ({ ...entry, jsonPaths: [...new Set(entry.jsonPaths)].sort() }));
  return deepFreeze({ schemaVersion: 1, ...(resultLimit === undefined ? {} : { resultLimit }), ...(fieldMask === undefined ? {} : { fieldMask }), readOnly, redactions });
}

export function composeRouteResourceObligations(route: RouteResourceObligationPlanV1, resource: RouteResourceObligationPlanV1): RouteResourceObligationPlanV1 {
  const limits = [route.resultLimit, resource.resultLimit].filter((value): value is number => value !== undefined);
  const fieldMask = route.fieldMask === undefined ? resource.fieldMask : resource.fieldMask === undefined ? route.fieldMask : route.fieldMask.filter((field) => resource.fieldMask!.includes(field));
  if (fieldMask !== undefined && fieldMask.length === 0) fail("invalid_descriptor");
  const redactions = [...route.redactions, ...resource.redactions].filter((entry, index, all) => all.findIndex((candidate) => canonicalAuthorizationJson(candidate) === canonicalAuthorizationJson(entry)) === index);
  return deepFreeze({ schemaVersion: 1, ...(limits.length ? { resultLimit: Math.min(...limits) } : {}), ...(fieldMask === undefined ? {} : { fieldMask }), readOnly: route.readOnly || resource.readOnly, redactions });
}
