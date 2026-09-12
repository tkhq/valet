import type {
  AuthorizationAction,
  AuthorizationIdentity,
  AuthorizationKind,
  AuthorizationPrincipal,
  AuthorizationRequest,
  AuthorizationResource,
  AuthorizationSubject,
} from "./types.js";

const SHA256_INITIAL: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const SHA256_ROUND: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = bytes.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const state = [...SHA256_INITIAL];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index++) {
      const left = words[index - 15];
      const right = words[index - 2];
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index++) {
      const choice = (e & f) ^ (~e & g);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const temporary1 = (h + sigma1 + choice + SHA256_ROUND[index] + words[index]) >>> 0;
      const temporary2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  return state.map((word) => word.toString(16).padStart(8, "0")).join("");
}

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
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
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
