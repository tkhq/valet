import { describe, expect, it, vi } from "vitest";
import { authorizationSha256Hex, type AuthorizationKind } from "@valet/engine/authorization";
import { currentPolicyTargetIssueV1 } from "../bundles/current-policy-input-contract.js";
import { AUTHORIZATION_CONTEXT_KINDS, POLICY_CONTEXTS } from "./contexts.js";
import { createPreviewRequest, normalizePolicyDraft, sanitizeSampleFacts, validatePolicyDraft } from "./model.js";
import type { JsonValue, PolicyDraftV1 } from "./types.js";

const ALL: AuthorizationKind[] = ["tool.action", "workflow.action", "tool.builtin", "plugin.entitlement", "route.access", "resource.access", "delegation.create", "agent.signal", "sandbox.capability", "credential.use", "credential.delegate", "egress.connect"];
function draft(): PolicyDraftV1 {
  return {
    schemaVersion: 1,
    draftId: "draft-1",
    rules: [
      {
        ruleId: "rule-1",
        context: "tool.action",
        authority: "organization",
        owner: { kind: "org", id: "org-1" },
        subjects: ["org"],
        target: { "action.id": "gmail.send_email" },
        matcherGroups: [
          {
            id: "group-1",
            mode: "all",
            matchers: [
              {
                id: "matcher-1",
                field: "parameters.to",
                operator: "regex",
                value: "@example\\.com$",
              },
            ],
          },
        ],
        effect: "deny",
        appliesIn: "any",
        obligations: [],
        description: "",
        metadata: {},
      },
    ],
  };
}

describe("policy context registry", () => {
  it("covers every canonical authorization kind with safe fallback invariants", () => {
    expect([...AUTHORIZATION_CONTEXT_KINDS].sort()).toEqual([...ALL].sort());
    for (const kind of ALL) {
      const context = POLICY_CONTEXTS[kind];
      expect(context.kind).toBe(kind);
      expect(context.fallback).toBe(context.humanApproval ? "require_approval" : "deny");
      expect(context.effects.includes("require_approval")).toBe(context.humanApproval);
      for (const field of context.fields) {
        if (field.type === "number") expect(field.operators).not.toContain("regex");
        if (field.type === "boolean") expect(field.operators).not.toContain("gt");
      }
    }
  });
  it("uses bounded SHA-256 identities and rejects hostile or mixed drafts", () => {
    expect(authorizationSha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(normalizePolicyDraft(draft()).normalizedIdentity).toBe("policy-draft-v1:77f0183085ee631b3bbf4cf920dbbb9bc37aa8a2feb41778d4a22e5a9f0aed44");
    const locale = vi.spyOn(String.prototype, "locale" + "Compare" as "locale\u0043ompare").mockImplementation(() => { throw new Error("locale-dependent"); }); expect(normalizePolicyDraft(draft()).normalizedIdentity).toContain("policy-draft-v1:"); locale.mockRestore();
    const base = draft(), mixed: PolicyDraftV1 = { ...base, rules: [...base.rules, { ...base.rules[0], ruleId: "rule-2", context: "route.access" }] };
    expect(validatePolicyDraft(mixed).map(value => value.code)).toContain("mixed_context");
    let reads = 0; const hostile = Object.defineProperty({}, "rules", { enumerable: true, get() { reads++; throw new Error("no"); } });
    expect(() => validatePolicyDraft(hostile)).not.toThrow(); expect(reads).toBe(0);
    expect(sanitizeSampleFacts("tool.action", { "parameters.value": { nested: "api_token" } })).toEqual({});
  });

});

describe("policy draft validation", () => {
  it("normalizes row, group, key, and subject permutations", () => {
    const first = normalizePolicyDraft(draft());
    const rule = draft().rules[0];
    const second = normalizePolicyDraft({
      ...draft(),
      rules: [
        {
          ...rule,
          subjects: [...rule.subjects].reverse(),
          target: Object.fromEntries(Object.entries(rule.target).reverse()),
          metadata: Object.fromEntries(Object.entries(rule.metadata).reverse()),
          matcherGroups: [...rule.matcherGroups].reverse(),
        },
      ],
    });
    expect(second).toEqual(first);
    expect(validatePolicyDraft(first)).toEqual([]);
    expect(createPreviewRequest(draft(), {})).toMatchObject({
      schemaVersion: 1,
      draft: { normalizedIdentity: first.normalizedIdentity },
    });
  });
  it.each([
    ["unknown field", (value: Record<string, unknown>) => (value.extra = true), "unknown_field"],
    ["bad authority", (_value: Record<string, unknown>, rule: Record<string, unknown>) => (rule.owner = { kind: "team", id: "team-1" }), "invalid_authority"],
    ["duplicate id", (value: Record<string, unknown>) => (value.rules as unknown[]).push((value.rules as unknown[])[0]), "duplicate_or_invalid_id"],
    ["cross-context target", (_value: Record<string, unknown>, rule: Record<string, unknown>) => (rule.target = { "egress.host": "example.com" }), "unknown_field"],
    ["number regex", (_value: Record<string, unknown>, rule: Record<string, unknown>) => setMatcher(rule, { field: "parameters.count", operator: "gt", value: "one" }), "invalid_operator"],
    ["unsafe path", (_value: Record<string, unknown>, rule: Record<string, unknown>) => setMatcher(rule, { field: "parameters.__proto__.x", operator: "eq", value: "x" }), "unsafe_path"],
    ["unsafe regex", (_value: Record<string, unknown>, rule: Record<string, unknown>) => setMatcher(rule, { field: "parameters.x", operator: "regex", value: "(?=x)" }), "unsafe_regex"],
  ])("rejects %s", (_name, mutate, code) => {
    const value: Record<string, unknown> = { ...structuredClone(draft()) }, rule = (value.rules as Record<string, unknown>[])[0];
    mutate(value, rule); expect(validatePolicyDraft(value).map(issue => issue.code)).toContain(code);
  });
  it("blocks sensitive literals and strips them from deterministic sample facts", () => {
    const value = draft(),
      rule = value.rules[0];
    const credential = {
      ...value,
      rules: [
        {
          ...rule,
          context: "credential.use" as const,
          target: { "credential.service": "github" },
          appliesIn: undefined,
          effect: "allow" as const,
          approval: undefined,
          matcherGroups: [
            {
              id: "g",
              mode: "all" as const,
              matchers: [
                {
                  id: "m",
                  field: "credential.secret",
                  operator: "eq" as const,
                  value: "do-not-render",
                },
              ],
            },
          ],
        },
      ],
    };
    expect(validatePolicyDraft(credential).map((issue) => issue.code)).toContain("sensitive_literal");
    expect(
      sanitizeSampleFacts("credential.use", {
        "credential.secret": "do-not-render",
        "subject.principalId": "user-1",
      }),
    ).toEqual({ "subject.principalId": "user-1" });
  });
  it.each(TARGET_CASES)("validates current target %j", (target, expected) => {
    expect(currentPolicyTargetIssueV1({ service: target["action.service"], actionId: target["action.id"], riskLevel: target["action.riskLevel"] })).toBe(expected);
    const value = draft(), changed: PolicyDraftV1 = { ...value, rules: [{ ...value.rules[0], target }] }, issues = validatePolicyDraft(changed);
    if (expected) expect(issues.map(issue => issue.code)).toContain(expected); else expect(issues).toEqual([]);
  });
  it("models approval defaults and reports rule matcher complexity once", () => {
    const value = draft(), rule = value.rules[0], tool: PolicyDraftV1 = { ...value, rules: [{ ...rule, effect: "require_approval", approval: undefined }] };
    const credential: PolicyDraftV1 = { ...value, rules: [{ ...rule, context: "credential.use", target: { "credential.service": "github" }, matcherGroups: [{ id: "g", mode: "all", matchers: [{ id: "m", field: "credential.use", operator: "eq", value: "read" }] }], appliesIn: undefined, effect: "require_approval", approval: { tier: "human", replay: "once" } }] };
    expect(validatePolicyDraft(tool)).toEqual([]); expect(validatePolicyDraft(credential)).toEqual([]); expect(validatePolicyDraft({ ...credential, rules: [{ ...credential.rules[0], effect: "allow" }] }).map(issue => issue.code)).toContain("unexpected_approval");
    const groups = Array.from({ length: 2 }, (_, group) => ({ id: "g" + group, mode: "all" as const, matchers: Array.from({ length: 9 }, (_, row) => ({ id: "m" + group + "-" + row, field: "parameters.x", operator: "eq" as const, value: row })) }));
    expect(validatePolicyDraft({ ...value, rules: [{ ...rule, matcherGroups: groups }] }).filter(issue => issue.code === "complexity_limit" && issue.path.includes("matcherGroups"))).toHaveLength(1);
    expect(POLICY_CONTEXTS["tool.action"]).toMatchObject({ publishable: true, humanApproval: true, obligations: [] }); expect(Object.values(POLICY_CONTEXTS).filter(context => context.publishable)).toHaveLength(1);
  });

});

function setMatcher(rule: Record<string, unknown>, matcher: Record<string, unknown>): void { rule.matcherGroups = [{ id: "g", mode: "all", matchers: [{ id: "m", ...matcher }] }]; }

const TARGET_CASES: readonly (readonly [Readonly<Record<string, JsonValue>>, string | null])[] = [[{ "action.service": "gmail" }, null], [{ "action.id": "gmail.send_email" }, null], [{ "action.riskLevel": "critical" }, null], [{ "action.service": "Gmail" }, "invalid_service"], [{ "action.id": "gmail" }, "invalid_action"], [{ "action.id": "gmail.Send" }, "invalid_action"], [{ "action.riskLevel": "severe" }, "unknown_risk"], [{ "action.service": "gmail", "action.id": "gmail.send" }, "invalid_target"]];
