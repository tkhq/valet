import type { JsonValue } from "@valet/engine/authorization";
import { CURRENT_POLICY_COMPLEXITY_LIMITS_V1, isLosslessRegexV1, parseCurrentPolicyMatcherPathV1 } from "../bundles/current-policy-input-contract.js";
import { POLICY_CONTEXTS } from "./contexts.js";
import type { DraftValidationIssue, NormalizedPolicyDraftV1, PolicyDraftV1, PolicyFieldDescriptor, PolicyPreviewRequestV1, PolicyRuleDraftV1 } from "./types.js";

const IDS = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const SECRET_WORD = /(secret|token|credential|private.?key|password)/i;
const OBJECT_KEYS = ["schemaVersion", "draftId", "rules", "normalizedIdentity"];
const RULE_KEYS = ["ruleId", "context", "authority", "owner", "subjects", "target", "matcherGroups", "effect", "appliesIn", "expiresAtMs", "approval", "obligations", "description", "metadata"];

export function validatePolicyDraft(input: unknown): DraftValidationIssue[] {
  const issues: DraftValidationIssue[] = [];
  if (!record(input)) return [issue("invalid_draft", "$", "Use a policy draft object.")];
  unknownKeys(input, OBJECT_KEYS, "$", issues);
  if (input.normalizedIdentity !== undefined && (typeof input.normalizedIdentity !== "string" || !input.normalizedIdentity.startsWith("policy-draft-v1:"))) issues.push(issue("invalid_identity", "normalizedIdentity", "Use the identity produced by draft normalization."));
  if (input.schemaVersion !== 1) issues.push(issue("schema_version", "schemaVersion", "Use policy draft schema version 1."));
  if (!validId(input.draftId)) issues.push(issue("invalid_id", "draftId", "Use a stable draft ID with 1 to 128 safe characters."));
  if (!Array.isArray(input.rules)) return [...issues, issue("invalid_rules", "rules", "Add a rules array.")];
  const ids = new Set<string>();
  input.rules.forEach((value, index) => validateRule(value, `rules[${index}]`, ids, issues));
  return issues;
}

function validateRule(value: unknown, path: string, ids: Set<string>, issues: DraftValidationIssue[]): void {
  if (!record(value)) {
    issues.push(issue("invalid_rule", path, "Use a rule object."));
    return;
  }
  unknownKeys(value, RULE_KEYS, path, issues);
  if (!validId(value.ruleId) || ids.has(String(value.ruleId))) issues.push(issue("duplicate_or_invalid_id", `${path}.ruleId`, "Use a unique stable rule ID."));
  else ids.add(value.ruleId as string);
  if (typeof value.context !== "string" || !(value.context in POLICY_CONTEXTS)) {
    issues.push(issue("unknown_context", `${path}.context`, "Select a registered authorization context."));
    return;
  }
  const descriptor = POLICY_CONTEXTS[value.context as keyof typeof POLICY_CONTEXTS];
  const authority = value.authority;
  const owner = value.owner;
  if (
    !["organization", "team", "personal", "session", "workflow"].includes(String(authority)) ||
    !record(owner) ||
    !validId(owner.id) ||
    (
      {
        organization: "org",
        team: "team",
        personal: "user",
        session: "session",
        workflow: "workflow",
      } as const
    )[authority as PolicyRuleDraftV1["authority"]] !== owner.kind
  )
    issues.push(issue("invalid_authority", `${path}.authority`, "Match the owner kind to the selected authority scope."));
  if (!Array.isArray(value.subjects) || value.subjects.some((subject) => !descriptor.subjectKinds.includes(subject))) issues.push(issue("invalid_subject", `${path}.subjects`, "Select only subject kinds allowed by this context."));
  if (!descriptor.effects.includes(value.effect as never)) issues.push(issue("invalid_effect", `${path}.effect`, "Select an effect allowed by this context."));
  if (value.effect === "require_approval" && (!descriptor.humanApproval || !record(value.approval) || typeof value.approval.tier !== "string")) issues.push(issue("unsupported_approval", `${path}.approval`, "Choose an approval-capable context and add an approval tier."));
  if (value.effect !== "require_approval" && value.approval !== undefined) issues.push(issue("unexpected_approval", `${path}.approval`, "Remove approval settings or require approval."));
  if (descriptor.appliesIn ? !["any", "session", "workflow"].includes(String(value.appliesIn)) : value.appliesIn !== undefined) issues.push(issue("invalid_applies_in", `${path}.appliesIn`, "Use appliesIn only for action and workflow contexts."));
  if (value.expiresAtMs !== undefined && (!Number.isSafeInteger(value.expiresAtMs) || Number(value.expiresAtMs) <= 0)) issues.push(issue("invalid_expiry", `${path}.expiresAtMs`, "Enter a valid future expiry timestamp."));
  validateFields(
    value.target,
    descriptor.fields.filter((field) => field.location === "target"),
    `${path}.target`,
    issues,
    false,
  );
  const nestedIds = new Set<string>();
  if (!Array.isArray(value.matcherGroups) || value.matcherGroups.length === 0) issues.push(issue("empty_conditions", `${path}.matcherGroups`, "Add at least one condition group."));
  else
    value.matcherGroups.forEach((group, groupIndex) => {
      if (!record(group) || !validId(group.id) || nestedIds.has(String(group.id)) || !["all", "any", "not"].includes(String(group.mode)) || !Array.isArray(group.matchers) || group.matchers.length === 0 || (group.mode === "not" && group.matchers.length !== 1)) {
        issues.push(issue("invalid_group", `${path}.matcherGroups[${groupIndex}]`, "Use a non-empty all, any, or single-row not group."));
        return;
      }
      nestedIds.add(group.id as string);
      if (group.matchers.length > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxMatchersPerRule) issues.push(issue("complexity_limit", `${path}.matcherGroups[${groupIndex}]`, "Remove conditions until the group has at most 16 rows."));
      group.matchers.forEach((matcher, matcherIndex) => {
        if (record(matcher) && nestedIds.has(String(matcher.id))) issues.push(issue("duplicate_or_invalid_id", `${path}.matcherGroups[${groupIndex}].matchers[${matcherIndex}].id`, "Use a unique stable row ID."));
        else if (record(matcher)) nestedIds.add(String(matcher.id));
        validateMatcher(matcher, descriptor.fields, `${path}.matcherGroups[${groupIndex}].matchers[${matcherIndex}]`, issues);
      });
    });
  if (descriptor.publishable) {
    const targetCount = ["action.service", "action.id", "action.riskLevel"].filter((key) => record(value.target) && typeof value.target[key] === "string" && value.target[key] !== "").length;
    if (targetCount !== 1) issues.push(issue("contradictory_scope", `${path}.target`, "Choose exactly one service, action, or risk target."));
    if (Array.isArray(value.matcherGroups) && value.matcherGroups.some((group) => record(group) && (group.mode !== "all" || (Array.isArray(group.matchers) && group.matchers.some((matcher) => record(matcher) && typeof matcher.field === "string" && !matcher.field.startsWith("parameters.")))))) issues.push(issue("unsupported_action_matcher", `${path}.matcherGroups`, "Use all groups and action parameter fields for the current source builder."));
  }
  if (!Array.isArray(value.obligations) || value.obligations.some((obligation) => !record(obligation) || !descriptor.obligations.includes(obligation.type as never))) issues.push(issue("unsupported_obligation", `${path}.obligations`, "Remove obligations that this context does not support."));
  if (!record(value.metadata) || Object.values(value.metadata).some((item) => typeof item !== "string") || typeof value.description !== "string") issues.push(issue("invalid_metadata", path, "Use text for the description and metadata values."));
}

function validateMatcher(value: unknown, fields: readonly PolicyFieldDescriptor[], path: string, issues: DraftValidationIssue[]): void {
  if (!record(value) || !validId(value.id) || typeof value.field !== "string") {
    issues.push(issue("invalid_matcher", path, "Use a matcher with an ID and registered field."));
    return;
  }
  const fieldPath = value.field;
  const descriptor = fields.find((field) => field.path === fieldPath || (field.path.endsWith(".*") && fieldPath.startsWith(field.path.slice(0, -1))));
  if (!descriptor) {
    issues.push(issue("unknown_field", `${path}.field`, "Select a field from this context schema."));
    return;
  }
  if (!descriptor.operators.includes(value.operator as never)) issues.push(issue("invalid_operator", `${path}.operator`, `Select an operator allowed for ${descriptor.type} fields.`));
  const noValue = value.operator === "exists" || value.operator === "not_exists";
  if (noValue ? value.value !== undefined : !typedValue(descriptor.type, value.value, value.operator)) issues.push(issue("invalid_value", `${path}.value`, "Enter a value that matches the field type and operator."));
  if (descriptor.sensitivity !== "public" && value.value !== undefined) issues.push(issue("sensitive_literal", `${path}.value`, "Remove the sensitive literal. Use a server-held reference instead."));
  if (typeof value.value === "string" && (value.value.length > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxMatcherValueBytes || SECRET_WORD.test(value.value))) issues.push(issue("unsafe_value", `${path}.value`, "Remove secret-like text or shorten the value."));
  if (fieldPath.startsWith("parameters.") && (parseCurrentPolicyMatcherPathV1(fieldPath.slice(11)) === null || fieldPath.split(/[.[]/).length > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxPathSegments)) issues.push(issue("unsafe_path", `${path}.field`, "Use the safe action parameter path grammar and at most eight segments."));
  if (value.operator === "regex" && (typeof value.value !== "string" || !isLosslessRegexV1(value.value))) issues.push(issue("unsafe_regex", `${path}.value`, "Use the lossless ASCII regex subset and at most 64 characters."));
}

function validateFields(value: unknown, fields: readonly PolicyFieldDescriptor[], path: string, issues: DraftValidationIssue[], allowSensitive: boolean): void {
  if (!record(value)) {
    issues.push(issue("invalid_target", path, "Use a target object."));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const field = fields.find((candidate) => candidate.path === key);
    if (!field) issues.push(issue("unknown_field", `${path}.${key}`, "Select a target field from this context schema."));
    else if (!typedValue(field.type, item, "eq") || (typeof item === "string" && item.length === 0) || (!allowSensitive && field.sensitivity !== "public")) issues.push(issue("invalid_target", `${path}.${key}`, "Remove sensitive literals and use the declared target type."));
  }
}

export function normalizePolicyDraft(input: PolicyDraftV1): NormalizedPolicyDraftV1 {
  const issues = validatePolicyDraft(input);
  if (issues.length) throw new TypeError(issues.map((value) => value.message).join(" "));
  const rules = input.rules
    .map((rule) => ({
      ...rule,
      subjects: [...rule.subjects].sort(),
      target: sortRecord(rule.target),
      metadata: sortRecord(rule.metadata),
      obligations: [...rule.obligations]
        .map((value) => ({
          ...value,
          paths: value.paths && [...value.paths].sort(),
        }))
        .sort(byJson),
      matcherGroups: [...rule.matcherGroups]
        .map((group) => ({
          ...group,
          matchers: [...group.matchers].sort(byJson),
        }))
        .sort(byJson),
    }))
    .sort((a, b) => a.ruleId.localeCompare(b.ruleId));
  const normalized = {
    schemaVersion: 1 as const,
    draftId: input.draftId,
    rules,
  };
  return {
    ...normalized,
    normalizedIdentity: `policy-draft-v1:${canonical(normalized)}`,
  };
}

export function sanitizeSampleFacts(context: keyof typeof POLICY_CONTEXTS, input: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>> {
  const allowed = POLICY_CONTEXTS[context].fields.filter((field) => field.location !== "target" && field.sensitivity === "public");
  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input)) if (allowed.some((field) => field.path === key) && canonical(value).length <= 768 && depth(value) <= 8) output[key] = value;
  return sortRecord(output);
}
export function createPreviewRequest(draft: PolicyDraftV1, facts: Readonly<Record<string, JsonValue>>): PolicyPreviewRequestV1 {
  const normalized = normalizePolicyDraft(draft);
  const context = normalized.rules[0]?.context ?? "tool.action";
  return {
    schemaVersion: 1,
    draft: normalized,
    sampleFacts: sanitizeSampleFacts(context, facts),
  };
}

const issue = (code: string, path: string, message: string): DraftValidationIssue => ({ code, path, message });
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === "string" && IDS.test(value);
const unknownKeys = (value: Record<string, unknown>, allowed: readonly string[], path: string, issues: DraftValidationIssue[]) =>
  Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .forEach((key) => issues.push(issue("unknown_field", `${path}.${key}`, "Remove the unknown field.")));
const typedValue = (type: PolicyFieldDescriptor["type"], value: unknown, operator: unknown) =>
  operator === "in" || operator === "not_in" ? Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === (type === "number" ? "number" : "string")) : type === "number" || type === "timestamp" ? typeof value === "number" && Number.isFinite(value) : type === "boolean" ? typeof value === "boolean" : type === "string_set" ? Array.isArray(value) && value.every((item) => typeof item === "string") : typeof value === "string";
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => (record(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item));
const byJson = (a: unknown, b: unknown) => canonical(a).localeCompare(canonical(b));
const sortRecord = <T>(value: Readonly<Record<string, T>>): Record<string, T> => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
const depth = (value: JsonValue): number => (typeof value !== "object" || value === null ? 0 : 1 + Math.max(0, ...Object.values(value).map(depth)));
