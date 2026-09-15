import { authorizationSha256Hex, type JsonValue } from "@valet/engine/authorization";
import { CURRENT_POLICY_COMPLEXITY_LIMITS_V1, canonicalCurrentPolicyJsonV1, containsSensitiveTextV1, currentPolicyMatcherIssuesV1, currentPolicyTargetIssueV1, currentPolicyValueComplexityV1, utf16CodeUnitCompare } from "../bundles/current-policy-input-contract.js";
import { POLICY_CONTEXTS } from "./contexts.js";
import type { DraftValidationIssue, NormalizedPolicyDraftV1, PolicyDraftV1, PolicyFieldDescriptor, PolicyPreviewRequestV1, PolicyRuleDraftV1 } from "./types.js";

const IDS = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const OBJECT_KEYS = ["schemaVersion", "draftId", "rules", "normalizedIdentity"];
const RULE_KEYS = ["ruleId", "context", "authority", "owner", "subjects", "target", "matcherGroups", "effect", "appliesIn", "expiresAtMs", "approval", "obligations", "description", "metadata"];

export function validatePolicyDraft(input: unknown): DraftValidationIssue[] {
 try {
  const issues: DraftValidationIssue[] = [];
  if (!record(input)) return [issue("invalid_draft", "$", "Use a policy draft object.")];
  unknownKeys(input, OBJECT_KEYS, "$", issues);
  if (input.normalizedIdentity !== undefined && (typeof input.normalizedIdentity !== "string" || !/^policy-draft-v1:[0-9a-f]{64}$/.test(input.normalizedIdentity))) issues.push(issue("invalid_identity", "normalizedIdentity", "Use the identity produced by draft normalization."));
  if (input.schemaVersion !== 1) issues.push(issue("schema_version", "schemaVersion", "Use policy draft schema version 1."));
  if (!validId(input.draftId)) issues.push(issue("invalid_id", "draftId", "Use a stable draft ID with 1 to 128 safe characters."));
  if (!Array.isArray(input.rules) || !dense(input.rules)) return [...issues, issue("invalid_rules", "rules", "Add a dense rules array.")];
  if (input.rules.length > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxRules) issues.push(issue("complexity_limit", "rules", "Remove rules until the draft is within the current source limit."));
  const ids = new Set<string>();
  input.rules.forEach((value, index) => validateRule(value, `rules[${index}]`, ids, issues));
  const contexts = new Set(input.rules.filter(record).map(rule => rule.context)), matchers = input.rules.filter(record).flatMap(rule => Array.isArray(rule.matcherGroups) ? rule.matcherGroups.filter(record).flatMap(group => Array.isArray(group.matchers) ? group.matchers : []) : []);
  if (matchers.length > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxTotalMatchers) issues.push(issue("complexity_limit", "rules", "Remove conditions until the draft is within the current source limit."));
  const sizes = matchers.filter(record).map(matcher => currentPolicyValueComplexityV1(matcher.value)).filter((size): size is NonNullable<typeof size> => size !== null);
  if (matchers.filter(record).filter(matcher => matcher.operator === "regex").length > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxRegexMatchers || sizes.reduce((sum, size) => sum + size.bytes, 0) > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxTotalMatcherValueBytes || sizes.reduce((sum, size) => sum + size.nodes, 0) > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxTotalMatcherValueNodes) issues.push(issue("complexity_limit", "rules", "Reduce regex use or matcher value size for the current source limit."));
  if (contexts.size > 1) issues.push(issue("mixed_context", "rules", "Use one authorization context in each draft."));
  if (typeof input.normalizedIdentity === "string") { const { normalizedIdentity, ...body } = input; if (normalizedIdentity !== `policy-draft-v1:${authorizationSha256Hex(canonical(body))}`) issues.push(issue("invalid_identity", "normalizedIdentity", "Normalize the draft again before preview.")); }
  return issues;
 } catch { return [issue("invalid_draft", "$", "Use plain JSON without accessors, cycles, or unsupported values.")]; }
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
  if (record(owner)) unknownKeys(owner, ["kind", "id"], `${path}.owner`, issues);
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
  if (!Array.isArray(value.subjects) || !dense(value.subjects) || value.subjects.length === 0 || value.subjects.some((subject) => !descriptor.subjectKinds.includes(subject))) issues.push(issue("invalid_subject", `${path}.subjects`, "Select only subject kinds allowed by this context."));
  if (!descriptor.effects.includes(value.effect as never)) issues.push(issue("invalid_effect", `${path}.effect`, "Select an effect allowed by this context."));
  if (value.effect === "require_approval" && (!descriptor.humanApproval || (descriptor.publishable ? value.approval !== undefined : !record(value.approval) || typeof value.approval.tier !== "string" || !["once", "session", "workflow"].includes(String(value.approval.replay))))) issues.push(issue("unsupported_approval", `${path}.approval`, "Choose an approval-capable context and add an approval tier."));
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
  if (!Array.isArray(value.matcherGroups) || (value.matcherGroups.length === 0 && !(["tool.builtin", "api.route", "resource.access"] as string[]).includes(String(value.context)))) issues.push(issue("empty_conditions", `${path}.matcherGroups`, "Add at least one condition group."));
  else
    value.matcherGroups.forEach((group, groupIndex) => {
      if (!record(group) || !validId(group.id) || nestedIds.has(String(group.id)) || !["all", "any", "not"].includes(String(group.mode)) || !Array.isArray(group.matchers) || !dense(group.matchers) || group.matchers.length === 0 || (group.mode === "not" && group.matchers.length !== 1)) {
        issues.push(issue("invalid_group", `${path}.matcherGroups[${groupIndex}]`, "Use a non-empty all, any, or single-row not group."));
        return;
      }
      unknownKeys(group, ["id", "mode", "matchers"], `${path}.matcherGroups[${groupIndex}]`, issues);
      nestedIds.add(group.id as string);
      if (groupIndex === 0 && (value.matcherGroups as unknown[]).filter(record).reduce((count, item) => count + (Array.isArray(item.matchers) ? item.matchers.length : 0), 0) > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxMatchersPerRule) issues.push(issue("complexity_limit", `${path}.matcherGroups[${groupIndex}]`, "Remove conditions until the group has at most 16 rows."));
      group.matchers.forEach((matcher, matcherIndex) => {
        if (record(matcher) && nestedIds.has(String(matcher.id))) issues.push(issue("duplicate_or_invalid_id", `${path}.matcherGroups[${groupIndex}].matchers[${matcherIndex}].id`, "Use a unique stable row ID."));
        else if (record(matcher)) nestedIds.add(String(matcher.id));
        validateMatcher(matcher, descriptor.fields, `${path}.matcherGroups[${groupIndex}].matchers[${matcherIndex}]`, issues);
      });
    });
  if (descriptor.publishable) {
    const targetIssue = record(value.target) ? currentPolicyTargetIssueV1({ service: value.target["action.service"], actionId: value.target["action.id"], riskLevel: value.target["action.riskLevel"] }) : "invalid_target";
    if (targetIssue) issues.push(issue(targetIssue, `${path}.target`, "Use one valid service, qualified action ID, or risk level."));
    if (Array.isArray(value.matcherGroups) && value.matcherGroups.some((group) => record(group) && (group.mode !== "all" || (Array.isArray(group.matchers) && group.matchers.some((matcher) => record(matcher) && typeof matcher.field === "string" && !matcher.field.startsWith("parameters.")))))) issues.push(issue("unsupported_action_matcher", `${path}.matcherGroups`, "Use all groups and action parameter fields for the current source builder."));
    if (value.approval !== undefined || (Array.isArray(value.obligations) && value.obligations.length) || value.description !== "" || (record(value.metadata) && Object.keys(value.metadata).length)) issues.push(issue("projection_loss", path, "Remove fields that the current source preview cannot preserve."));
  }
  if (Array.isArray(value.obligations)) value.obligations.forEach((item, index) => { if (record(item)) unknownKeys(item, ["type", "paths"], `${path}.obligations[${index}]`, issues); });
  if (record(value.approval)) unknownKeys(value.approval, ["tier", "replay"], `${path}.approval`, issues);
  if (!Array.isArray(value.obligations) || value.obligations.some((obligation) => !record(obligation) || !descriptor.obligations.includes(obligation.type as never) || (obligation.paths !== undefined && (!Array.isArray(obligation.paths) || obligation.paths.some(item => typeof item !== "string"))))) issues.push(issue("unsupported_obligation", `${path}.obligations`, "Remove obligations that this context does not support."));
  if (!record(value.metadata) || Object.values(value.metadata).some((item) => typeof item !== "string") || typeof value.description !== "string") issues.push(issue("invalid_metadata", path, "Use text for the description and metadata values."));
  if (typeof value.description === "string" && (new TextEncoder().encode(value.description).length > 768 || containsSensitiveTextV1(value.description))) issues.push(issue("unsafe_text", `${path}.description`, "Remove secret-like text or shorten the description."));
  if (record(value.metadata) && (!currentPolicyValueComplexityV1(value.metadata) || currentPolicyValueComplexityV1(value.metadata)!.bytes > 768 || containsSensitiveTextV1(value.metadata as Record<string, JsonValue>))) issues.push(issue("unsafe_text", `${path}.metadata`, "Remove secret-like text or shorten the metadata."));
}

function validateMatcher(value: unknown, fields: readonly PolicyFieldDescriptor[], path: string, issues: DraftValidationIssue[]): void {
  if (!record(value) || !validId(value.id) || typeof value.field !== "string") {
    issues.push(issue("invalid_matcher", path, "Use a matcher with an ID and registered field."));
    return;
  }
  unknownKeys(value, ["id", "field", "operator", "value"], path, issues);
  const fieldPath = value.field;
  const descriptor = fields.find((field) => field.path === fieldPath || (field.path.endsWith(".*") && fieldPath.startsWith(field.path.slice(0, -1))));
  if (!descriptor) {
    issues.push(issue("unknown_field", `${path}.field`, "Select a field from this context schema."));
    return;
  }
  if (!descriptor.operators.includes(value.operator as never)) issues.push(issue("invalid_operator", `${path}.operator`, `Select an operator allowed for ${descriptor.type} fields.`));
  const noValue = value.operator === "exists" || value.operator === "not_exists";
  const typed = fieldPath.startsWith("parameters.") ? noValue ? value.value === undefined : currentPolicyValueComplexityV1(value.value) !== null && (!["in", "not_in"].includes(String(value.operator)) || Array.isArray(value.value)) : noValue ? value.value === undefined : typedValue(descriptor.type, value.value, value.operator);
  if (!typed) issues.push(issue("invalid_value", `${path}.value`, "Enter a value that matches the field type and operator."));
  if (descriptor.sensitivity !== "public" && value.value !== undefined) issues.push(issue("sensitive_literal", `${path}.value`, "Remove the sensitive literal. Use a server-held reference instead."));
  if (value.value !== undefined && currentPolicyValueComplexityV1(value.value) && containsSensitiveTextV1(value.value as JsonValue)) issues.push(issue("unsafe_value", `${path}.value`, "Remove secret-like text from the value."));
  if (fieldPath.startsWith("parameters.")) for (const code of currentPolicyMatcherIssuesV1({ path: fieldPath.slice(11), op: String(value.operator), ...(value.value === undefined ? {} : { value: value.value }) })) issues.push(issue(code, path, "Use a matcher supported by the current source builder."));
}

function validateFields(value: unknown, fields: readonly PolicyFieldDescriptor[], path: string, issues: DraftValidationIssue[], allowSensitive: boolean): void {
  if (!record(value)) {
    issues.push(issue("invalid_target", path, "Use a target object."));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const field = fields.find((candidate) => candidate.path === key);
    if (!field) issues.push(issue("unknown_field", `${path}.${String(key)}`, "Select a target field from this context schema."));
    else { const size = currentPolicyValueComplexityV1(item); if (!typedValue(field.type, item, "eq") || (typeof item === "string" && item.length === 0) || (!allowSensitive && field.sensitivity !== "public") || !size || size.bytes > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxMatcherValueBytes || containsSensitiveTextV1(item as JsonValue)) issues.push(issue("invalid_target", `${path}.${key}`, "Remove sensitive or long values and use the declared target type.")); }
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
    .sort((a, b) => utf16CodeUnitCompare(a.ruleId, b.ruleId));
  const normalized = {
    schemaVersion: 1 as const,
    draftId: input.draftId,
    rules,
  };
  return {
    ...normalized,
    normalizedIdentity: `policy-draft-v1:${authorizationSha256Hex(canonical(normalized))}`,
  };
}

export function sanitizeSampleFacts(context: keyof typeof POLICY_CONTEXTS, input: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>> {
  const allowed = POLICY_CONTEXTS[context].fields.filter((field) => field.location !== "target" && field.sensitivity === "public");
  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input)) { const size = currentPolicyValueComplexityV1(value); if (allowed.some(field => field.path === key || (field.path.endsWith(".*") && key.startsWith(field.path.slice(0, -1)))) && size && size.bytes <= 768 && size.depth <= 8 && !containsSensitiveTextV1(value)) output[key] = value; }
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
const record = (value: unknown): value is Record<string, unknown> => { if (typeof value !== "object" || value === null || Array.isArray(value)) return false; const proto = Object.getPrototypeOf(value), descriptors = Object.getOwnPropertyDescriptors(value); return (proto === Object.prototype || proto === null) && Object.values(descriptors).every(item => !item.get && !item.set); };
const dense = (value: readonly unknown[]) => Object.keys(value).length === value.length;
const validId = (value: unknown): value is string => typeof value === "string" && IDS.test(value);
const unknownKeys = (value: Record<string, unknown>, allowed: readonly string[], path: string, issues: DraftValidationIssue[]) =>
  Reflect.ownKeys(value)
    .filter((key): key is string => typeof key !== "string" || !allowed.includes(key))
    .forEach((key) => issues.push(issue("unknown_field", `${path}.${key}`, "Remove the unknown field.")));
const typedValue = (type: PolicyFieldDescriptor["type"], value: unknown, operator: unknown) =>
  operator === "in" || operator === "not_in" ? Array.isArray(value) && value.length > 0 && value.every((item) => type === "number" ? typeof item === "number" && Number.isFinite(item) && !Object.is(item, -0) : typeof item === "string") : type === "number" || type === "timestamp" ? typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0) : type === "boolean" ? typeof value === "boolean" : type === "string_set" ? Array.isArray(value) && value.every((item) => typeof item === "string") : typeof value === "string";
const canonical = canonicalCurrentPolicyJsonV1;
const byJson = (a: unknown, b: unknown) => utf16CodeUnitCompare(canonical(a), canonical(b));
const sortRecord = <T>(value: Readonly<Record<string, T>>): Record<string, T> => Object.fromEntries(Object.entries(value).sort(([a], [b]) => utf16CodeUnitCompare(a, b)));
