export const MANAGED_EGRESS_CONTRACT_VERSION = "hematite-external-authorization-v1" as const;

export interface ManagedEgressIdentity {
  orgId: string;
  sessionId: string;
  workloadId: string;
  proxyId: string;
  contractVersion: typeof MANAGED_EGRESS_CONTRACT_VERSION;
}

/** Provider-neutral desired state. The host creates the token and never puts it in workload env or metadata. */
export interface ManagedEgressRequest {
  requested: true;
  identity: ManagedEgressIdentity;
  proxyToken: string;
}

export interface ManagedEgressLifecycle {
  registerCallbackBinding(): void;
  revokeCallbackBinding(): void;
}

export interface ManagedEgressTopologyIdentity {
  proxyResources: string[];
  policyResources: string[];
  workloadSelector: Record<string, string>;
  callbackBindingId: string;
}

export interface ManagedEgressEffectiveState {
  requested: true;
  configured: true;
  ready: true;
  effective: true;
  identity: ManagedEgressIdentity;
  proxyArtifact: string;
  topology: ManagedEgressTopologyIdentity;
}

/** Durable metadata. Process-epoch tokens and CA private keys are never part of this state. */
export interface ManagedEgressPersistedState {
  requested: { identity: ManagedEgressIdentity };
  effective?: ManagedEgressEffectiveState;
}

export interface ManagedEgressCapability {
  supported: boolean;
  configured: boolean;
  ready: boolean;
  contractVersion?: typeof MANAGED_EGRESS_CONTRACT_VERSION;
  proxyArtifact?: string;
  reason?: string;
}

export class ManagedEgressPrerequisiteError extends Error {
  readonly code = "managed_egress_prerequisite";
  constructor(readonly prerequisite: "unsupported_provider" | "configuration" | "callback" | "network_isolation" | "identity" | "cleanup", message: string) {
    super(message);
    this.name = "ManagedEgressPrerequisiteError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function validateManagedEgressRequest(request: unknown): asserts request is ManagedEgressRequest {
  if (!record(request) || !exactKeys(request, ["requested", "identity", "proxyToken"]) || request.requested !== true || !record(request.identity)) {
    throw new ManagedEgressPrerequisiteError("identity", "Managed egress requests must use the exact required request and identity fields.");
  }
  const identity = request.identity;
  if (!exactKeys(identity, ["orgId", "sessionId", "workloadId", "proxyId", "contractVersion"]) || identity.contractVersion !== MANAGED_EGRESS_CONTRACT_VERSION) {
    throw new ManagedEgressPrerequisiteError("identity", "Managed egress identity fields or contract version are invalid. Configure hematite-external-authorization-v1.");
  }
  for (const [name, value] of Object.entries(identity)) {
    if (typeof value !== "string" || value.length < 1 || value.length > 128 || !/^[\x21-\x7e]+$/.test(value) || /["\\]/.test(value)) {
      throw new ManagedEgressPrerequisiteError("identity", `Managed egress ${name} is invalid. Use 1 to 128 safe ASCII characters.`);
    }
  }
  if (typeof request.proxyToken !== "string" || request.proxyToken.length < 32 || request.proxyToken.length > 4096 || /[\r\n]/.test(request.proxyToken)) {
    throw new ManagedEgressPrerequisiteError("identity", "Managed egress proxy token is invalid. Mint a token with at least 32 characters and no line breaks.");
  }
}

function persistedError(): ManagedEgressPrerequisiteError {
  return new ManagedEgressPrerequisiteError(
    "identity",
    "Persisted managed egress metadata is invalid. Re-provision the managed boundary.",
  );
}

function parseIdentityField(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !/^[\x21-\x7e]+$/.test(value) || /["\\]/.test(value)) {
    throw persistedError();
  }
  return value;
}

function parseIdentity(value: unknown): ManagedEgressIdentity {
  if (!record(value) || !exactKeys(value, ["orgId", "sessionId", "workloadId", "proxyId", "contractVersion"])) {
    throw persistedError();
  }
  if (value.contractVersion !== MANAGED_EGRESS_CONTRACT_VERSION) throw persistedError();
  const orgId = parseIdentityField(value.orgId);
  const sessionId = parseIdentityField(value.sessionId);
  const workloadId = parseIdentityField(value.workloadId);
  const proxyId = parseIdentityField(value.proxyId);
  return {
    orgId,
    sessionId,
    workloadId,
    proxyId,
    contractVersion: MANAGED_EGRESS_CONTRACT_VERSION,
  };
}

function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw persistedError();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length < 1 || item.length > 256) throw persistedError();
    result.push(item);
  }
  return result;
}

function parseTopology(value: unknown): ManagedEgressTopologyIdentity {
  if (!record(value) || !exactKeys(value, ["proxyResources", "policyResources", "workloadSelector", "callbackBindingId"])) {
    throw persistedError();
  }
  if (!record(value.workloadSelector) || Object.keys(value.workloadSelector).length < 1 || Object.keys(value.workloadSelector).length > 16) {
    throw persistedError();
  }
  const workloadSelector: Record<string, string> = {};
  for (const [key, selectorValue] of Object.entries(value.workloadSelector)) {
    if (key.length < 1 || key.length > 253 || typeof selectorValue !== "string" || selectorValue.length < 1 || selectorValue.length > 253) {
      throw persistedError();
    }
    workloadSelector[key] = selectorValue;
  }
  if (typeof value.callbackBindingId !== "string" || value.callbackBindingId.length < 1 || value.callbackBindingId.length > 256) {
    throw persistedError();
  }
  return {
    proxyResources: parseStringList(value.proxyResources),
    policyResources: parseStringList(value.policyResources),
    workloadSelector,
    callbackBindingId: value.callbackBindingId,
  };
}

/** Parse the closed durable shape. Reject fields that could smuggle credentials or private keys. */
export function parseManagedEgressPersistedState(value: unknown): ManagedEgressPersistedState {
  if (!record(value) || !exactKeys(value, value.effective === undefined ? ["requested"] : ["requested", "effective"])) {
    throw persistedError();
  }
  if (!record(value.requested) || !exactKeys(value.requested, ["identity"])) throw persistedError();
  const requested = { identity: parseIdentity(value.requested.identity) };
  if (value.effective === undefined) return { requested };
  const effective = value.effective;
  if (!record(effective) || !exactKeys(effective, ["requested", "configured", "ready", "effective", "identity", "proxyArtifact", "topology"])) {
    throw persistedError();
  }
  if (effective.requested !== true || effective.configured !== true || effective.ready !== true || effective.effective !== true) {
    throw persistedError();
  }
  if (typeof effective.proxyArtifact !== "string" || effective.proxyArtifact.length < 1 || effective.proxyArtifact.length > 512) {
    throw persistedError();
  }
  const effectiveIdentity = parseIdentity(effective.identity);
  if (JSON.stringify(requested.identity) !== JSON.stringify(effectiveIdentity)) throw persistedError();
  return {
    requested,
    effective: {
      requested: true,
      configured: true,
      ready: true,
      effective: true,
      identity: effectiveIdentity,
      proxyArtifact: effective.proxyArtifact,
      topology: parseTopology(effective.topology),
    },
  };
}
