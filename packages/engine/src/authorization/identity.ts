import { createHash } from "node:crypto";
import type {
  AuthorizationAction,
  AuthorizationIdentity,
  AuthorizationKind,
  AuthorizationPrincipal,
  AuthorizationRequest,
  AuthorizationResource,
  AuthorizationSubject,
} from "./types.js";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Authorization identity values must contain finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") {
    throw new TypeError("Authorization identity values must contain only JSON values.");
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

interface RequestIdentityInput {
  kind: AuthorizationKind;
  idempotencyKey: string;
  subject: AuthorizationSubject;
  action: AuthorizationAction;
  resource?: AuthorizationResource;
}

export function requestSubjectDigest(input: RequestIdentityInput): string {
  return digest({
    kind: input.kind,
    idempotencyKey: input.idempotencyKey,
    subject: input.subject,
    action: input.action,
    ...(input.resource === undefined ? {} : { resource: input.resource }),
  });
}

interface CommonIdentityInput {
  orgId: string;
  principal: AuthorizationPrincipal;
  actorUserId?: string;
}

export interface InteractiveAuthorizationIdentityInput extends CommonIdentityInput {
  sessionId: string;
  threadId: string;
  queueItemId: string;
  resumeKey: string;
  gateOrdinal: number;
}

export interface WorkflowAuthorizationIdentityInput extends CommonIdentityInput {
  workflowExecutionId: string;
  workflowNodeId: string;
  invocationId: string;
  sessionId?: string;
}

export interface RouteAuthorizationIdentityInput extends CommonIdentityInput {
  operationId: string;
  sessionId?: string;
}

export interface ResourceAuthorizationIdentityInput extends CommonIdentityInput {
  operationId: string;
  sessionId?: string;
}

function subject(input: CommonIdentityInput, invocation: AuthorizationSubject["invocation"]): AuthorizationSubject {
  return {
    orgId: input.orgId,
    principal: input.principal,
    invocation,
    ...(input.actorUserId === undefined ? {} : { actorUserId: input.actorUserId }),
  };
}

export function interactiveAuthorizationSubject(input: InteractiveAuthorizationIdentityInput): AuthorizationSubject {
  const invocationId = digest({
    sessionId: input.sessionId,
    threadId: input.threadId,
    queueItemId: input.queueItemId,
    resumeKey: input.resumeKey,
    gateOrdinal: input.gateOrdinal,
  });
  return {
    ...subject(input, { type: "interactive", id: invocationId }),
    sessionId: input.sessionId,
    threadId: input.threadId,
  };
}

export function workflowAuthorizationSubject(input: WorkflowAuthorizationIdentityInput): AuthorizationSubject {
  return {
    ...subject(input, { type: "workflow", id: input.invocationId }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    workflowExecutionId: input.workflowExecutionId,
    workflowNodeId: input.workflowNodeId,
  };
}

export function routeAuthorizationSubject(input: RouteAuthorizationIdentityInput): AuthorizationSubject {
  return {
    ...subject(input, { type: "route", id: input.operationId }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
  };
}

export function resourceAuthorizationSubject(input: ResourceAuthorizationIdentityInput): AuthorizationSubject {
  return {
    ...subject(input, { type: "resource", id: input.operationId }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
  };
}

export function authorizationIdentity(
  request: Pick<AuthorizationRequest, "kind" | "subject" | "action" | "resource">,
): AuthorizationIdentity {
  const idempotencyKey = `${request.subject.invocation.type}:${request.subject.invocation.id}`;
  return {
    idempotencyKey,
    requestSubjectDigest: requestSubjectDigest({ ...request, idempotencyKey }),
  };
}
