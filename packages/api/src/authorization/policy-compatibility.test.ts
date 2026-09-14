import { describe, expect, it } from "vitest";
import { buildCurrentPolicySource, standardNewOrganizationPolicySnapshot } from "./bundles/current-policy-source.js";
import type { CurrentOrganizationPolicyV1, CurrentPersonalOverrideV1 } from "./bundles/current-policy-types.js";
import { currentPolicyCompatibilityReport } from "./policy-compatibility.js";

const ORG = "org-1";
function policy(id: string, paramMatchers: CurrentOrganizationPolicyV1["paramMatchers"] = [], revokedAtMs: number | null = null): CurrentOrganizationPolicyV1 {
  return { id, organizationId: ORG, principalType: "org", principalId: ORG, actionId: `svc.${id}`, mode: "deny", paramMatchers, appliesIn: "any", expiresAtMs: null, revokedAtMs, createdAtMs: 1, updatedAtMs: 1, sourceTable: "action_policies", sourcePath: `action_policies/${id}` };
}
function override(id: string, paramMatchers: CurrentPersonalOverrideV1["paramMatchers"], revokedAtMs?: number): CurrentPersonalOverrideV1 {
  return { id, organizationId: ORG, userId: "user-1", actionId: `svc.${id}`, mode: "allow", paramMatchers, ...(revokedAtMs === undefined ? {} : { revokedAtMs }), createdAtMs: 1, updatedAtMs: 1, sourceTable: "action_policy_overrides", sourcePath: `action_policy_overrides/${id}` };
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

  it("stops reporting incompatible semantics after each row is tombstoned", () => {
    const bad = [{ path: "recipient-name", op: "regex" as const, value: "a|b" }];
    const org = policy("org-bad", bad);
    const team = { ...policy("team-bad", bad), principalType: "team" as const, principalId: "team-1" };
    const personal = override("personal-bad", [{ path: "size", op: "gt", value: "10" }]);
    const config = { ...policy("config-bad", [{ path: "mail-to", op: "eq", value: "x" }]), sourcePath: "config/toolPolicies/config-bad" };
    const active = { ...standardNewOrganizationPolicySnapshot(ORG), teamIds: ["team-1"], organizationPolicies: [org, config], teamPolicies: [team], personalOverrides: [personal] };
    expect(currentPolicyCompatibilityReport(active).issues.map((entry) => entry.ids[0])).toEqual(expect.arrayContaining(["org-bad", "team-bad", "personal-bad", "config-bad"]));
    const revoked = {
      ...active,
      organizationPolicies: active.organizationPolicies.map((row) => ({ ...row, revokedAtMs: 2 })),
      teamPolicies: active.teamPolicies.map((row) => ({ ...row, revokedAtMs: 2 })),
      personalOverrides: active.personalOverrides.map((row) => ({ ...row, revokedAtMs: 2 })),
    };
    expect(currentPolicyCompatibilityReport(revoked)).toMatchObject({ compatible: true, issues: [] });
    expect(() => buildCurrentPolicySource(revoked)).not.toThrow();
  });

  it("retains tenant and basic row checks for tombstones", () => {
    const crossTenant = { ...policy("cross-tenant", [{ path: "bad-path", op: "regex", value: "a|b" }], 2), organizationId: "other-org" };
    const report = currentPolicyCompatibilityReport({ ...standardNewOrganizationPolicySnapshot(ORG), organizationPolicies: [crossTenant] });
    expect(report.issues).toContainEqual(expect.objectContaining({ ids: ["cross-tenant"], reason: "cross_organization" }));
  });

  it("applies aggregate rule and matcher limits to active rows only", () => {
    const active = Array.from({ length: 64 }, (_, index) => policy(`active_${index}`));
    const revoked = Array.from({ length: 80 }, (_, index) => policy(`revoked_${index}`, [{ path: "bad-path", op: "regex", value: "a|b" }], 2));
    const tombstonedOverrides = Array.from({ length: 80 }, (_, index) => override(`removed_${index}`, [{ path: "bad-path", op: "gt", value: "x" }], 2));
    const snapshot = { ...standardNewOrganizationPolicySnapshot(ORG), organizationPolicies: [...active, ...revoked], personalOverrides: tombstonedOverrides };
    expect(() => buildCurrentPolicySource(snapshot)).not.toThrow();
    const over = { ...snapshot, organizationPolicies: [...active, policy("active_extra"), ...revoked] };
    const report = currentPolicyCompatibilityReport(over);
    expect(report.issues).toContainEqual(expect.objectContaining({ reason: "complexity_limit", ids: expect.arrayContaining(["active_extra"]) }));
  });
});
