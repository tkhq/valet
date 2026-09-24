import type {
  BrowserArtifact,
  BrowserIdentity,
  BrowserOperationClass,
  BrowserOperationReceipt,
  BrowserPolicyRequest,
} from "./browser.js";

/** Host authorization contract. The runtime and model cannot supply a policy decision. */
export interface BrowserPolicyService {
  authorize(identity: BrowserIdentity): Promise<{ policyVersion: string }>;
  decide(
    request: BrowserPolicyRequest,
  ): Promise<{
    decision: "allow" | "deny" | "ask";
    policyVersion: string;
    reason?: string;
  }>;
  approve(
    request: BrowserPolicyRequest,
    resolvedBy: string,
  ): Promise<{ policyVersion: string }>;
  audit(
    identity: BrowserIdentity,
    receipt: BrowserOperationReceipt,
  ): Promise<void>;
  persistArtifact(
    identity: BrowserIdentity,
    artifact: BrowserArtifact,
    data: Uint8Array,
  ): Promise<BrowserArtifact>;
}

export interface BrowserGrant {
  id: string;
  origin: string;
  operations: BrowserOperationClass[];
  expiresAt: number;
}

export interface BrowserSettings {
  enabled: boolean;
  audience: "owner" | "team";
  policyVersion: string;
  grants: BrowserGrant[];
}
