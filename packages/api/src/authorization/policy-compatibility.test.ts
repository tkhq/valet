import { describe, expect, it } from "vitest";
import { buildCurrentPolicySource, standardNewOrganizationPolicySnapshot } from "./bundles/current-policy-source.js";
import type { CurrentOrganizationPolicyV1, CurrentPersonalOverrideV1 } from "./bundles/current-policy-types.js";
import { currentPolicyCompatibilityReport } from "./policy-compatibility.js";

const ORG = "org-1";
function policy(id: string, paramMatchers: CurrentOrganizationPolicyV1["paramMatchers"] = [], revokedAtMs: number | null = null): CurrentOrganizationPolicyV1 {
  return { id, organizationId: ORG, principalType: "org", principalId: ORG, actionId: `svc.${id}`, mode: "deny", paramMatchers, appliesIn: "any", expiresAtMs: null, revokedAtMs, createdAtMs: 1, updatedAtMs: 1, sourceTable: "action_policies", sourcePath: `action_policies/${id}` };
}
function override(id: string, paramMatchers: CurrentPersonalOverrideV1["paramMatchers"]): CurrentPersonalOverrideV1 {
  return { id, organizationId: ORG, userId: "user-1", actionId: `svc.${id}`, mode: "allow", paramMatchers, createdAtMs: 1, updatedAtMs: 1, sourceTable: "action_policy_overrides", sourcePath: `action_policy_overrides/${id}` };
}

describe("current policy compatibility preflight", () => {
  it("reports exact legacy row IDs and corrective actions without matcher values", () => {
    const secret = "do-not-print-this";
    const snapshot = {
      ...standardNewOrganizationPolicySnapshot(ORG),
      organizationPolicies: [
        policy("dash", [{ path: "mail-to", op: "eq", value: secret }]),
        policy("empty", [{ path: "", op: "exists" }]),
        policy("alternation", [{ path: "to", op: "regex", value: "a|b" }]),
        policy("numeric", [{ path: "size", op: "gt", value: "10" }]),
      ],
      personalOverrides: [override("override", [{ path: "recipient-name", op: "eq", value: secret }])],
    };
    const report = currentPolicyCompatibilityReport(snapshot);
    expect(report.compatible).toBe(false);
    expect(report.issues.filter((entry) => entry.ids.length === 1).map((entry) => [entry.ids[0], entry.reason])).toEqual(expect.arrayContaining([
      ["alternation", "non_lossless_regex"], ["dash", "non_lossless_path"], ["empty", "non_lossless_path"], ["numeric", "invalid_value"], ["override", "non_lossless_path"],
    ]));
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(report.issues.every((entry) => entry.correctiveAction.length > 0)).toBe(true);
  });

  it("applies aggregate rule and matcher limits to active rows only", () => {
    const active = Array.from({ length: 64 }, (_, index) => policy(`active_${index}`));
    const revoked = Array.from({ length: 80 }, (_, index) => policy(`revoked_${index}`, [{ path: "value", op: "eq", value: index }], 2));
    const snapshot = { ...standardNewOrganizationPolicySnapshot(ORG), organizationPolicies: [...active, ...revoked] };
    expect(() => buildCurrentPolicySource(snapshot)).not.toThrow();
    const over = { ...snapshot, organizationPolicies: [...active, policy("active_extra"), ...revoked] };
    const report = currentPolicyCompatibilityReport(over);
    expect(report.issues).toContainEqual(expect.objectContaining({ reason: "complexity_limit", ids: expect.arrayContaining(["active_extra"]) }));
  });
});
