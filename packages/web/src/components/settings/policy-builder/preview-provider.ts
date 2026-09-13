import { POLICY_CONTEXTS, validatePolicyDraft, type PolicyPreviewProvider } from "@valet/api/policy-builder";

/** Inert adapter. A future authoring API replaces this provider. It does not evaluate Rego. */
export const fixturePolicyPreviewProvider: PolicyPreviewProvider = {
  async preview(request) {
    const issues = validatePolicyDraft(request.draft);
    const unsupported = request.draft.rules.filter((rule) => !POLICY_CONTEXTS[rule.context].publishable);
    if (issues.length) return { status: "invalid", issues };
    if (unsupported.length)
      return {
        status: "unsupported",
        issues: unsupported.map((rule) => ({
          code: "unsupported_authorization_context",
          path: `rules.${rule.ruleId}.context`,
          message: "Backend source support is not available. Select Tool and action to preview.",
        })),
      };
    const rule = request.draft.rules[0];
    const rego = `package valet.authz\n\n# Inert generated-source fixture. The browser does not evaluate this source.\ncandidate_rule_0 := {"id": ${JSON.stringify(rule.ruleId)}, "effect": ${JSON.stringify(rule.effect)}} if {\n  input.kind == ${JSON.stringify(rule.context)}\n}\n`;
    return {
      status: "ready",
      identity: request.draft.normalizedIdentity,
      rego,
      data: JSON.stringify({
        schemaVersion: 1,
        draftId: request.draft.draftId,
      }),
      ranges: [{ ruleId: rule.ruleId, startLine: 4, endLine: 6 }],
    };
  },
};
