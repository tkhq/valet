import { authorizationIdentity, canonicalAuthorizationJson, interactiveAuthorizationSubject, workflowAuthorizationSubject } from "./identity.js";
import { validateCurrentPolicyDynamicFactsV2, type CurrentPolicyDynamicFactsV2 } from "./current-policy-facts.js";
import { trustedJsonClone } from "./trusted-json.js";
import type { AuthorizationPrincipal, AuthorizationRequest, JsonObject, JsonValue } from "./types.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const ACTION = /^[a-z][a-z0-9_-]*\.[a-z0-9][a-z0-9_.:-]*$/;
const SERVICE = /^[a-z][a-z0-9_-]*$/;
const RISKS = new Set(["low", "medium", "high", "critical"]);
const MAX_PARAMETER_BYTES = 65_536;
const MISSING = Symbol("missing");

export type ActionAdapterErrorCode = "invalid_shape" | "invalid_identity" | "identity_conflict" | "cross_scope" | "invalid_action" | "unknown_risk" | "unsafe_parameters" | "invalid_facts";
export class ActionAdapterError extends TypeError {
  constructor(readonly code: ActionAdapterErrorCode) { super(`Canonical action adapter rejected the input (${code}).`); this.name = "ActionAdapterError"; }
}

export type SafeParameterProjectionV1 =
  | { readonly schemaVersion: 1; readonly mode: "all_safe" }
  | { readonly schemaVersion: 1; readonly mode: "none" }
  | { readonly schemaVersion: 1; readonly mode: "selected"; readonly paths: readonly { readonly pointer: string; readonly required: boolean }[] };

interface ActionInput {
  readonly service: string; readonly actionId: string; readonly catalogActionId: string;
  readonly sourcePluginService: string; readonly sourceActionId: string; readonly sourceToolId: string;
  readonly riskLevel: string; readonly parameters: unknown; readonly parameterProjection: SafeParameterProjectionV1;
}
interface CommonInput {
  readonly schemaVersion: 1; readonly organizationId: string; readonly actor: { readonly type: "user"; readonly id: string };
  readonly owner: AuthorizationPrincipal; readonly teamId?: string; readonly requestId: string; readonly action: ActionInput;
  readonly evaluationTimeMs: number; readonly dynamicFacts: { readonly currentPolicy?: CurrentPolicyDynamicFactsV2 };
  readonly approvalBindingContext?: { readonly requestSubjectDigest: string; readonly originalDecisionDigest: string };
}
export interface InteractiveActionAdapterInputV1 extends CommonInput { readonly sessionId: string; readonly threadId: string; readonly queueItemId: string; readonly resumeKey: string; readonly gateOrdinal: number }
export interface WorkflowActionAdapterInputV1 extends CommonInput { readonly workflowDefinitionId: string; readonly workflowVersion: string; readonly workflowExecutionId: string; readonly nodeId: string; readonly invocationId: string }
export interface ActionAdapterOutputV1 { readonly schemaVersion: 1; readonly request: AuthorizationRequest; readonly canonicalBytes: string; readonly requestSubjectDigest: string }

export function adaptInteractiveAction(input: InteractiveActionAdapterInputV1): ActionAdapterOutputV1 {
  exact(input, ["schemaVersion", "organizationId", "actor", "owner", "teamId", "requestId", "action", "evaluationTimeMs", "dynamicFacts", "approvalBindingContext", "sessionId", "threadId", "queueItemId", "resumeKey", "gateOrdinal"]);
  common(input);
  for (const value of [input.sessionId, input.threadId, input.queueItemId]) validId(value);
  if (typeof input.resumeKey !== "string" || input.resumeKey.length === 0 || input.resumeKey.length > 512 || /[\u0000-\u001f\u007f]/.test(input.resumeKey) || !Number.isSafeInteger(input.gateOrdinal) || input.gateOrdinal < 0) fail("invalid_identity");
  const subject = interactiveAuthorizationSubject({ orgId: input.organizationId, principal: input.owner, actorUserId: input.actor.id, sessionId: input.sessionId, threadId: input.threadId, queueItemId: input.queueItemId, resumeKey: input.resumeKey, gateOrdinal: input.gateOrdinal });
  return output(input, "tool.action", subject, "session", input.sessionId, { appliesIn: "session" });
}

export function adaptWorkflowAction(input: WorkflowActionAdapterInputV1): ActionAdapterOutputV1 {
  exact(input, ["schemaVersion", "organizationId", "actor", "owner", "teamId", "requestId", "action", "evaluationTimeMs", "dynamicFacts", "approvalBindingContext", "workflowDefinitionId", "workflowVersion", "workflowExecutionId", "nodeId", "invocationId"]);
  common(input);
  for (const value of [input.workflowDefinitionId, input.workflowVersion, input.workflowExecutionId, input.nodeId, input.invocationId]) validId(value);
  const subject = workflowAuthorizationSubject({ orgId: input.organizationId, principal: input.owner, actorUserId: input.actor.id, workflowExecutionId: input.workflowExecutionId, workflowNodeId: input.nodeId, invocationId: input.invocationId });
  return output(input, "workflow.action", subject, "workflow", input.workflowExecutionId, { appliesIn: "workflow", workflowDefinitionId: input.workflowDefinitionId, workflowVersion: input.workflowVersion });
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
  exact(input.dynamicFacts, ["currentPolicy"]);
  if (input.approvalBindingContext !== undefined) { exact(input.approvalBindingContext, ["requestSubjectDigest", "originalDecisionDigest"]); if (!hex(input.approvalBindingContext.requestSubjectDigest) || !hex(input.approvalBindingContext.originalDecisionDigest)) fail("invalid_facts"); }
}

function action(input: ActionInput): void {
  if (typeof input.service !== "string" || typeof input.actionId !== "string" || !SERVICE.test(input.service) || !ACTION.test(input.actionId)) fail("invalid_action");
  if (input.actionId.slice(0, input.actionId.indexOf(".")) !== input.service || input.catalogActionId !== input.actionId || input.sourcePluginService !== input.service || input.sourceActionId !== input.actionId || typeof input.sourceToolId !== "string" || !ID.test(input.sourceToolId)) fail("invalid_action");
  if (typeof input.riskLevel !== "string" || !RISKS.has(input.riskLevel)) fail("unknown_risk");
  const projection = input.parameterProjection;
  if (!plainObject(projection) || projection.schemaVersion !== 1 || typeof projection.mode !== "string" || !["all_safe", "none", "selected"].includes(projection.mode)) fail("unsafe_parameters");
  exact(projection, projection.mode === "selected" ? ["schemaVersion", "mode", "paths"] : ["schemaVersion", "mode"]);
  if (projection.mode === "selected" && (!Array.isArray(projection.paths) || projection.paths.length === 0)) fail("unsafe_parameters");
}

function output(input: CommonInput, kind: "tool.action" | "workflow.action", subject: AuthorizationRequest["subject"], appliesIn: "session" | "workflow", scopeId: string, extraContext: JsonObject): ActionAdapterOutputV1 {
  const parameters = project(input.action.parameters, input.action.parameterProjection);
  let currentPolicy: CurrentPolicyDynamicFactsV2 | undefined;
  try {
    if (input.dynamicFacts.currentPolicy !== undefined) currentPolicy = validateCurrentPolicyDynamicFactsV2(input.dynamicFacts.currentPolicy, { organizationId: input.organizationId, service: input.action.service, actionId: input.action.actionId, riskLevel: input.action.riskLevel as "low" | "medium" | "high" | "critical", appliesIn, scopeId, evaluationTimeMs: input.evaluationTimeMs, ...input.approvalBindingContext });
  } catch { fail("invalid_facts"); }
  const suppliedProjection = trustedJsonClone(input.action.parameterProjection);
  const projection: JsonObject = suppliedProjection.mode === "selected" ? { schemaVersion: 1, mode: "selected", paths: suppliedProjection.paths.map((entry) => ({ pointer: entry.pointer, required: entry.required })) } : { schemaVersion: 1, mode: suppliedProjection.mode };
  const action = deepFreeze({ id: input.action.actionId, service: input.action.service, riskLevel: input.action.riskLevel, parameters });
  const facts: JsonObject = currentPolicy === undefined ? {} : { currentPolicy };
  deepFreeze(facts);
  const context = deepFreeze({ schemaVersion: 1, evaluationTimeMs: input.evaluationTimeMs, parameterProjection: projection, sourcePluginService: input.action.sourcePluginService, sourceActionId: input.action.sourceActionId, sourceToolId: input.action.sourceToolId, ...input.approvalBindingContext, ...extraContext });
  const partial = { schemaVersion: 1 as const, requestId: input.requestId, kind, subject: deepFreeze(subject), action, context, facts };
  const identity = authorizationIdentity(partial);
  const request = deepFreeze({ ...partial, idempotencyKey: identity.idempotencyKey });
  return deepFreeze({ schemaVersion: 1, request, canonicalBytes: canonicalAuthorizationJson(request), requestSubjectDigest: identity.requestSubjectDigest });
}

type Path = { parts: string[]; required: boolean };
function project(value: unknown, projection: SafeParameterProjectionV1): JsonObject {
  try {
    if (projection.mode === "none") return {};
    if (projection.mode === "all_safe") { const clone = trustedJsonClone(value); if (!plainObject(clone)) fail("unsafe_parameters"); return bounded(clone); }
    const identities = new Set<string>();
    const paths = projection.paths.map((entry): Path => {
      exact(entry, ["pointer", "required"]);
      if (typeof entry.pointer !== "string" || typeof entry.required !== "boolean") fail("unsafe_parameters");
      const parts = pointerParts(entry.pointer); if (parts.length === 0) fail("unsafe_parameters");
      if (identities.has(entry.pointer)) fail("unsafe_parameters"); identities.add(entry.pointer);
      return { parts, required: entry.required };
    });
    const result = projectNode(trustedJsonClone(value), paths);
    if (result === MISSING || !plainObject(result)) fail("unsafe_parameters");
    return bounded(result);
  } catch (error) { if (error instanceof ActionAdapterError) throw error; fail("unsafe_parameters"); }
}

function projectNode(value: unknown, paths: Path[]): JsonValue | typeof MISSING {
  if (paths.some((path) => path.parts.length === 0)) return trustedJsonClone(value) as JsonValue;
  if (typeof value !== "object" || value === null) return paths.some((path) => path.required) ? fail("unsafe_parameters") : MISSING;
  if (Array.isArray(value)) {
    if (paths.some((path) => path.parts[0] !== "*")) fail("unsafe_parameters");
    return value.map((item) => { const projected = projectNode(item, paths.map((path) => ({ ...path, parts: path.parts.slice(1) }))); return projected === MISSING ? {} : projected; });
  }
  if (!plainObject(value)) fail("unsafe_parameters");
  const result: Record<string, JsonValue> = Object.create(null);
  for (const key of [...new Set(paths.map((path) => path.parts[0]))].sort()) {
    if (!key || key === "*" || ["__proto__", "prototype", "constructor"].includes(key)) fail("unsafe_parameters");
    const selected = paths.filter((path) => path.parts[0] === key).map((path) => ({ ...path, parts: path.parts.slice(1) }));
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set || !("value" in descriptor)) { if (selected.some((path) => path.required)) fail("unsafe_parameters"); continue; }
    const projected = projectNode(descriptor.value, selected); if (projected !== MISSING) result[key] = projected;
  }
  return result;
}

function pointerParts(pointer: string): string[] {
  if (!pointer.startsWith("/") || pointer.length > 512) fail("unsafe_parameters");
  return pointer.slice(1).split("/").map((part) => { if (/~(?![01])/.test(part)) fail("unsafe_parameters"); return part.replace(/~1/g, "/").replace(/~0/g, "~"); });
}
function bounded(value: Record<string, unknown>): JsonObject { const clone = trustedJsonClone(value) as JsonObject; if (new TextEncoder().encode(canonicalAuthorizationJson(clone)).length > MAX_PARAMETER_BYTES) fail("unsafe_parameters"); return clone; }
function plainObject(value: unknown): value is Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) return false; const proto = Object.getPrototypeOf(value); return proto === Object.prototype || proto === null; }
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> { if (!plainObject(value) || Object.keys(value).some((key) => !keys.includes(key)) || Object.keys(value).length !== keys.filter((key) => Object.hasOwn(value, key)).length) fail("invalid_shape"); }
function validId(value: unknown): asserts value is string { if (typeof value !== "string" || !ID.test(value)) fail("invalid_identity"); }
function hex(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
function fail(code: ActionAdapterErrorCode): never { throw new ActionAdapterError(code); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); } return value; }
