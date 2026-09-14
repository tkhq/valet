import type { CurrentOrganizationPolicyV1, CurrentPersonalOverrideV1, CurrentPolicyMatcherV1, CurrentPolicySourceSnapshotV1, CurrentTeamPolicyV1 } from "../bundles/current-policy-types.js";
import { standardNewOrganizationPolicySnapshot } from "../bundles/current-policy-source.js";
import type { NormalizedPolicyDraftV1, PolicyRuleDraftV1 } from "./types.js";

/** API-side adapter from the normalized browser contract to the PR 6 source snapshot. */
export function projectActionDraftToCurrentSnapshot(draft: NormalizedPolicyDraftV1, organizationId: string): CurrentPolicySourceSnapshotV1 {
  const base = standardNewOrganizationPolicySnapshot(organizationId, draft.normalizedIdentity);
  const organizationPolicies: CurrentOrganizationPolicyV1[] = [],
    teamPolicies: CurrentTeamPolicyV1[] = [],
    personalOverrides: CurrentPersonalOverrideV1[] = [];
  const teamIds = new Set<string>();
  for (const rule of draft.rules) {
    if (rule.context !== "tool.action" && rule.context !== "tool.builtin") throw new TypeError("Current source projection supports action and built-in tool contexts only.");
    if (rule.context === "tool.builtin" && rule.matcherGroups.some((group) => group.matchers.length > 0)) throw new TypeError("Built-in tool rules do not support content matchers.");
    if (rule.matcherGroups.some((group) => group.mode !== "all")) throw new TypeError("Current source projection supports all matcher groups only.");
    if (rule.description || Object.keys(rule.metadata).length || rule.obligations.length || rule.approval) throw new TypeError("Current source projection rejects fields that the source snapshot cannot preserve.");
    if (rule.subjects.length !== 1 || rule.subjects[0] !== rule.owner.kind) throw new TypeError("Current source projection rejects subject scope loss.");
    if (rule.authority === "personal" && (rule.appliesIn !== "any" || rule.expiresAtMs !== undefined)) throw new TypeError("Personal overrides cannot preserve scope or expiry.");
    const target = rule.context === "tool.builtin" ? builtinTarget(rule) : actionTarget(rule),
      paramMatchers = rule.matcherGroups.flatMap((group) =>
        group.matchers.map(
          (matcher) =>
            ({
              path: matcher.field.slice("parameters.".length),
              op: matcher.operator,
              ...(matcher.value === undefined ? {} : { value: matcher.value }),
            }) as CurrentPolicyMatcherV1,
        ),
      );
    const common = {
      id: rule.ruleId,
      organizationId,
      authorizationKind: rule.context as "tool.action" | "tool.builtin",
      ...target,
      mode: rule.effect,
      paramMatchers,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    if (rule.authority === "organization" && rule.owner.kind === "org" && rule.owner.id === organizationId)
      organizationPolicies.push({
        ...common,
        principalType: "org",
        principalId: organizationId,
        appliesIn: rule.appliesIn ?? "any",
        expiresAtMs: rule.expiresAtMs ?? null,
        revokedAtMs: null,
        sourceTable: "action_policies",
        sourcePath: `builder/${draft.draftId}/${rule.ruleId}`,
      });
    else if (rule.authority === "team" && rule.owner.kind === "team") {
      teamIds.add(rule.owner.id);
      teamPolicies.push({
        ...common,
        principalType: "team",
        principalId: rule.owner.id,
        appliesIn: rule.appliesIn ?? "any",
        expiresAtMs: rule.expiresAtMs ?? null,
        revokedAtMs: null,
        sourceTable: "action_policies",
        sourcePath: `builder/${draft.draftId}/${rule.ruleId}`,
      });
    } else if (rule.authority === "personal" && rule.owner.kind === "user")
      personalOverrides.push({
        ...common,
        userId: rule.owner.id,
        sourceTable: "action_policy_overrides",
        sourcePath: `builder/${draft.draftId}/${rule.ruleId}`,
      });
    else throw new TypeError("Current source projection does not support this authority and owner pair.");
  }
  return {
    ...base,
    teamIds: [...teamIds].sort(),
    organizationPolicies,
    teamPolicies,
    personalOverrides,
  };
}
function actionTarget(rule: PolicyRuleDraftV1): Pick<CurrentOrganizationPolicyV1, "service" | "actionId" | "riskLevel"> {
  const entries = [
    ["service", rule.target["action.service"]],
    ["actionId", rule.target["action.id"]],
    ["riskLevel", rule.target["action.riskLevel"]],
  ].filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0);
  if (entries.length !== 1) throw new TypeError("Current action rules require exactly one service, action, or risk target.");
  return { [entries[0][0]]: entries[0][1] };
}

function builtinTarget(rule: PolicyRuleDraftV1): Pick<CurrentOrganizationPolicyV1, "service" | "actionId" | "riskLevel"> {
  const target = actionTarget(rule);
  if (target.actionId !== undefined && !target.actionId.startsWith("builtin.")) throw new TypeError("Built-in action targets require a canonical built-in action ID.");
  if (target.service !== undefined && target.service !== "builtin") throw new TypeError("Built-in service targets must use the builtin service.");
  return target;
}
