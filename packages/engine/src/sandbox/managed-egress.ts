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

export interface ManagedEgressEffectiveState {
  requested: true;
  configured: true;
  ready: true;
  effective: true;
  identity: ManagedEgressIdentity;
  proxyArtifact: string;
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
