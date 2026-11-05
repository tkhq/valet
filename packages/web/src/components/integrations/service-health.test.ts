/**
 * `service-health`: the states a connected service can be in, and the
 * action each broken state names. The rule under test is that "connected"
 * is not the same as "works" — a stale or scope-poor credential keeps its
 * row in the store.
 */
import { describe, expect, it } from "vitest";
import type { CredentialSummary, PluginServiceSummary } from "@valet/api/wire";
import { credentialRowHealth, healthBadge, healthNote, needsReauth, serviceHealth } from "./service-health";

const NOW = 1_700_000_000_000;

function service(overrides: Partial<PluginServiceSummary> = {}): PluginServiceSummary {
  return {
    service: "gmail",
    type: "oauth2",
    configKeys: ["accessToken"],
    connected: true,
    connect: "oauth",
    actions: [],
    ...overrides,
  };
}

describe("serviceHealth", () => {
  it("reads a service with no credential as disconnected", () => {
    expect(serviceHealth(service({ connected: false }), NOW)).toBe("disconnected");
  });

  it("reads a connected service with no health block as connected", () => {
    expect(serviceHealth(service(), NOW)).toBe("connected");
  });

  it("reads a credential with no expiry as connected, not expired", () => {
    // An API key or a PAT reports no expiry. Absent must not read as stale.
    expect(serviceHealth(service({ health: { login: "someone@example.com" } }), NOW)).toBe("connected");
  });

  it("reads a past expiry as expired and a future one as connected", () => {
    expect(serviceHealth(service({ health: { expiresAt: NOW - 1 } }), NOW)).toBe("expired");
    expect(serviceHealth(service({ health: { expiresAt: NOW + 60_000 } }), NOW)).toBe("connected");
  });

  it("reads a failed refresh and an identity-only grant", () => {
    expect(serviceHealth(service({ health: { refreshFailed: true } }), NOW)).toBe("refresh-failed");
    expect(serviceHealth(service({ health: { identityOnly: true } }), NOW)).toBe("identity-only");
  });

  it("puts a failed refresh above an expiry, and both above a scope problem", () => {
    const health = { expiresAt: NOW - 1, refreshFailed: true, identityOnly: true };
    expect(serviceHealth(service({ health }), NOW)).toBe("refresh-failed");
    expect(serviceHealth(service({ health: { expiresAt: NOW - 1, identityOnly: true } }), NOW)).toBe("expired");
  });

  it("reads a refusal and a scope gap from the tool-list probe", () => {
    expect(serviceHealth(service({ health: { rejected: true } }), NOW)).toBe("rejected");
    expect(serviceHealth(service({ health: { missingScopes: ["agent:content:read"], blockedTools: 2 } }), NOW)).toBe(
      "missing-scope",
    );
  });

  it("puts a refusal below a failed refresh and an expiry, and a scope gap last", () => {
    expect(serviceHealth(service({ health: { refreshFailed: true, rejected: true } }), NOW)).toBe("refresh-failed");
    expect(serviceHealth(service({ health: { expiresAt: NOW - 1, rejected: true } }), NOW)).toBe("expired");
    expect(serviceHealth(service({ health: { rejected: true, identityOnly: true } }), NOW)).toBe("rejected");
    expect(serviceHealth(service({ health: { identityOnly: true, missingScopes: ["a"] } }), NOW)).toBe("identity-only");
  });

  it("reads an empty scope list as connected", () => {
    expect(serviceHealth(service({ health: { missingScopes: [] } }), NOW)).toBe("connected");
  });

  it("ignores health on a disconnected service", () => {
    expect(serviceHealth(service({ connected: false, health: { refreshFailed: true } }), NOW)).toBe(
      "disconnected",
    );
  });
});

describe("needsReauth", () => {
  it("is true for every broken state and false otherwise", () => {
    expect(needsReauth("expired")).toBe(true);
    expect(needsReauth("refresh-failed")).toBe(true);
    expect(needsReauth("identity-only")).toBe(true);
    expect(needsReauth("rejected")).toBe(true);
    expect(needsReauth("missing-scope")).toBe(true);
    expect(needsReauth("connected")).toBe(false);
    expect(needsReauth("disconnected")).toBe(false);
  });
});

describe("healthBadge and healthNote", () => {
  it("badges a working connection and each broken one", () => {
    expect(healthBadge("connected")).toEqual({ label: "Connected", variant: "success" });
    expect(healthBadge("expired")).toEqual({ label: "Expired", variant: "danger" });
    expect(healthBadge("refresh-failed")).toEqual({ label: "Refresh failed", variant: "danger" });
    expect(healthBadge("identity-only")).toEqual({ label: "Sign-in only", variant: "warning" });
    expect(healthBadge("rejected")).toEqual({ label: "Rejected", variant: "danger" });
    expect(healthBadge("missing-scope")).toEqual({ label: "Missing scopes", variant: "warning" });
    expect(healthBadge("disconnected")).toBeNull();
  });

  it("names the corrective action in every broken state, and stays quiet otherwise", () => {
    for (const state of ["expired", "refresh-failed", "identity-only", "rejected", "missing-scope"] as const) {
      expect(healthNote(state)).toContain("Reconnect");
    }
    expect(healthNote("connected")).toBeNull();
    expect(healthNote("disconnected")).toBeNull();
  });
});

describe("healthNote for a scope gap", () => {
  it("names the scopes, the tools they block, and the admin step before Reconnect", () => {
    expect(healthNote("missing-scope", { missingScopes: ["agent:content:read"], blockedTools: 7 })).toBe(
      "This connection does not hold the agent:content:read scope, which 7 tools need. " +
        "Ask an admin to add agent:content:read to this integration's scopes. Then select Reconnect.",
    );
  });

  it("names every scope, and the tool list when the listing itself was refused", () => {
    expect(healthNote("missing-scope", { missingScopes: ["a:read", "b:read"] })).toBe(
      "This connection does not hold the a:read, b:read scopes, which the service needs to list its tools. " +
        "Ask an admin to add a:read, b:read to this integration's scopes. Then select Reconnect.",
    );
  });
});

describe("credentialRowHealth", () => {
  const row = (over: Partial<CredentialSummary>): CredentialSummary => ({
    service: "greenhouse", type: "oauth2", connectedAt: "2026-09-01T00:00:00Z", ...over,
  });

  it("reads a failed refresh as refresh-failed and a sign-in-only grant as identity-only", () => {
    expect(credentialRowHealth(row({ refreshFailedAt: NOW }))).toBe("refresh-failed");
    expect(credentialRowHealth(row({ identityOnly: true }))).toBe("identity-only");
  });

  it("reads a past expiry as connected, because an OAuth row renews when it is used", () => {
    expect(credentialRowHealth(row({ expiresAt: NOW - 1 }))).toBe("connected");
  });
});
