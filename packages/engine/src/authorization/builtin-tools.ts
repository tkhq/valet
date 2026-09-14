import type { RiskLevel } from "../types.js";
import { authorizationIdentity, authorizationSha256Hex, canonicalAuthorizationJson, interactiveAuthorizationSubject } from "./identity.js";
import { trustedJsonClone } from "./trusted-json.js";
import type { AuthorizationPrincipal, AuthorizationRequest, JsonObject, JsonValue } from "./types.js";

export type BuiltinCapability = "file.read" | "file.write" | "process.execute" | "approval.request" | "thread.read" | "thread.write" | "child.manage" | "model.switch" | "integration.wrapper" | "memory.read" | "memory.write" | "skill.read" | "security.read" | "security.write";

export interface BuiltinAuthorizationDescriptorV1 {
  readonly schemaVersion: 1;
  readonly actionId: `builtin.${string}`;
  readonly capability: BuiltinCapability;
  readonly riskLevel: RiskLevel;
  readonly projection: { readonly schemaVersion: 1; readonly pointers: readonly string[] };
  readonly obligations: readonly ("target_idempotency" | "sandbox_capabilities")[];
  readonly redactions: readonly ("audit" | "user_output")[];
  readonly audit: { readonly result: "bounded"; readonly replay: "at_most_once" };
  /** Content-bearing outputs are never persisted and cannot be replayed. */
  readonly replay: { readonly result: "output_unavailable" };
}

type RegistryRow = Omit<BuiltinAuthorizationDescriptorV1, "schemaVersion" | "actionId" | "projection" | "obligations" | "redactions" | "audit" | "replay"> & { pointers?: readonly string[] };
const rows: Record<string, RegistryRow> = {
  read: { capability: "file.read", riskLevel: "low", pointers: ["/path"] },
  write: { capability: "file.write", riskLevel: "medium", pointers: ["/path"] },
  edit: { capability: "file.write", riskLevel: "medium", pointers: ["/path"] },
  bash: { capability: "process.execute", riskLevel: "high", pointers: ["/timeout"] },
  thread_read: { capability: "thread.read", riskLevel: "low", pointers: ["/key", "/limit", "/includeCompacted"] },
  list_threads: { capability: "thread.read", riskLevel: "low" },
  switch_model: { capability: "model.switch", riskLevel: "medium", pointers: ["/model"] },
  ask_approval: { capability: "approval.request", riskLevel: "low" },
  task: { capability: "child.manage", riskLevel: "high", pointers: ["/repo", "/branch", "/model", "/resources/cpu", "/resources/memory", "/profile", "/docker"] },
  child_read: { capability: "thread.read", riskLevel: "low", pointers: ["/child_session_id", "/limit"] },
  child_send: { capability: "thread.write", riskLevel: "medium", pointers: ["/child_session_id", "/interrupt"] },
  child_status: { capability: "thread.read", riskLevel: "low", pointers: ["/child_session_id"] },
  list_tools: { capability: "integration.wrapper", riskLevel: "low", pointers: ["/service", "/limit"] },
  call_tool: { capability: "integration.wrapper", riskLevel: "low", pointers: ["/tool_id", "/summary"] },
  skill: { capability: "skill.read", riskLevel: "low", pointers: ["/name"] },
  mem_write: { capability: "memory.write", riskLevel: "medium", pointers: ["/path"] }, mem_patch: { capability: "memory.write", riskLevel: "medium", pointers: ["/path"] },
  mem_read: { capability: "memory.read", riskLevel: "low", pointers: ["/path"] }, mem_search: { capability: "memory.read", riskLevel: "low" },
  mem_move: { capability: "memory.write", riskLevel: "medium", pointers: ["/from", "/to"] }, mem_copy_to_team: { capability: "memory.write", riskLevel: "high", pointers: ["/path", "/teamId"] }, mem_copy_from_team: { capability: "memory.write", riskLevel: "high", pointers: ["/path", "/teamId"] }, artifact_copy_to_team: { capability: "memory.write", riskLevel: "high" },
  mem_links: { capability: "memory.read", riskLevel: "low", pointers: ["/path"] }, mem_share: { capability: "memory.write", riskLevel: "high", pointers: ["/path"] }, artifact_publish: { capability: "memory.write", riskLevel: "high" }, mem_rm: { capability: "memory.write", riskLevel: "high", pointers: ["/path"] },
};
for (const name of ["sec_status", "sec_wait", "sec_fs_read", "sec_fs_list", "sec_protocol_read", "sec_findings_list"] as const) rows[name] = { capability: "security.read", riskLevel: "low" };
for (const name of ["sec_plan_set", "sec_dispatch", "sec_cell_complete", "sec_cell_fail", "sec_handoff", "sec_fs_write", "sec_finding_report", "sec_finding_review", "sec_coverage_report", "sec_report_write", "sec_need_report"] as const) rows[name] = { capability: "security.write", riskLevel: "medium" };
for (const name of ["sec_start", "sec_close"] as const) rows[name] = { capability: "security.write", riskLevel: "high" };

export const BUILTIN_TOOL_NAMES = Object.freeze(Object.keys(rows).sort());

export function builtinAuthorizationFor(name: string): BuiltinAuthorizationDescriptorV1 | undefined { return rows[name] ? builtinAuthorization(name) : undefined; }

export function builtinAuthorization(name: string, overrides?: Partial<Pick<BuiltinAuthorizationDescriptorV1, "actionId" | "riskLevel">>): BuiltinAuthorizationDescriptorV1 {
  const row = rows[name];
  if (!row) throw new TypeError(`Built-in tool ${JSON.stringify(name)} has no canonical authorization metadata. Register it before exposing the tool.`);
  return Object.freeze({ schemaVersion: 1, actionId: overrides?.actionId ?? `builtin.${name}`, capability: row.capability, riskLevel: overrides?.riskLevel ?? row.riskLevel, projection: Object.freeze({ schemaVersion: 1, pointers: Object.freeze([...(row.pointers ?? [])]) }), obligations: Object.freeze(["target_idempotency", "sandbox_capabilities"] as const), redactions: Object.freeze(["audit", "user_output"] as const), audit: Object.freeze({ result: "bounded", replay: "at_most_once" }), replay: Object.freeze({ result: "output_unavailable" }) });
}

export function registerBuiltinAlias(name: string, descriptor: BuiltinAuthorizationDescriptorV1): void {
  if (rows[name]) throw new TypeError(`Built-in tool ${JSON.stringify(name)} is already registered.`);
  rows[name] = { capability: descriptor.capability, riskLevel: descriptor.riskLevel, pointers: descriptor.projection.pointers };
}

export interface InteractiveBuiltinAdapterInputV1 {
  readonly schemaVersion: 1; readonly organizationId: string; readonly actor: { readonly type: "user"; readonly id: string }; readonly owner: AuthorizationPrincipal;
  readonly requestId: string; readonly sessionId: string; readonly threadId: string; readonly queueItemId: string; readonly toolCallId: string; readonly gateOrdinal: number;
  readonly descriptor: BuiltinAuthorizationDescriptorV1; readonly arguments: unknown; readonly evaluationTimeMs: number; readonly facts?: JsonObject;
}

export function adaptInteractiveBuiltin(input: InteractiveBuiltinAdapterInputV1): AuthorizationRequest {
  if (input.schemaVersion !== 1 || !input.organizationId || !input.actor.id || !input.requestId || !input.sessionId || !input.threadId || !input.queueItemId || !input.toolCallId || !Number.isSafeInteger(input.gateOrdinal) || input.gateOrdinal < 0) throw new TypeError("Canonical built-in adapter rejected incomplete identity.");
  const parameters = projectBuiltinArguments(input.arguments, input.descriptor.projection.pointers);
  const invocationId = authorizationSha256Hex(canonicalAuthorizationJson({ queueItemId: input.queueItemId, toolCallId: input.toolCallId, gateOrdinal: input.gateOrdinal }));
  const subject = interactiveAuthorizationSubject({ orgId: input.organizationId, principal: input.owner, actorUserId: input.actor.id, sessionId: input.sessionId, threadId: input.threadId, queueItemId: invocationId, resumeKey: input.descriptor.actionId, gateOrdinal: input.gateOrdinal });
  const partial = { schemaVersion: 1 as const, requestId: input.requestId, kind: "tool.builtin" as const, subject, action: { id: input.descriptor.actionId, service: "builtin", riskLevel: input.descriptor.riskLevel, parameters }, context: { schemaVersion: 1, evaluationTimeMs: input.evaluationTimeMs, capability: input.descriptor.capability, projectionVersion: input.descriptor.projection.schemaVersion }, facts: input.facts ?? {} };
  return Object.freeze({ ...partial, idempotencyKey: authorizationIdentity(partial).idempotencyKey });
}

export function projectBuiltinArguments(value: unknown, pointers: readonly string[]): JsonObject {
  const source = trustedJsonClone(value);
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new TypeError("Built-in tool arguments must be an object.");
  const output: Record<string, JsonValue> = Object.create(null);
  for (const pointer of pointers) {
    const parts = pointer.slice(1).split("/");
    if (!pointer.startsWith("/") || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) throw new TypeError("Built-in projection contains an invalid pointer.");
    let current: unknown = source;
    for (const part of parts) { if (!current || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, part)) { current = undefined; break; } current = (current as Record<string, unknown>)[part]; }
    if (current === undefined) continue;
    let target: Record<string, JsonValue> = output;
    for (const [index, part] of parts.entries()) { if (index === parts.length - 1) target[part] = trustedJsonClone(current) as JsonValue; else { const next = target[part]; if (!next || typeof next !== "object" || Array.isArray(next)) target[part] = {}; target = target[part] as Record<string, JsonValue>; } }
  }
  if (new TextEncoder().encode(canonicalAuthorizationJson(output)).length > 16_384) throw new TypeError("Built-in safe projection exceeds 16 KiB.");
  return output;
}
