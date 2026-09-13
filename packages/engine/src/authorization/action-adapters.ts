import {
  authorizationIdentity,
  canonicalAuthorizationJson,
  interactiveAuthorizationSubject,
  workflowAuthorizationSubject,
} from "./identity.js";
import type {
  AuthorizationPrincipal,
  AuthorizationRequest,
  JsonObject,
  JsonValue,
} from "./types.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const ACTION = /^[a-z][a-z0-9_-]*\.[a-z0-9][a-z0-9_.:-]*$/;
const SERVICE = /^[a-z][a-z0-9_-]*$/;
const RISKS = new Set(["low", "medium", "high", "critical"]);
const MAX_PARAMETER_BYTES = 65_536;
const MAX_VALUE_DEPTH = 32;
const MAX_VALUE_NODES = 4_096;

export type ActionAdapterErrorCode =
  | "invalid_shape" | "invalid_identity" | "identity_conflict" | "cross_scope"
  | "invalid_action" | "unknown_risk" | "unsafe_parameters" | "invalid_facts";

export class ActionAdapterError extends TypeError {
  constructor(readonly code: ActionAdapterErrorCode) {
    super(`Canonical action adapter rejected the input (${code}).`);
    this.name = "ActionAdapterError";
  }
}

export interface SafeParameterProjectionV1 {
  readonly schemaVersion: 1;
  /** RFC 6901 pointers to caller-visible, non-secret values. An empty string explicitly selects the complete input. */
  readonly safePaths: readonly string[];
}

interface ActionInput {
  readonly service: string;
  readonly actionId: string;
  readonly catalogActionId: string;
  readonly sourcePluginService: string;
  readonly sourceActionId: string;
  readonly sourceToolId: string;
  readonly riskLevel: string;
  readonly parameters: unknown;
  readonly parameterProjection: SafeParameterProjectionV1;
}

interface CommonInput {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly actor: { readonly type: "user"; readonly id: string };
  readonly owner: AuthorizationPrincipal;
  readonly teamId?: string;
  readonly requestId: string;
  readonly action: ActionInput;
  readonly evaluationTimeMs: number;
  readonly dynamicFacts: unknown;
}

export interface InteractiveActionAdapterInputV1 extends CommonInput {
  readonly sessionId: string;
  readonly threadId: string;
  readonly queueItemId: string;
  readonly resumeKey: string;
  readonly gateOrdinal: number;
}

export interface WorkflowActionAdapterInputV1 extends CommonInput {
  readonly workflowDefinitionId: string;
  readonly workflowVersion: string;
  readonly workflowExecutionId: string;
  readonly nodeId: string;
  readonly invocationId: string;
}

export interface ActionAdapterOutputV1 {
  readonly schemaVersion: 1;
  readonly request: AuthorizationRequest;
  readonly canonicalBytes: string;
  readonly requestSubjectDigest: string;
}

export function adaptInteractiveAction(input: InteractiveActionAdapterInputV1): ActionAdapterOutputV1 {
  exact(input, ["schemaVersion", "organizationId", "actor", "owner", "teamId", "requestId", "action", "evaluationTimeMs", "dynamicFacts", "sessionId", "threadId", "queueItemId", "resumeKey", "gateOrdinal"]);
  common(input);
  for (const value of [input.sessionId, input.threadId, input.queueItemId]) validId(value);
  if (typeof input.resumeKey !== "string" || input.resumeKey.length === 0 || input.resumeKey.length > 512 || /[\u0000-\u001f\u007f]/.test(input.resumeKey)) fail("invalid_identity");
  if (!Number.isSafeInteger(input.gateOrdinal) || input.gateOrdinal < 0) fail("invalid_identity");
  const subject = interactiveAuthorizationSubject({ orgId: input.organizationId, principal: input.owner, actorUserId: input.actor.id, sessionId: input.sessionId, threadId: input.threadId, queueItemId: input.queueItemId, resumeKey: input.resumeKey, gateOrdinal: input.gateOrdinal });
  return output(input, "tool.action", subject, { appliesIn: "session" });
}

export function adaptWorkflowAction(input: WorkflowActionAdapterInputV1): ActionAdapterOutputV1 {
  exact(input, ["schemaVersion", "organizationId", "actor", "owner", "teamId", "requestId", "action", "evaluationTimeMs", "dynamicFacts", "workflowDefinitionId", "workflowVersion", "workflowExecutionId", "nodeId", "invocationId"]);
  common(input);
  for (const value of [input.workflowDefinitionId, input.workflowVersion, input.workflowExecutionId, input.nodeId, input.invocationId]) validId(value);
  const subject = workflowAuthorizationSubject({ orgId: input.organizationId, principal: input.owner, actorUserId: input.actor.id, workflowExecutionId: input.workflowExecutionId, workflowNodeId: input.nodeId, invocationId: input.invocationId });
  return output(input, "workflow.action", subject, { appliesIn: "workflow", workflowDefinitionId: input.workflowDefinitionId, workflowVersion: input.workflowVersion });
}

function common(input: CommonInput): void {
  if (input.schemaVersion !== 1) fail("invalid_shape");
  exact(input.actor, ["type", "id"]); exact(input.owner, ["type", "id"]); exact(input.action, ["service", "actionId", "catalogActionId", "sourcePluginService", "sourceActionId", "sourceToolId", "riskLevel", "parameters", "parameterProjection"]);
  validId(input.organizationId); validId(input.actor.id); validId(input.owner.id); validId(input.requestId);
  if (input.actor.type !== "user" || !["user", "team", "org"].includes(input.owner.type)) fail("invalid_identity");
  if (input.owner.type === "user" && input.owner.id !== input.actor.id) fail("identity_conflict");
  if (input.owner.type === "org" && input.owner.id !== input.organizationId) fail("cross_scope");
  if ((input.owner.type === "team") !== (input.teamId !== undefined) || (input.teamId && input.teamId !== input.owner.id)) fail("cross_scope");
  action(input.action);
  if (!Number.isSafeInteger(input.evaluationTimeMs) || input.evaluationTimeMs < 0) fail("invalid_facts");
  json(input.dynamicFacts, "invalid_facts");
  if (!plainObject(input.dynamicFacts)) fail("invalid_facts");
}

function action(input: ActionInput): void {
  if (!SERVICE.test(input.service) || !ACTION.test(input.actionId)) fail("invalid_action");
  if (input.actionId.slice(0, input.actionId.indexOf(".")) !== input.service || input.catalogActionId !== input.actionId || input.sourcePluginService !== input.service || input.sourceActionId !== input.actionId || typeof input.sourceToolId !== "string" || !ID.test(input.sourceToolId)) fail("invalid_action");
  if (!RISKS.has(input.riskLevel)) fail("unknown_risk");
  exact(input.parameterProjection, ["schemaVersion", "safePaths"]);
  if (input.parameterProjection.schemaVersion !== 1 || !Array.isArray(input.parameterProjection.safePaths)) fail("unsafe_parameters");
}

function output(input: CommonInput, kind: "tool.action" | "workflow.action", subject: AuthorizationRequest["subject"], extraContext: JsonObject): ActionAdapterOutputV1 {
  const parameters = project(input.action.parameters, input.action.parameterProjection);
  const action = deepFreeze({ id: input.action.actionId, service: input.action.service, riskLevel: input.action.riskLevel, parameters });
  const facts = deepFreeze(canonicalClone(input.dynamicFacts) as JsonObject);
  const context = deepFreeze({ schemaVersion: 1, evaluationTimeMs: input.evaluationTimeMs, sourcePluginService: input.action.sourcePluginService, sourceActionId: input.action.sourceActionId, sourceToolId: input.action.sourceToolId, ...extraContext });
  const partial = { schemaVersion: 1 as const, requestId: input.requestId, kind, subject: deepFreeze(subject), action, context, facts };
  const identity = authorizationIdentity(partial);
  const request = deepFreeze({ ...partial, idempotencyKey: identity.idempotencyKey });
  return deepFreeze({ schemaVersion: 1, request, canonicalBytes: canonicalAuthorizationJson(request), requestSubjectDigest: identity.requestSubjectDigest });
}

function project(value: unknown, projection: SafeParameterProjectionV1): JsonObject {
  try {
    if (projection.safePaths.length === 0) return {};
    if (new Set(projection.safePaths).size !== projection.safePaths.length) fail("unsafe_parameters");
    if (projection.safePaths.includes("")) {
      if (projection.safePaths.length !== 1) fail("unsafe_parameters");
      json(value, "unsafe_parameters");
      if (!plainObject(value)) fail("unsafe_parameters");
      const cloned = canonicalClone(value) as JsonObject;
      if (new TextEncoder().encode(canonicalAuthorizationJson(cloned)).length > MAX_PARAMETER_BYTES) fail("unsafe_parameters");
      return cloned;
    }
    const paths = projection.safePaths.map(pointerParts);
    if (paths.some((path) => path.length === 0)) fail("unsafe_parameters");
    const result = projectNode(value, paths);
    json(result, "unsafe_parameters");
    if (!plainObject(result) || new TextEncoder().encode(canonicalAuthorizationJson(result)).length > MAX_PARAMETER_BYTES) fail("unsafe_parameters");
    return canonicalClone(result) as JsonObject;
  } catch (error) {
    if (error instanceof ActionAdapterError) throw error;
    fail("unsafe_parameters");
  }
}

function projectNode(value: unknown, paths: string[][]): JsonValue {
  if (paths.some((path) => path.length === 0)) { json(value, "unsafe_parameters"); return canonicalClone(value); }
  if (typeof value !== "object" || value === null) fail("unsafe_parameters");
  if (Array.isArray(value)) {
    if (paths.some((path) => path[0] !== "*")) fail("unsafe_parameters");
    return value.map((item) => projectNode(item, paths.map((path) => path.slice(1))));
  }
  if (!plainObject(value)) fail("unsafe_parameters");
  const result: Record<string, JsonValue> = Object.create(null);
  for (const key of [...new Set(paths.map((path) => path[0]))].sort()) {
    if (!key || key === "*" || ["__proto__", "prototype", "constructor"].includes(key)) fail("unsafe_parameters");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set || !("value" in descriptor)) fail("unsafe_parameters");
    result[key] = projectNode(descriptor.value, paths.filter((path) => path[0] === key).map((path) => path.slice(1)));
  }
  return result;
}

function pointerParts(pointer: string): string[] {
  if (!pointer.startsWith("/") || pointer.length > 512) fail("unsafe_parameters");
  return pointer.slice(1).split("/").map((part) => {
    if (/~(?![01])/.test(part)) fail("unsafe_parameters");
    return part.replace(/~1/g, "/").replace(/~0/g, "~");
  });
}

function json(value: unknown, code: "unsafe_parameters" | "invalid_facts"): void {
  const seen = new WeakSet<object>(); let nodes = 0;
  const walk = (item: unknown, depth: number): void => {
    if (++nodes > MAX_VALUE_NODES || depth > MAX_VALUE_DEPTH) fail(code);
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item) && !Object.is(item, -0)) return;
    if (typeof item !== "object" || seen.has(item)) fail(code);
    seen.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") || Object.values(descriptors).some((d) => d.get || d.set)) fail(code);
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) fail(code);
      for (const [key, descriptor] of Object.entries(descriptors)) if (key !== "length") walk(descriptor.value, depth + 1);
    } else {
      if (!plainObject(item)) fail(code);
      for (const descriptor of Object.values(descriptors)) walk(descriptor.value, depth + 1);
    }
  };
  try { walk(value, 1); structuredClone(value); } catch (error) { if (error instanceof ActionAdapterError) throw error; fail(code); }
}

function canonicalClone(value: unknown): JsonValue { return JSON.parse(canonicalAuthorizationJson(value)) as JsonValue; }
function plainObject(value: unknown): value is Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) return false; const proto = Object.getPrototypeOf(value); return proto === Object.prototype || proto === null; }
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> { if (!plainObject(value) || Object.keys(value).some((key) => !keys.includes(key))) fail("invalid_shape"); }
function validId(value: unknown): asserts value is string { if (typeof value !== "string" || !ID.test(value)) fail("invalid_identity"); }
function fail(code: ActionAdapterErrorCode): never { throw new ActionAdapterError(code); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); } return value; }
