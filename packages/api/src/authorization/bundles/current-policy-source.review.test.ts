import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthorizationRequest, PolicyDecisionV1 } from "@valet/engine/authorization";
import { resolvePolicyDecision, type ActionPolicyRow } from "../../policies/resolution.js";
import { InMemorySourceBundleStorage } from "./in-memory-storage.js";
import { SourceBundleHost } from "./host.js";
import { WasmPolicyRuntime } from "../evaluators/wasm-runtime.js";
import {
  buildCurrentPolicyDynamicFacts,
  buildCurrentPolicySource,
  CURRENT_POLICY_COMPLEXITY_LIMITS_V1,
  standardNewOrganizationPolicySnapshot,
} from "./current-policy-source.js";
import type { CurrentPolicySourceSnapshotV1 } from "./current-policy-types.js";

const ORG = "org-review";
const NOW = 1_000_000;
let runtime: WasmPolicyRuntime;

interface EvaluationResult {
  readonly decision: PolicyDecisionV1;
  readonly usage: { readonly work_units: number };
}

beforeAll(() => { runtime = new WasmPolicyRuntime(); });
afterAll(async () => { await runtime.close(); });

function snapshot(overrides: Partial<CurrentPolicySourceSnapshotV1> = {}): CurrentPolicySourceSnapshotV1 {
  return { ...standardNewOrganizationPolicySnapshot(ORG, "review-v1"), ...overrides };
}

function orgRule(index: number, overrides: Partial<CurrentPolicySourceSnapshotV1["organizationPolicies"][number]> = {}): CurrentPolicySourceSnapshotV1["organizationPolicies"][number] {
  return {
    id: `org-${index}`,
    organizationId: ORG,
    principalType: "org",
    principalId: ORG,
    actionId: "gmail.send_email",
    mode: "allow",
    paramMatchers: [{ path: "selector", op: "eq", value: `value-${index}` }],
    appliesIn: "any",
    expiresAtMs: null,
    revokedAtMs: null,
    createdAtMs: 1,
    updatedAtMs: index + 1,
    sourceTable: "action_policies",
    sourcePath: `org/${index}`,
    ...overrides,
  };
}

function teamRule(index: number): CurrentPolicySourceSnapshotV1["teamPolicies"][number] {
  return {
    ...orgRule(index),
    id: `team-${index}`,
    principalType: "team",
    principalId: "team-1",
    sourcePath: `team/${index}`,
  };
}

function overrideRule(index: number): CurrentPolicySourceSnapshotV1["personalOverrides"][number] {
  return {
    id: `override-${index}`,
    organizationId: ORG,
    userId: "user-1",
    actionId: "gmail.send_email",
    mode: "allow",
    paramMatchers: [{ path: "selector", op: "eq", value: `value-${index}` }],
    createdAtMs: 1,
    updatedAtMs: index + 1,
    sourceTable: "action_policy_overrides",
    sourcePath: `override/${index}`,
  };
}

function request(parameters?: Record<string, string | number | boolean | null>): AuthorizationRequest {
  return {
    schemaVersion: 1,
    requestId: "review-request",
    idempotencyKey: "interactive:review",
    kind: "tool.action",
    subject: {
      orgId: ORG,
      principal: { type: "user", id: "user-1" },
      invocation: { type: "interactive", id: "review" },
      sessionId: "session-1",
    },
    action: {
      service: "gmail",
      id: "gmail.send_email",
      riskLevel: "high",
      ...(parameters === undefined ? {} : { parameters }),
    },
    context: { evaluationTimeMs: NOW },
    facts: {},
  };
}

async function evaluate(source: CurrentPolicySourceSnapshotV1, input = request()): Promise<EvaluationResult> {
  const host = new SourceBundleHost(new InMemorySourceBundleStorage(), runtime);
  const identity = await host.publish(buildCurrentPolicySource(source).bundle);
  await host.activate(ORG, undefined, identity.sourceBundleDigest);
  return runtime.run<EvaluationResult>({
    operation: "evaluate",
    sourceBundleDigest: identity.sourceBundleDigest,
    input,
    explain: "off",
  });
}

function scaleSnapshot(ruleCount: number): CurrentPolicySourceSnapshotV1 {
  const organizationCount = Math.ceil(ruleCount * 0.4);
  const teamCount = Math.ceil(ruleCount * 0.35);
  const overrideCount = ruleCount - organizationCount - teamCount;
  return snapshot({
    teamIds: ["team-1"],
    organizationPolicies: Array.from({ length: organizationCount }, (_, index) => orgRule(index)),
    teamPolicies: Array.from({ length: teamCount }, (_, index) => teamRule(index + organizationCount)),
    personalOverrides: Array.from({ length: overrideCount }, (_, index) => overrideRule(index + organizationCount + teamCount)),
    pluginDefaults: Array.from({ length: CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxPluginDefaults }, (_, index) => ({
      id: `plugin-${index}`,
      service: `service${index}`,
      mode: "allow" as const,
      sourcePath: `plugin/${index}`,
    })),
  });
}

describe("current policy source review regressions", () => {
  it("evaluates worst-case scale snapshots with deterministic headroom", async () => {
    const source = scaleSnapshot(50);
    const noMatch = await evaluate(source, request({ selector: "absent" }));
    const lateMatch = await evaluate(source, request({ selector: "value-0" }));
    expect(noMatch.decision.effect).toBe("require_approval");
    expect(lateMatch.decision.matchedRuleIds).toContain("org-0");
    expect(Math.max(noMatch.usage.work_units, lateMatch.usage.work_units)).toBeLessThan(750_000);

    const permuted = snapshot({
      ...source,
      organizationPolicies: [...source.organizationPolicies].reverse(),
      teamPolicies: [...source.teamPolicies].reverse(),
      personalOverrides: [...source.personalOverrides].reverse(),
      pluginDefaults: [...source.pluginDefaults].reverse(),
      riskDefaults: [...source.riskDefaults].reverse(),
    });
    expect(buildCurrentPolicySource(permuted).bundle).toEqual(buildCurrentPolicySource(source).bundle);
  });

  it("accepts the maximum rule complexity and rejects one more", async () => {
    const maximum = scaleSnapshot(CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxRules);
    const result = await evaluate(maximum, request({ selector: "absent" }));
    expect(result.usage.work_units).toBeLessThan(750_000);
    expect(() => buildCurrentPolicySource(snapshot({
      organizationPolicies: Array.from({ length: CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxRules + 1 }, (_, index) => orgRule(index)),
    }))).toThrow(expect.objectContaining({ code: "complexity_limit" }));
  });

  it("enforces matcher, path, regex, default, and dynamic fact limits", () => {
    const matchers = Array.from({ length: CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxMatchersPerRule + 1 }, (_, index) => ({
      path: `field${index}`,
      op: "exists" as const,
    }));
    expect(() => buildCurrentPolicySource(snapshot({
      organizationPolicies: [orgRule(1, { paramMatchers: matchers })],
    }))).toThrow(expect.objectContaining({ code: "complexity_limit" }));
    expect(() => buildCurrentPolicySource(snapshot({
      organizationPolicies: [orgRule(1, { paramMatchers: [{ path: "a.b.c.d.e.f.g.h.i", op: "exists" }] })],
    }))).toThrow(expect.objectContaining({ code: "complexity_limit" }));
    expect(() => buildCurrentPolicySource(snapshot({
      organizationPolicies: [orgRule(1, { paramMatchers: [{ path: "value", op: "regex", value: "a".repeat(CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxRegexLength + 1) }] })],
    }))).toThrow(expect.objectContaining({ code: "non_lossless_regex" }));
    expect(() => buildCurrentPolicySource(snapshot({
      pluginDefaults: Array.from({ length: CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxPluginDefaults + 1 }, (_, index) => ({
        id: `plugin-limit-${index}`,
        service: `service${index}`,
        mode: "allow" as const,
        sourcePath: `plugin/${index}`,
      })),
    }))).toThrow(expect.objectContaining({ code: "complexity_limit" }));

    const grant = {
      schemaVersion: 1 as const,
      id: "grant",
      organizationId: ORG,
      policyKey: "gmail.send_email",
      service: "gmail",
      actionId: "gmail.send_email",
      riskLevel: "high" as const,
      appliesIn: "session" as const,
      sessionId: "session-1",
      issuerId: "issuer",
      sourceApprovalId: "approval",
      createdAtMs: 1,
      expiresAtMs: NOW + 1,
      revokedAtMs: null,
    };
    expect(() => buildCurrentPolicyDynamicFacts({
      organizationId: ORG,
      grants: Array.from({ length: CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxDynamicGrants + 1 }, () => grant),
      approvals: [],
    })).toThrow(expect.objectContaining({ code: "complexity_limit" }));
    expect(() => buildCurrentPolicyDynamicFacts({
      organizationId: ORG,
      grants: [],
      approvals: Array.from({ length: CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxDynamicApprovals + 1 }, () => ({
        schemaVersion: 1,
        resolutionVersion: 1,
        resolutionId: "resolution",
        approvalId: "approval",
        gateId: "gate",
        organizationId: ORG,
        requestSubjectDigest: "a".repeat(64),
        originalDecisionDigest: "b".repeat(64),
        approverId: "approver",
        verdict: "approved",
        appliesIn: "session",
        sessionId: "session-1",
        resolvedAtMs: 1,
        expiresAtMs: NOW + 1,
      })),
    })).toThrow(expect.objectContaining({ code: "complexity_limit" }));
  });

  it.each([
    ["^admin@example\\.com$", "admin@example.com", "user@example.com"],
    ["[a-z]+", "abc", "123"],
    ["^[^0-9]+$", "letters", "letter1"],
    ["foo?", "fo", "bar"],
    ["a\\+b", "a+b", "ab"],
  ])("matches lossless regex %s identically in JS and Regorus", async (pattern, matching, nonmatching) => {
    const source = snapshot({ organizationPolicies: [orgRule(1, { mode: "deny", paramMatchers: [{ path: "selector", op: "regex", value: pattern }] })] });
    for (const value of [matching, nonmatching]) {
      const result = await evaluate(source, request({ selector: value }));
      expect(result.decision.effect === "deny").toBe(new RegExp(pattern).test(value));
    }
  });

  it.each(["\\d", "\\w", "\\s", "\\p{L}", "[]", "[^]", "\\n", ".", "\\x41", "é", "\\a"])(
    "rejects non-lossless regex %s before engine evaluation",
    (pattern) => {
      expect(() => buildCurrentPolicySource(snapshot({
        organizationPolicies: [orgRule(1, { paramMatchers: [{ path: "selector", op: "regex", value: pattern }] })],
      }))).toThrow(expect.objectContaining({ code: "non_lossless_regex" }));
    },
  );

  it("preserves missing, null, false, and zero matcher semantics", async () => {
    const effect = async (op: "exists" | "not_exists" | "eq", parameters?: Record<string, string | number | boolean | null>, value?: null) => {
      const matcher = op === "eq" ? { path: "value", op, value } as const : { path: "value", op } as const;
      return (await evaluate(snapshot({ organizationPolicies: [orgRule(1, { mode: "deny", paramMatchers: [matcher] })] }), request(parameters))).decision.effect;
    };
    expect(await effect("exists")).toBe("require_approval");
    expect(await effect("not_exists")).toBe("deny");
    expect(await effect("eq", undefined, null)).toBe("require_approval");
    const missingNegatedMatchers = [
      { path: "value", op: "neq" as const, value: 1 },
      { path: "value", op: "not_in" as const, value: [1] },
    ];
    for (const matcher of missingNegatedMatchers) {
      const result = await evaluate(snapshot({ organizationPolicies: [orgRule(1, { mode: "deny", paramMatchers: [matcher] })] }));
      expect(result.decision.effect).toBe("deny");
    }
    for (const value of [null, false, 0] as const) expect(await effect("exists", { value })).toBe("deny");
    expect(() => buildCurrentPolicySource(snapshot({
      organizationPolicies: [orgRule(1, { paramMatchers: [{ path: "", op: "exists" }] })],
    }))).toThrow(expect.objectContaining({ code: "non_lossless_path" }));
  });

  it("rejects only ambiguity that can co-match at equal precedence", () => {
    const build = (rows: CurrentPolicySourceSnapshotV1["organizationPolicies"]) => () => buildCurrentPolicySource(snapshot({ organizationPolicies: rows }));
    expect(build([orgRule(1, { appliesIn: "session" }), orgRule(2, { id: "workflow", appliesIn: "workflow", updatedAtMs: 2, paramMatchers: [{ path: "selector", op: "eq", value: "value-1" }] })])).not.toThrow();
    expect(build([orgRule(1, { appliesIn: "any" }), orgRule(2, { id: "session", appliesIn: "session", updatedAtMs: 2, paramMatchers: [{ path: "selector", op: "eq", value: "value-1" }] })])).toThrow(expect.objectContaining({ code: "ambiguous_identity" }));
    expect(build([orgRule(1), orgRule(2, { id: "other", actionId: "gmail.read_email", updatedAtMs: 2 })])).not.toThrow();
    expect(build([orgRule(1, { revokedAtMs: 2 }), orgRule(2, { id: "replacement", updatedAtMs: 2 })])).not.toThrow();
    expect(build([orgRule(1), orgRule(2, { id: "tie", updatedAtMs: 2, paramMatchers: [{ path: "selector", op: "eq", value: "value-1" }] })])).toThrow(expect.objectContaining({ code: "ambiguous_identity" }));
  });

  it("emits stable source-specific provenance ranges", () => {
    const source = snapshot({
      organizationPolicies: [orgRule(1), orgRule(2, { actionId: "gmail.read_email" })],
      pluginDefaults: [{ id: "plugin-gmail", service: "gmail", mode: "allow", sourcePath: "plugin/gmail" }],
    });
    const built = buildCurrentPolicySource(source);
    const encoded = built.bundle.files.find((file) => file.path === "provenance/current-action-policy.json");
    expect(encoded).toBeDefined();
    const provenance = JSON.parse(Buffer.from(encoded!.contentBase64, "base64").toString("utf8")) as {
      entries: Array<{ rule_id: string; start_line: number; end_line: number }>;
    };
    const lines = built.policySource.split("\n");
    const ranges = new Set<string>();
    for (const entry of provenance.entries) {
      expect(entry.start_line).toBeGreaterThan(0);
      expect(entry.end_line).toBeGreaterThanOrEqual(entry.start_line);
      expect(entry.end_line).toBeLessThan(lines.length);
      expect(lines.slice(entry.start_line - 1, entry.end_line).join("\n")).toContain(entry.rule_id);
      ranges.add(`${entry.start_line}:${entry.end_line}`);
    }
    expect(ranges.size).toBe(provenance.entries.length);
  });

  it("has zero unexpected mismatches in a seeded resolver sweep", async () => {
    let state = 0x679;
    const random = (): number => ((state = (state * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000);
    for (let iteration = 0; iteration < 64; iteration++) {
      const rows = Array.from({ length: 6 }, (_, index) => orgRule(index, {
        id: `seed-${iteration}-${index}`,
        actionId: index % 3 === 0 ? "gmail.send_email" : undefined,
        service: index % 3 === 1 ? "gmail" : undefined,
        riskLevel: index % 3 === 2 ? "high" : undefined,
        mode: (["allow", "require_approval", "deny"] as const)[Math.floor(random() * 3)],
        paramMatchers: [{ path: "selector", op: "eq", value: index % 2 }],
        updatedAtMs: index + 1,
      }));
      const params = { selector: Math.floor(random() * 2) };
      const canonical = await evaluate(snapshot({ organizationPolicies: rows }), request(params));
      const legacyRows: ActionPolicyRow[] = rows.map((row) => ({
        id: row.id,
        principalType: "org",
        service: row.service ?? null,
        actionId: row.actionId ?? null,
        riskLevel: row.riskLevel ?? null,
        mode: row.mode,
        paramMatchers: [...row.paramMatchers],
        appliesIn: row.appliesIn,
        expiresAt: row.expiresAtMs,
        revokedAt: row.revokedAtMs,
        updatedAt: row.updatedAtMs,
      }));
      const legacy = resolvePolicyDecision({ policies: legacyRows, grants: [], overrides: [] }, {
        service: "gmail",
        actionId: "gmail.send_email",
        riskLevel: "high",
        params,
        appliesIn: "session",
        sessionId: "session-1",
        now: NOW,
      }, undefined);
      expect(canonical.decision.effect, `seed iteration ${iteration}`).toBe(legacy.mode);
      expect(canonical.usage.work_units).toBeLessThan(1_000_000);
    }
  });
});
