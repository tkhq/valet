import { authorizationIdentity, canonicalAuthorizationJson } from "./identity.js";
import { trustedJsonClone } from "./trusted-json.js";
import type { AuthorizationKind, AuthorizationPrincipal, AuthorizationRequest, JsonObject, PolicyDecisionV1, RedactionDirective } from "./types.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/;
const ACTION = /^[a-z][a-z0-9_-]*\.[a-z0-9][a-z0-9_.:-]*$/;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RISKS = new Set(["low", "medium", "high", "critical"]);

export const DELEGATED_EXECUTION_KINDS = ["delegation.create", "agent.signal", "sandbox.capability", "credential.use", "credential.delegate", "egress.connect"] as const;
export type DelegatedExecutionKind = (typeof DELEGATED_EXECUTION_KINDS)[number];

export const DELEGATION_ACTIONS = ["delegation.create"] as const;
export const AGENT_SIGNAL_ACTIONS = ["agent.interrupt", "agent.queue", "agent.steer", "agent.cancel", "agent.status", "agent.read", "agent.approve"] as const;
export const SANDBOX_CAPABILITY_ACTIONS = ["sandbox.provision", "sandbox.replace", "sandbox.profile", "sandbox.docker", "sandbox.browser", "sandbox.kubernetes", "sandbox.tunnel", "sandbox.port", "sandbox.root", "sandbox.device", "sandbox.network"] as const;
export const CREDENTIAL_ACTIONS = ["credential.resolve", "credential.inject", "credential.plugin", "credential.workflow", "credential.repository", "credential.internal", "credential.delegate"] as const;
export const EGRESS_ACTIONS = ["egress.connect", "egress.redirect", "egress.listen", "egress.tunnel"] as const;

export interface DelegatedExecutionDescriptorV1 {
  readonly schemaVersion: 1;
  readonly kind: DelegatedExecutionKind;
  readonly service: string;
  readonly actionId: string;
  readonly riskLevel: "low" | "medium" | "high" | "critical";
  readonly approvalSupported: boolean;
}

const descriptors = (
  kind: DelegatedExecutionKind,
  service: string,
  riskLevel: DelegatedExecutionDescriptorV1["riskLevel"],
  approvalSupported: boolean,
  actions: readonly string[],
): readonly DelegatedExecutionDescriptorV1[] => actions.map((actionId) => Object.freeze({ schemaVersion: 1, kind, service, actionId, riskLevel, approvalSupported }));

export const DELEGATED_EXECUTION_REGISTRY_V1 = Object.freeze([
  ...descriptors("delegation.create", "delegation", "high", true, DELEGATION_ACTIONS),
  ...descriptors("agent.signal", "agent", "medium", false, AGENT_SIGNAL_ACTIONS),
  ...descriptors("sandbox.capability", "sandbox", "high", true, SANDBOX_CAPABILITY_ACTIONS),
  ...descriptors("credential.use", "credential", "high", true, CREDENTIAL_ACTIONS.filter((id) => id !== "credential.delegate")),
  ...descriptors("credential.delegate", "credential", "critical", false, ["credential.delegate"]),
  ...descriptors("egress.connect", "egress", "high", false, EGRESS_ACTIONS),
]);

export type AgentSignalOperation = "interrupt" | "queue" | "steer" | "cancel" | "status" | "read" | "approve";
export type SandboxProfile = "headless" | "full";
export type ModelTier = "xs" | "s" | "m" | "l" | "xl";

interface CommonInput {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly principal: AuthorizationPrincipal;
  readonly requestId: string;
  readonly operationId: string;
  readonly evaluationTimeMs: number;
  readonly parentSessionId?: string;
  readonly sessionId?: string;
}

export interface DelegationCreateAdapterInputV1 extends CommonInput {
  readonly parentSessionId: string;
  readonly parentThreadId: string;
  readonly childSessionId: string;
  readonly owner: AuthorizationPrincipal;
  readonly teamId?: string;
  readonly repository?: { readonly host: string; readonly fullName: string; readonly branch?: string };
  readonly modelTier: ModelTier;
  readonly profile: SandboxProfile;
  readonly resources?: { readonly cpu?: number; readonly memory?: string };
  readonly docker: boolean;
  readonly limits: { readonly durationMs?: number; readonly turnLimit?: number; readonly hopCount: number };
  readonly taskClass: string;
  readonly capabilities: readonly string[];
  /** Host-asserted delegation lineage. Child/delegatee sessions must pass true. */
  readonly parentIsDelegatee: boolean;
}

export interface AgentSignalAdapterInputV1 extends CommonInput {
  readonly parentSessionId: string;
  readonly parentThreadId: string;
  readonly childSessionId: string;
  readonly operation: AgentSignalOperation;
  readonly relationship: "parent_child";
}

export interface SandboxCapabilityAdapterInputV1 extends CommonInput {
  readonly sessionId: string;
  readonly operation: "provision" | "replace" | "profile" | "docker" | "browser" | "kubernetes" | "tunnel" | "port" | "root" | "device" | "network";
  readonly requested: { readonly profile: SandboxProfile; readonly cpuClass?: string; readonly memoryClass?: string; readonly docker: boolean; readonly browser: boolean; readonly nestedKubernetes: boolean; readonly tunnels: boolean; readonly ports: readonly number[]; readonly capabilities: readonly string[] };
  readonly effective?: SandboxCapabilityAdapterInputV1["requested"];
}

export interface CredentialUseAdapterInputV1 extends CommonInput {
  readonly service: string;
  readonly credentialClass: string;
  readonly owner: AuthorizationPrincipal;
  readonly operation: string;
  readonly actionId: string;
  readonly target: { readonly sessionId?: string; readonly workflowExecutionId?: string; readonly childSessionId?: string };
  readonly resource?: { readonly type: string; readonly id?: string };
}

export interface CredentialDelegateAdapterInputV1 extends CommonInput {
  readonly service: string;
  readonly credentialClass: string;
  readonly owner: AuthorizationPrincipal;
  readonly delegatorSessionId: string;
  readonly delegateeSessionId: string;
  readonly operations: readonly string[];
  readonly expiresAtMs: number;
  readonly transitive: false;
}

export interface EgressConnectAdapterInputV1 extends CommonInput {
  readonly sessionId: string;
  readonly operation: "connect" | "redirect" | "listen" | "tunnel";
  readonly destination: { readonly scheme: "http" | "https" | "ws" | "wss" | "tcp"; readonly protocol: "http" | "https" | "ws" | "wss" | "tcp"; readonly host: string; readonly port: number; readonly destinationClass: string; readonly service?: string; readonly action?: string };
}

export interface DelegatedExecutionAdapterOutputV1 { readonly schemaVersion: 1; readonly request: AuthorizationRequest; readonly canonicalBytes: string; readonly requestSubjectDigest: string }

export function adaptDelegationCreate(input: DelegationCreateAdapterInputV1): DelegatedExecutionAdapterOutputV1 {
  common(input); for (const value of [input.parentSessionId, input.parentThreadId, input.childSessionId, input.owner.id, input.taskClass]) validId(value);
  if (input.owner.type === "user" && input.owner.id !== input.actorUserId) fail("owner_swap");
  if (input.owner.type === "org" && input.owner.id !== input.organizationId) fail("cross_org");
  if ((input.owner.type === "team") !== (input.teamId !== undefined) || (input.teamId !== undefined && input.teamId !== input.owner.id)) fail("owner_swap");
  if (!["xs", "s", "m", "l", "xl"].includes(input.modelTier) || !["headless", "full"].includes(input.profile) || typeof input.docker !== "boolean") fail("invalid_capability");
  exact(input.limits, ["durationMs", "turnLimit", "hopCount"]); positiveOptional(input.limits.durationMs); positiveOptional(input.limits.turnLimit);
  if (!Number.isSafeInteger(input.limits.hopCount) || input.limits.hopCount !== 1) fail("nested_delegation_unsupported");
  if (input.parentIsDelegatee) fail("nested_delegation_unsupported");
  const parameters: JsonObject = { parentSessionId: input.parentSessionId, parentThreadId: input.parentThreadId, childSessionId: input.childSessionId, owner: { type: input.owner.type, id: input.owner.id }, ...(input.teamId === undefined ? {} : { teamId: input.teamId }), ...(input.repository === undefined ? {} : { repository: cleanRepository(input.repository) }), modelTier: input.modelTier, profile: input.profile, resources: cleanResources(input.resources), docker: input.docker, limits: input.limits, taskClass: input.taskClass, capabilities: cleanSet(input.capabilities), depth: 1, parentRootCapable: true };
  return output(input, "delegation.create", "delegation.create", "delegation", "high", parameters);
}

export function adaptAgentSignal(input: AgentSignalAdapterInputV1): DelegatedExecutionAdapterOutputV1 {
  common(input); for (const value of [input.parentSessionId, input.parentThreadId, input.childSessionId]) validId(value);
  if (!["interrupt", "queue", "steer", "cancel", "status", "read", "approve"].includes(input.operation) || input.relationship !== "parent_child") fail("invalid_operation");
  return output(input, "agent.signal", `agent.${input.operation}`, "agent", input.operation === "status" || input.operation === "read" ? "low" : "medium", { parentSessionId: input.parentSessionId, parentThreadId: input.parentThreadId, childSessionId: input.childSessionId, relationship: input.relationship });
}

export function adaptSandboxCapability(input: SandboxCapabilityAdapterInputV1): DelegatedExecutionAdapterOutputV1 {
  common(input); validId(input.sessionId); const requested = sandboxShape(input.requested); const effective = input.effective === undefined ? undefined : sandboxShape(input.effective);
  if (effective !== undefined && !sandboxSubset(effective, requested)) fail("capability_expansion");
  return output(input, "sandbox.capability", `sandbox.${input.operation}`, "sandbox", "high", { operation: input.operation, requested, ...(effective === undefined ? {} : { effective }) });
}

export function adaptCredentialUse(input: CredentialUseAdapterInputV1): DelegatedExecutionAdapterOutputV1 {
  common(input); for (const value of [input.service, input.credentialClass, input.owner.id, input.operation, input.actionId]) validId(value);
  if (!ACTION.test(input.actionId) || input.owner.type === "user" && input.owner.id !== input.actorUserId || input.owner.type === "org" && input.owner.id !== input.organizationId) fail("invalid_credential_scope");
  const target = cleanTarget(input.target); if (Object.keys(target).length === 0) fail("invalid_credential_scope");
  const parameters: JsonObject = { service: input.service, credentialClass: input.credentialClass, owner: { type: input.owner.type, id: input.owner.id }, operation: input.operation, target, ...(input.resource === undefined ? {} : { resource: cleanResource(input.resource) }) };
  return output(input, "credential.use", `credential.${input.operation}`, "credential", "high", parameters);
}

export function adaptCredentialDelegate(input: CredentialDelegateAdapterInputV1): DelegatedExecutionAdapterOutputV1 {
  common(input); for (const value of [input.service, input.credentialClass, input.owner.id, input.delegatorSessionId, input.delegateeSessionId]) validId(value);
  if (input.delegatorSessionId === input.delegateeSessionId || input.transitive !== false || input.expiresAtMs <= input.evaluationTimeMs || input.expiresAtMs - input.evaluationTimeMs > 72 * 60 * 60 * 1000) fail("invalid_credential_scope");
  return output(input, "credential.delegate", "credential.delegate", "credential", "critical", { service: input.service, credentialClass: input.credentialClass, owner: { type: input.owner.type, id: input.owner.id }, delegatorSessionId: input.delegatorSessionId, delegateeSessionId: input.delegateeSessionId, operations: cleanSet(input.operations), expiresAtMs: input.expiresAtMs, transitive: false });
}

export function adaptEgressConnect(input: EgressConnectAdapterInputV1): DelegatedExecutionAdapterOutputV1 {
  common(input); validId(input.sessionId); const destination = normalizeEgressDestination(input.destination);
  return output(input, "egress.connect", `egress.${input.operation}`, "egress", "high", { operation: input.operation, destination });
}

export function normalizeEgressDestination(value: EgressConnectAdapterInputV1["destination"]): JsonObject {
  if (!["http", "https", "ws", "wss", "tcp"].includes(value.scheme) || value.protocol !== value.scheme && !(value.scheme === "http" && value.protocol === "http") || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535) fail("invalid_destination");
  const host = value.host.toLowerCase().replace(/\.$/, "");
  if (!HOST.test(host) || host.includes("..") || host.startsWith("xn--") || host.split(".").some((label) => label.startsWith("xn--")) || /^[0-9.]+$/.test(host) || host.includes(":") || host === "localhost") fail("invalid_destination");
  validId(value.destinationClass); if (value.service !== undefined) validId(value.service); if (value.action !== undefined && !ACTION.test(value.action)) fail("invalid_destination");
  return { scheme: value.scheme, protocol: value.protocol, host, port: value.port, destinationClass: value.destinationClass, ...(value.service === undefined ? {} : { service: value.service }), ...(value.action === undefined ? {} : { action: value.action }) };
}

export interface DelegationEnvelopeV1 {
  readonly schemaVersion: 1; readonly organizationId: string; readonly parentSessionId: string; readonly parentThreadId: string; readonly childSessionId: string; readonly actorUserId: string; readonly owner: AuthorizationPrincipal; readonly depth: 1; readonly parentRootCapable: true; readonly constraints: JsonObject; readonly capabilities: readonly string[]; readonly expiresAtMs?: number; readonly policyDigest: string; readonly sourceBundleDigest: string; readonly evaluatorKind: "local_valet" | "tvc_attested"; readonly engineDigest: string;
}

/** PR12 supports exactly one root-to-child edge. Imported or legacy chains fail closed. */
export function assertOneLevelDelegationEnvelope(envelope: DelegationEnvelopeV1, parentEnvelope?: DelegationEnvelopeV1): void {
  if (envelope.schemaVersion !== 1 || envelope.depth !== 1 || envelope.parentRootCapable !== true || envelope.parentSessionId === envelope.childSessionId || parentEnvelope !== undefined) fail("nested_delegation_unsupported");
  for (const value of [envelope.organizationId, envelope.parentSessionId, envelope.parentThreadId, envelope.childSessionId, envelope.actorUserId, envelope.owner.id]) validId(value);
  if (envelope.owner.type === "org" && envelope.owner.id !== envelope.organizationId) fail("cross_org");
  cleanSet(envelope.capabilities);
}

/** Reserved for a future design; PR12 callers must not use this to enable nesting. */
export function assertNestedDelegationNarrower(parent: DelegationEnvelopeV1, child: DelegationEnvelopeV1): void {
  if (parent.organizationId !== child.organizationId || parent.childSessionId !== child.parentSessionId || parent.actorUserId !== child.actorUserId || canonicalAuthorizationJson(parent.owner) !== canonicalAuthorizationJson(child.owner)) fail("delegation_widening");
  const allowed = new Set(parent.capabilities); if (child.capabilities.some((capability) => !allowed.has(capability))) fail("delegation_widening");
  if (parent.expiresAtMs !== undefined && (child.expiresAtMs === undefined || child.expiresAtMs > parent.expiresAtMs)) fail("delegation_widening");
}

export interface DelegatedExecutionObligationPlanV1 { readonly schemaVersion: 1; readonly egressHosts: readonly string[]; readonly sandboxCapabilities: readonly string[]; readonly credentialOwner?: { readonly ownerType: string; readonly ownerId: string }; readonly redactions: readonly RedactionDirective[] }
export function buildDelegatedExecutionObligationPlan(decision: PolicyDecisionV1): DelegatedExecutionObligationPlanV1 {
  let egressHosts: string[] = [], sandboxCapabilities: string[] = [], credentialOwner: DelegatedExecutionObligationPlanV1["credentialOwner"];
  for (const obligation of decision.obligations) {
    if (obligation.type === "egress_hosts") egressHosts = cleanHosts(obligation.hosts);
    else if (obligation.type === "sandbox_capabilities") sandboxCapabilities = cleanSet(obligation.capabilities);
    else if (obligation.type === "credential_owner") { validId(obligation.ownerType); validId(obligation.ownerId); credentialOwner = { ownerType: obligation.ownerType, ownerId: obligation.ownerId }; }
    else fail("unsupported_obligation");
  }
  return deepFreeze({ schemaVersion: 1, egressHosts, sandboxCapabilities, ...(credentialOwner === undefined ? {} : { credentialOwner }), redactions: decision.redactions.map((entry) => ({ ...entry, jsonPaths: [...new Set(entry.jsonPaths)].sort() })) });
}

function common(input: CommonInput): void { if (input.schemaVersion !== 1) fail("invalid_shape"); for (const value of [input.organizationId, input.actorUserId, input.principal.id, input.requestId, input.operationId]) validId(value); if (!Number.isSafeInteger(input.evaluationTimeMs) || input.evaluationTimeMs < 0) fail("invalid_shape"); if (input.principal.type === "user" && input.principal.id !== input.actorUserId || input.principal.type === "org" && input.principal.id !== input.organizationId) fail("invalid_identity"); }
function output(input: CommonInput, kind: DelegatedExecutionKind, actionId: string, service: string, riskLevel: string, parameters: JsonObject): DelegatedExecutionAdapterOutputV1 { if (!DELEGATED_EXECUTION_REGISTRY_V1.some((entry) => entry.kind === kind && entry.actionId === actionId)) fail("unknown_boundary"); const partial = { schemaVersion: 1 as const, requestId: input.requestId, kind, subject: { orgId: input.organizationId, principal: input.principal, invocation: { type: "resource" as const, id: input.operationId }, actorUserId: input.actorUserId, ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }), ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }) }, action: { id: actionId, service, riskLevel, parameters }, context: { schemaVersion: 1, evaluationTimeMs: input.evaluationTimeMs }, facts: {} }; const identity = authorizationIdentity(partial); const request = deepFreeze({ ...partial, idempotencyKey: identity.idempotencyKey }); return deepFreeze({ schemaVersion: 1, request, canonicalBytes: canonicalAuthorizationJson(request), requestSubjectDigest: identity.requestSubjectDigest }); }
function sandboxShape(value: SandboxCapabilityAdapterInputV1["requested"]): JsonObject { if (!["headless", "full"].includes(value.profile) || typeof value.docker !== "boolean" || typeof value.browser !== "boolean" || typeof value.nestedKubernetes !== "boolean" || typeof value.tunnels !== "boolean") fail("invalid_capability"); const ports = [...new Set(value.ports)].sort((a,b)=>a-b); if (ports.some((port) => !Number.isSafeInteger(port) || port < 1 || port > 65535)) fail("invalid_capability"); return { profile: value.profile, ...(value.cpuClass === undefined ? {} : { cpuClass: checkedId(value.cpuClass) }), ...(value.memoryClass === undefined ? {} : { memoryClass: checkedId(value.memoryClass) }), docker: value.docker, browser: value.browser, nestedKubernetes: value.nestedKubernetes, tunnels: value.tunnels, ports, capabilities: cleanSet(value.capabilities) }; }
function sandboxSubset(effective: JsonObject, requested: JsonObject): boolean { if (effective.profile === "full" && requested.profile !== "full") return false; for (const key of ["docker", "browser", "nestedKubernetes", "tunnels"] as const) if (effective[key] === true && requested[key] !== true) return false; const requestedPorts = new Set(requested.ports as readonly number[]); const requestedCaps = new Set(requested.capabilities as readonly string[]); return (effective.ports as readonly number[]).every((port) => requestedPorts.has(port)) && (effective.capabilities as readonly string[]).every((cap) => requestedCaps.has(cap)); }
function cleanRepository(value: NonNullable<DelegationCreateAdapterInputV1["repository"]>): JsonObject { validId(value.host); if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.fullName)) fail("invalid_repository"); if (value.branch !== undefined && (value.branch.length > 255 || /[\u0000-\u001f~^:?*[\\]/.test(value.branch))) fail("invalid_repository"); return { host: value.host, fullName: value.fullName, ...(value.branch === undefined ? {} : { branch: value.branch }) }; }
function cleanResources(value: DelegationCreateAdapterInputV1["resources"]): JsonObject { if (value === undefined) return {}; exact(value, ["cpu", "memory"]); if (value.cpu !== undefined && (!Number.isFinite(value.cpu) || value.cpu <= 0 || value.cpu > 64)) fail("invalid_capability"); if (value.memory !== undefined && !/^[0-9]+(?:Mi|Gi)$/.test(value.memory)) fail("invalid_capability"); return { ...(value.cpu === undefined ? {} : { cpu: value.cpu }), ...(value.memory === undefined ? {} : { memory: value.memory }) }; }
function cleanTarget(value: CredentialUseAdapterInputV1["target"]): JsonObject { const result: Record<string,string> = {}; for (const [key, entry] of Object.entries(value)) if (entry !== undefined) result[key] = checkedId(entry); return result; }
function cleanResource(value: NonNullable<CredentialUseAdapterInputV1["resource"]>): JsonObject { return { type: checkedId(value.type), ...(value.id === undefined ? {} : { id: checkedId(value.id) }) }; }
function cleanSet(values: readonly string[]): string[] { if (!Array.isArray(values) || values.length > 64) fail("invalid_capability"); return [...new Set(values.map(checkedId))].sort(); }
function cleanHosts(values: readonly string[]): string[] { if (!Array.isArray(values) || values.length > 64) fail("invalid_destination"); return [...new Set(values.map((host) => normalizeEgressDestination({ scheme: "https", protocol: "https", host, port: 443, destinationClass: "external" }).host as string))].sort(); }
function checkedId(value: string): string { validId(value); return value; }
function positiveOptional(value: number | undefined): void { if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) fail("invalid_capability"); }
function validId(value: unknown): asserts value is string { if (typeof value !== "string" || !ID.test(value)) fail("invalid_identity"); }
function exact(value: unknown, keys: readonly string[]): void { if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) fail("invalid_shape"); }
function fail(code: string): never { throw new TypeError(`Canonical delegated execution adapter rejected the input (${code}).`); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { for (const entry of Object.values(value)) deepFreeze(entry); Object.freeze(value); } return value; }
