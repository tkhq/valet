/**
 * `service-health`: the states a connected service can be in, and the
 * action each broken state names. The rule under test is that "connected"
 * is not the same as "works" — a stale or scope-poor credential keeps its
 * row in the store.
 */
import { describe, expect, it } from "vitest";
import type { PluginServiceSummary } from "@valet/api/wire";
import { healthBadge, healthNote, needsReauth, serviceHealth } from "./service-health";

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
    expect(healthBadge("disconnected")).toBeNull();
  });

  it("names the corrective action in every broken state, and stays quiet otherwise", () => {
    for (const state of ["expired", "refresh-failed", "identity-only"] as const) {
      expect(healthNote(state)).toContain("Reconnect");
    }
    expect(healthNote("connected")).toBeNull();
    expect(healthNote("disconnected")).toBeNull();
  });
});
