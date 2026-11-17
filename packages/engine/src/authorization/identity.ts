import type {
  AuthorizationAction,
  AuthorizationIdentity,
  AuthorizationKind,
  AuthorizationPrincipal,
  AuthorizationRequest,
  AuthorizationResource,
  AuthorizationSubject,
} from "./types.js";

// Stable identities for authorization requests. A replay of the same
// operation after a restart produces the same idempotency key and subject
// digest. A change to the action, its parameters, or the resource changes
// the subject digest, so an approval for one request cannot cover another.

/** JSON with object keys sorted and undefined properties omitted. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Authorization identity values must contain finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("Authorization identity values must contain only JSON values.");
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

/** Hex SHA-256 of the canonical JSON form. WebCrypto keeps it usable in Node and the browser. */
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface RequestIdentityInput {
  kind: AuthorizationKind;
  idempotencyKey: string;
  subject: AuthorizationSubject;
  action: AuthorizationAction;
  resource?: AuthorizationResource;
}

export function requestSubjectDigest(input: RequestIdentityInput): Promise<string> {
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

export interface OperationAuthorizationIdentityInput extends CommonIdentityInput {
  operationId: string;
  sessionId?: string;
}

function baseSubject(input: CommonIdentityInput, invocation: AuthorizationSubject["invocation"]): AuthorizationSubject {
  return {
    orgId: input.orgId,
    principal: input.principal,
    invocation,
    ...(input.actorUserId === undefined ? {} : { actorUserId: input.actorUserId }),
  };
}

/** An interactive tool call has no stored invocation row, so its id is a digest of where the call sits in the thread. */
export async function interactiveAuthorizationSubject(
  input: InteractiveAuthorizationIdentityInput,
): Promise<AuthorizationSubject> {
  const invocationId = await digest({
    sessionId: input.sessionId,
    threadId: input.threadId,
    queueItemId: input.queueItemId,
    resumeKey: input.resumeKey,
    gateOrdinal: input.gateOrdinal,
  });
  return {
    ...baseSubject(input, { type: "interactive", id: invocationId }),
    sessionId: input.sessionId,
    threadId: input.threadId,
  };
}

export function workflowAuthorizationSubject(input: WorkflowAuthorizationIdentityInput): AuthorizationSubject {
  return {
    ...baseSubject(input, { type: "workflow", id: input.invocationId }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    workflowExecutionId: input.workflowExecutionId,
    workflowNodeId: input.workflowNodeId,
  };
}

export function routeAuthorizationSubject(input: OperationAuthorizationIdentityInput): AuthorizationSubject {
  return {
    ...baseSubject(input, { type: "route", id: input.operationId }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
  };
}

export function resourceAuthorizationSubject(input: OperationAuthorizationIdentityInput): AuthorizationSubject {
  return {
    ...baseSubject(input, { type: "resource", id: input.operationId }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
  };
}

export async function authorizationIdentity(
  request: Pick<AuthorizationRequest, "kind" | "subject" | "action" | "resource">,
): Promise<AuthorizationIdentity> {
  const idempotencyKey = `${request.subject.invocation.type}:${request.subject.invocation.id}`;
  return {
    idempotencyKey,
    requestSubjectDigest: await requestSubjectDigest({ ...request, idempotencyKey }),
  };
}
