import { createHash } from "node:crypto";
import { BUILTIN_TOOL_NAMES, builtinAuthorization } from "@valet/engine";
import { validateCurrentPolicyDynamicFactsV2, type CurrentPolicyDynamicFactsV2, type JsonValue } from "@valet/engine/authorization";
import { CURRENT_POLICY_COMPLEXITY_LIMITS_V1, currentPolicyMatcherIssuesV1, currentPolicyTargetIssueV1, currentPolicyValueComplexityV1, isCurrentPolicyActionV1, isCurrentPolicyRiskV1, isCurrentPolicyServiceV1, parseCurrentPolicyMatcherPathV1 } from "./current-policy-input-contract.js";
export { CURRENT_POLICY_COMPLEXITY_LIMITS_V1 } from "./current-policy-input-contract.js";
import { grantPolicyKey } from "../../policies/service.js";
import type { CanonicalSourceBundle } from "./types.js";
import type {
  CurrentApprovalResolutionSourceV1,
  CurrentPersonalOverrideV1,
  CurrentPolicyMatcherV1,
  CurrentPolicySourceSnapshotV1,
  CurrentPolicyTargetV1,
  CurrentRuntimeGrantSourceV1,
} from "./current-policy-types.js";

const MODES = new Set(["allow", "require_approval", "deny"]);
const APPLIES_IN = new Set(["any", "session", "workflow"]);
const MATCHER_OPS = new Set(["eq", "neq", "regex", "in", "not_in", "gt", "gte", "lt", "lte", "exists", "not_exists"]);
const HEX_DIGEST = /^[0-9a-f]{64}$/;
const POLICY_PATH = "policies/current-action-policy.rego";
const DATA_PATH = "data/current-action-policy.json";
const PROVENANCE_PATH = "provenance/current-action-policy.json";

export interface BuiltCurrentPolicySourceV1 {
  readonly bundle: CanonicalSourceBundle;
  readonly policySource: string;
  readonly canonicalData: string;
  readonly sourceMetadata: Readonly<{
    schemaVersion: 1;
    organizationId: string;
    sourceRevision: string;
    ruleCount: number;
  }>;
}

export class CurrentPolicySourceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CurrentPolicySourceError";
  }
}

export function buildCurrentPolicySource(snapshot: CurrentPolicySourceSnapshotV1): BuiltCurrentPolicySourceV1 {
  validateSnapshot(snapshot);
  const rawRecords = [
    ...snapshot.organizationPolicies.filter(activeRule).map((row) => normalizeRule(row, "organization", row.principalId)),
    ...snapshot.teamPolicies.filter(activeRule).map((row) => normalizeRule(row, "team", row.principalId)),
    ...snapshot.personalOverrides.filter(activeRule).map((row) => normalizeRule(row, "personal", row.userId)),
  ];
  const rankById = new Map<string, number>();
  const owners = new Set(rawRecords.map((row) => `${row.ownerType}\0${row.ownerId}`));
  for (const owner of owners) {
    rawRecords
      .filter((row) => `${row.ownerType}\0${row.ownerId}` === owner)
      .sort(compareRulePrecedence)
      .forEach((row, index) => rankById.set(row.id, index + 1));
  }
  const records = rawRecords
    .map((row) => ({ ...row, precedenceRank: rankById.get(row.id) }))
    .sort(compareById);
  const pluginDefaults = [...snapshot.pluginDefaults]
    .map((row) => ({ id: row.id, mode: row.mode, service: row.service, sourcePath: row.sourcePath }))
    .sort(compareById);
  const builtinDefaults = [...(snapshot.builtinDefaults ?? canonicalBuiltinDefaults())].map((row) => ({ id: row.id, mode: row.mode, actionId: row.actionId, capability: row.capability, riskLevel: row.riskLevel, sourcePath: row.sourcePath })).sort(compareById);
  const riskDefaults = [...snapshot.riskDefaults]
    .map((row) => ({ id: row.id, mode: row.mode, riskLevel: row.riskLevel, sourcePath: row.sourcePath }))
    .sort(compareById);
  const data = canonicalJson({
    valet: {
      authz: {
        schemaVersion: 1,
        organizationId: snapshot.organizationId,
        organizationRules: records.filter((row) => row.ownerType === "organization").sort(compareCanonicalPrecedence).map(evaluationRule),
        teamRules: records.filter((row) => row.ownerType === "team").sort(compareCanonicalPrecedence).map(evaluationRule),
        personalOverrides: records.filter((row) => row.ownerType === "personal").sort(compareCanonicalPrecedence).map(evaluationRule),
        matchersByRule: Object.fromEntries(records.map((row) => [row.id, row.matchers])),
        pluginDefaults,
        riskDefaults,
        bundleDefault: snapshot.bundleDefault,
      },
    },
  });
  const generated = buildPolicySource(records, pluginDefaults, builtinDefaults, riskDefaults, snapshot.bundleDefault);
  const policySource = generated.source;
  const provenanceEntries = records.map((row) => ({
    module_id: POLICY_PATH,
    rule_id: row.id,
    source_id: `${row.sourceTable}:${row.ownerType}:${row.ownerId}:${row.id}:${row.sourcePath}`,
    ...generated.ranges.get(row.id)!,
  }));
  for (const row of [...pluginDefaults, ...builtinDefaults, ...riskDefaults, snapshot.bundleDefault]) {
    provenanceEntries.push({
      module_id: POLICY_PATH,
      rule_id: row.id,
      source_id: `default:${row.id}:${row.sourcePath}`,
      ...generated.ranges.get(row.id)!,
    });
  }
  provenanceEntries.sort((a, b) => utf8Compare(a.rule_id, b.rule_id));
  const provenance = canonicalJson({ entries: provenanceEntries });
  const files = [
    bundleFile(DATA_PATH, "application/json", data),
    bundleFile(POLICY_PATH, "application/vnd.valet.rego.v1", policySource),
    bundleFile(PROVENANCE_PATH, "application/vnd.valet.policy-provenance.v1+json", provenance),
  ].sort((a, b) => utf8Compare(a.path, b.path));
  const manifest = canonicalJson({
    schemaVersion: 1,
    mediaType: "application/vnd.valet.policy-source-bundle.v1+json",
    policyVersion: snapshot.policyVersion,
    engineName: "valet-policy-engine",
    engineVersion: "0.1.0",
    capabilityProfileVersion: 1,
    interpreter: {
      name: "regorus",
      version: "0.12.0",
      revision: "309ba35067d2118aafd696198a33037f5af9e1bd",
    },
    contractVersion: 1,
    regoVersion: "v1",
    entrypoint: "data.valet.authz.decision",
    source: { origin: "valet-current-action-policy-builder", license: "UNLICENSED", revision: snapshot.sourceRevision },
    files: files.map((file) => ({
      path: file.path,
      mediaType: file.mediaType,
      byteLength: Buffer.byteLength(file.bytes),
      sha256: sha256(file.bytes),
    })),
  });
  return Object.freeze({
    bundle: Object.freeze({
      manifestJson: manifest,
      files: Object.freeze(files.map(({ path, bytes }) => Object.freeze({ path, contentBase64: Buffer.from(bytes).toString("base64") }))),
    }),
    policySource,
    canonicalData: data,
    sourceMetadata: Object.freeze({
      schemaVersion: 1,
      organizationId: snapshot.organizationId,
      sourceRevision: snapshot.sourceRevision,
      ruleCount: records.length,
    }),
  });
}

function canonicalBuiltinDefaults() {
  return Object.freeze(BUILTIN_TOOL_NAMES.map((name) => {
    const descriptor = builtinAuthorization(name);
    return Object.freeze({ id: `builtin-default:${name}`, actionId: descriptor.actionId, capability: descriptor.capability, riskLevel: descriptor.riskLevel, mode: descriptor.riskLevel === "high" || descriptor.riskLevel === "critical" ? "require_approval" as const : "allow" as const, sourcePath: `standard/builtin/${name}` });
  }));
}

export function standardNewOrganizationPolicySnapshot(
  organizationId: string,
  sourceRevision = "standard-new-organization-v1",
): CurrentPolicySourceSnapshotV1 {
  nonEmpty("organizationId", organizationId);
  return Object.freeze({
    schemaVersion: 1,
    organizationId,
    policyVersion: "current-action-policy-v1",
    sourceRevision,
    teamIds: Object.freeze([]),
    organizationPolicies: Object.freeze([]),
    teamPolicies: Object.freeze([]),
    personalOverrides: Object.freeze([]),
    pluginDefaults: Object.freeze([]),
    builtinDefaults: canonicalBuiltinDefaults(),
    riskDefaults: Object.freeze([
      Object.freeze({ id: "risk:critical", riskLevel: "critical", mode: "require_approval", sourcePath: "standard/risk/critical" }),
      Object.freeze({ id: "risk:high", riskLevel: "high", mode: "require_approval", sourcePath: "standard/risk/high" }),
      Object.freeze({ id: "risk:low", riskLevel: "low", mode: "allow", sourcePath: "standard/risk/low" }),
      Object.freeze({ id: "risk:medium", riskLevel: "medium", mode: "allow", sourcePath: "standard/risk/medium" }),
    ]),
    bundleDefault: Object.freeze({
      id: "bundle:action-default",
      actionEffect: "require_approval",
      unsupportedContextEffect: "deny",
      sourcePath: "standard/bundle-default",
    }),
  });
}

export function buildCurrentPolicyDynamicFacts(input: {
  readonly organizationId: string;
  readonly grants: readonly CurrentRuntimeGrantSourceV1[];
  readonly approvals: readonly CurrentApprovalResolutionSourceV1[];
}): CurrentPolicyDynamicFactsV2 {
  nonEmpty("organizationId", input.organizationId);
  if (input.grants.length > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxDynamicGrants) {
    fail("complexity_limit", `Current policy input supports at most ${CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxDynamicGrants} grants.`);
  }
  if (input.approvals.length > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxDynamicApprovals) {
    fail("complexity_limit", `Current policy input supports at most ${CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxDynamicApprovals} approvals.`);
  }
  const ids = new Set<string>();
  for (const grant of input.grants) {
    validateGrant(grant, input.organizationId);
    unique(ids, `grant:${grant.id}`);
  }
  for (const approval of input.approvals) {
    validateApproval(approval, input.organizationId);
    unique(ids, `approval:${approval.resolutionId}`);
  }
  const bindings = input.approvals.map((row) => [row.requestSubjectDigest, row.originalDecisionDigest, row.appliesIn, row.sessionId ?? row.workflowExecutionId!] as JsonValue[]);
  if (new Set(bindings.map(canonicalJson)).size > 1) fail("approval_binding_limit", "Current policy input supports one approval binding set.");
  return validateCurrentPolicyDynamicFactsV2({ schemaVersion: 2, organizationId: input.organizationId,
    grants: [...input.grants].sort((a, b) => utf8Compare(a.id, b.id)).map((row) => [row.id, row.policyKey, row.service, row.actionId, row.riskLevel, row.appliesIn, row.sessionId ?? row.workflowExecutionId!, row.createdAtMs, row.expiresAtMs, row.revokedAtMs]),
    approvalBinding: bindings[0] ?? null,
    approvals: [...input.approvals].sort((a, b) => utf8Compare(a.resolutionId, b.resolutionId)).map((row) => [row.resolutionId, row.verdict, row.resolvedAtMs, row.expiresAtMs, row.resolutionVersion]),
  }, { organizationId: input.organizationId });
}

function validateSnapshot(snapshot: CurrentPolicySourceSnapshotV1): void {
  if (snapshot.schemaVersion !== 1) fail("snapshot_schema", "Current policy snapshot schemaVersion must be 1.");
  nonEmpty("organizationId", snapshot.organizationId);
  nonEmpty("policyVersion", snapshot.policyVersion);
  nonEmpty("sourceRevision", snapshot.sourceRevision);
  const ids = new Set<string>();
  const teamIds = new Set<string>();
  for (const teamId of snapshot.teamIds) {
    nonEmpty("teamId", teamId);
    if (teamIds.has(teamId)) fail("duplicate_team", `Team identity ${teamId} is duplicated.`);
    teamIds.add(teamId);
  }
  const rules = [...snapshot.organizationPolicies, ...snapshot.teamPolicies, ...snapshot.personalOverrides];
  for (const row of rules) {
    unique(ids, row.id);
    if (row.organizationId !== snapshot.organizationId) fail("cross_organization", `Rule ${row.id} belongs to another organization.`);
    validTimestamp(`${row.id}.createdAtMs`, row.createdAtMs);
    validTimestamp(`${row.id}.updatedAtMs`, row.updatedAtMs);
    if (row.updatedAtMs < row.createdAtMs) fail("invalid_timestamp", `Rule ${row.id} was updated before it was created.`);
    validateRevocation(row);
  }
  for (const row of snapshot.organizationPolicies) {
    if (row.principalType !== "org" || row.principalId !== snapshot.organizationId || row.sourceTable !== "action_policies") fail("invalid_ownership", `Organization rule ${row.id} has invalid ownership or source.`);
    validatePolicyTimestamps(row);
  }
  for (const row of snapshot.teamPolicies) {
    if (row.principalType !== "team" || !teamIds.has(row.principalId) || row.sourceTable !== "action_policies") fail("invalid_ownership", `Team rule ${row.id} has invalid ownership or source.`);
    validatePolicyTimestamps(row);
  }
  for (const row of snapshot.personalOverrides) {
    if (row.userId.length === 0 || row.sourceTable !== "action_policy_overrides") fail("invalid_ownership", `Personal override ${row.id} has invalid ownership or source.`);
  }

  const liveRules = rules.filter(activeRule);
  if (liveRules.length > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxRules) fail("complexity_limit", `Current policy snapshots support at most ${CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxRules} active rules.`);
  let matcherCount = 0;
  let regexCount = 0;
  let matcherValueBytes = 0;
  let matcherValueNodes = 0;
  for (const row of liveRules) {
    if (row.authorizationKind !== undefined && row.authorizationKind !== "tool.action" && row.authorizationKind !== "tool.builtin" && row.authorizationKind !== "api.route" && row.authorizationKind !== "resource.access") fail("unknown_authorization_kind", `Rule ${row.id} has an unknown authorization kind.`);
    validateTarget(row.id, row);
    validateMode(row.id, row.mode);
    if ("appliesIn" in row) validatePolicySemantics(row);
    const valueComplexity = validateMatchers(row.id, row.paramMatchers);
    if (row.paramMatchers.length > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxMatchersPerRule) fail("complexity_limit", `Rule ${row.id} supports at most ${CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxMatchersPerRule} active matchers.`);
    matcherCount += row.paramMatchers.length;
    regexCount += row.paramMatchers.filter((matcher) => matcher.op === "regex").length;
    matcherValueBytes += valueComplexity.bytes;
    matcherValueNodes += valueComplexity.nodes;
  }
  if (regexCount > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxRegexMatchers) fail("complexity_limit", `Current policy snapshots support at most ${CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxRegexMatchers} regex matchers.`);
  if (matcherCount > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxTotalMatchers) fail("complexity_limit", `Current policy snapshots support at most ${CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxTotalMatchers} matchers.`);
  if (matcherValueBytes > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxTotalMatcherValueBytes) fail("complexity_limit", `Current policy snapshots support at most ${CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxTotalMatcherValueBytes} matcher value bytes.`);
  if (matcherValueNodes > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxTotalMatcherValueNodes) fail("complexity_limit", `Current policy snapshots support at most ${CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxTotalMatcherValueNodes} matcher value nodes.`);
  for (const [index, row] of liveRules.entries()) {
    for (const other of liveRules.slice(index + 1)) {
      if (rulesCanTie(row, other)) {
        fail("ambiguous_identity", `Rules ${row.id} and ${other.id} have an ambiguous co-match at equal precedence.`);
      }
    }
  }
  if (snapshot.pluginDefaults.length > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxPluginDefaults) {
    fail("complexity_limit", `Current policy snapshots support at most ${CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxPluginDefaults} plugin defaults.`);
  }
  for (const row of snapshot.pluginDefaults) {
    unique(ids, row.id);
    validateService(row.service);
    validateMode(row.id, row.mode);
    nonEmpty(`${row.id}.sourcePath`, row.sourcePath);
  }
  if (new Set(snapshot.pluginDefaults.map((row) => row.service)).size !== snapshot.pluginDefaults.length) {
    fail("duplicate_default", "Plugin defaults contain a duplicate service.");
  }
  for (const row of snapshot.builtinDefaults ?? canonicalBuiltinDefaults()) { unique(ids, row.id); validateAction("builtin", row.actionId); validateMode(row.id, row.mode); if (!row.capability) fail("invalid_builtin_default", `Built-in default ${row.id} has no capability.`); if (!isCurrentPolicyRiskV1(row.riskLevel)) fail("unknown_risk", `Built-in default ${row.id} has an unknown risk level.`); nonEmpty(`${row.id}.sourcePath`, row.sourcePath); }
  const builtinDefaults = snapshot.builtinDefaults ?? canonicalBuiltinDefaults();
  if (new Set(builtinDefaults.map((row) => row.actionId)).size !== builtinDefaults.length) fail("duplicate_default", "Built-in defaults contain a duplicate action.");
  for (const row of snapshot.riskDefaults) {
    unique(ids, row.id);
    if (!isCurrentPolicyRiskV1(row.riskLevel)) fail("unknown_risk", `Risk default ${row.id} has an unknown risk level.`);
    validateMode(row.id, row.mode);
    nonEmpty(`${row.id}.sourcePath`, row.sourcePath);
  }
  if (new Set(snapshot.riskDefaults.map((row) => row.riskLevel)).size !== snapshot.riskDefaults.length) {
    fail("duplicate_default", "Risk defaults contain a duplicate risk level.");
  }
  unique(ids, snapshot.bundleDefault.id);
  if (snapshot.bundleDefault.actionEffect !== "require_approval" || snapshot.bundleDefault.unsupportedContextEffect !== "deny") {
    fail("invalid_bundle_default", "Bundle defaults must require approval for actions and deny unsupported contexts.");
  }
  nonEmpty("bundleDefault.sourcePath", snapshot.bundleDefault.sourcePath);
}

type SnapshotRule = CurrentPolicySourceSnapshotV1["organizationPolicies"][number] | CurrentPolicySourceSnapshotV1["teamPolicies"][number] | CurrentPersonalOverrideV1;
function activeRule(row: SnapshotRule): boolean { return row.revokedAtMs === undefined || row.revokedAtMs === null; }
function validateRevocation(row: SnapshotRule): void {
  if (row.revokedAtMs === undefined || row.revokedAtMs === null) return;
  validTimestamp(`${row.id}.revokedAtMs`, row.revokedAtMs);
  if (row.revokedAtMs < row.createdAtMs) fail("invalid_timestamp", `Rule ${row.id} is revoked before creation.`);
}
function validatePolicyTimestamps(row: CurrentPolicySourceSnapshotV1["organizationPolicies"][number] | CurrentPolicySourceSnapshotV1["teamPolicies"][number]): void {
  if (row.expiresAtMs === null) return;
  validTimestamp(`${row.id}.expiresAtMs`, row.expiresAtMs);
  if (row.expiresAtMs < row.createdAtMs) fail("invalid_timestamp", `Rule ${row.id} expires before creation.`);
}
function validatePolicySemantics(row: CurrentPolicySourceSnapshotV1["organizationPolicies"][number] | CurrentPolicySourceSnapshotV1["teamPolicies"][number]): void {
  if (!APPLIES_IN.has(row.appliesIn)) fail("invalid_applies_in", `Rule ${row.id} has an invalid appliesIn value.`);
}

function validateGrant(grant: CurrentRuntimeGrantSourceV1, organizationId: string): void {
  if (grant.schemaVersion !== 1) fail("grant_schema", `Grant ${grant.id} has an unsupported schema.`);
  nonEmpty("grant.id", grant.id);
  if (grant.organizationId !== organizationId) fail("cross_organization", `Grant ${grant.id} belongs to another organization.`);
  validateService(grant.service);
  validateAction(grant.service, grant.actionId);
  if (!isCurrentPolicyRiskV1(grant.riskLevel)) fail("unknown_risk", `Grant ${grant.id} has an unknown risk level.`);
  if (grant.policyKey !== grantPolicyKey(grant.service, grant.actionId)) fail("invalid_policy_key", `Grant ${grant.id} has an invalid policy key.`);
  validateScope(grant.id, grant.appliesIn, grant.sessionId, grant.workflowExecutionId);
  nonEmpty(`${grant.id}.issuerId`, grant.issuerId);
  nonEmpty(`${grant.id}.sourceApprovalId`, grant.sourceApprovalId);
  validTimestamp(`${grant.id}.createdAtMs`, grant.createdAtMs);
  validTimestamp(`${grant.id}.expiresAtMs`, grant.expiresAtMs);
  if (grant.expiresAtMs <= grant.createdAtMs) fail("invalid_timestamp", `Grant ${grant.id} does not expire after creation.`);
  if (grant.revokedAtMs !== null) {
    validTimestamp(`${grant.id}.revokedAtMs`, grant.revokedAtMs);
    if (grant.revokedAtMs < grant.createdAtMs) fail("invalid_timestamp", `Grant ${grant.id} is revoked before creation.`);
  }
}

function validateApproval(fact: CurrentApprovalResolutionSourceV1, organizationId: string): void {
  if (fact.schemaVersion !== 1 || fact.resolutionVersion !== 1) fail("approval_schema", `Approval ${fact.resolutionId} has an unsupported schema.`);
  for (const [name, value] of [["resolutionId", fact.resolutionId], ["approvalId", fact.approvalId], ["gateId", fact.gateId], ["approverId", fact.approverId]] as const) nonEmpty(`approval.${name}`, value);
  if (fact.organizationId !== organizationId) fail("cross_organization", `Approval ${fact.resolutionId} belongs to another organization.`);
  if (!HEX_DIGEST.test(fact.requestSubjectDigest) || !HEX_DIGEST.test(fact.originalDecisionDigest)) fail("invalid_digest", `Approval ${fact.resolutionId} has an invalid binding digest.`);
  if (fact.verdict !== "approved" && fact.verdict !== "rejected") fail("invalid_verdict", `Approval ${fact.resolutionId} has an invalid verdict.`);
  validateScope(fact.resolutionId, fact.appliesIn, fact.sessionId, fact.workflowExecutionId);
  validTimestamp(`${fact.resolutionId}.resolvedAtMs`, fact.resolvedAtMs);
  validTimestamp(`${fact.resolutionId}.expiresAtMs`, fact.expiresAtMs);
  if (fact.expiresAtMs <= fact.resolvedAtMs) fail("invalid_timestamp", `Approval ${fact.resolutionId} does not expire after resolution.`);
}

function validateScope(id: string, appliesIn: string, sessionId: string | undefined, workflowId: string | undefined): void {
  if (appliesIn === "session" && nonBlank(sessionId) && workflowId === undefined) return;
  if (appliesIn === "workflow" && nonBlank(workflowId) && sessionId === undefined) return;
  if ((appliesIn === "route" || appliesIn === "resource") && nonBlank(sessionId) && workflowId === undefined) return;
  fail("invalid_scope", `Fact ${id} has a scope that does not match appliesIn.`);
}

function validateTarget(id: string, target: CurrentPolicyTargetV1): void { const code = currentPolicyTargetIssueV1(target); if (code) fail(code, `Rule ${id} has an invalid target.`); }
function validateMatchers(id: string, matchers: readonly CurrentPolicyMatcherV1[]): { bytes: number; nodes: number } {
  const identities = new Set<string>();
  let bytes = 0;
  let nodes = 0;
  for (const [index, matcher] of matchers.entries()) {
    if (!MATCHER_OPS.has(matcher.op)) fail("unknown_matcher", `Rule ${id} matcher ${index} has an unknown operator.`);
    const path = parseMatcherPath(matcher.path);
    if (path.length > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxPathSegments) fail("complexity_limit", `Rule ${id} matcher ${index} exceeds the path segment limit.`);
    const matcherIssues = currentPolicyMatcherIssuesV1(matcher);
    if (matcherIssues.length) fail(matcherIssues[0] === "unsafe_regex" ? "non_lossless_regex" : matcherIssues[0], `Rule ${id} matcher ${index} cannot be translated losslessly by the current input contract.`);
    if (Object.hasOwn(matcher, "value")) { const complexity = currentPolicyValueComplexityV1(matcher.value)!; bytes += complexity.bytes; nodes += complexity.nodes; }
    const identity = canonicalJson(matcher);
    if (identities.has(identity)) fail("duplicate_matcher", `Rule ${id} matcher ${index} is duplicated.`);
    identities.add(identity);
  }
  return { bytes, nodes };
}

function parseMatcherPath(path: string): Array<string | number> {
  const result = parseCurrentPolicyMatcherPathV1(path);
  if (result === null) fail("non_lossless_path", `Matcher path ${JSON.stringify(path)} does not use the lossless path grammar.`);
  return result;
}

function normalizeRule(
  row: CurrentPolicySourceSnapshotV1["organizationPolicies"][number] | CurrentPolicySourceSnapshotV1["teamPolicies"][number] | CurrentPersonalOverrideV1,
  ownerType: "organization" | "team" | "personal",
  ownerId: string,
) {
  const target = row.actionId !== undefined
    ? { kind: "action", value: row.actionId, specificity: 3 }
    : row.service !== undefined
      ? { kind: "service", value: row.service, specificity: 2 }
      : { kind: "risk", value: row.riskLevel, specificity: 1 };
  return {
    id: row.id,
    authorizationKind: row.authorizationKind ?? "tool.action",
    ownerType,
    ownerId,
    sourceTable: row.sourceTable,
    sourcePath: row.sourcePath ?? `${row.sourceTable}/${row.id}`,
    target,
    mode: row.mode,
    modeRank: row.mode === "deny" ? 3 : row.mode === "require_approval" ? 2 : 1,
    matchers: row.paramMatchers
      .map((matcher) => ({ ...matcher, segments: parseMatcherPath(matcher.path) }))
      .sort((a, b) => utf8Compare(canonicalJson(a), canonicalJson(b))),
    appliesIn: "appliesIn" in row ? row.appliesIn : "any",
    expiresAtMs: "expiresAtMs" in row ? row.expiresAtMs : null,
    revokedAtMs: "revokedAtMs" in row ? row.revokedAtMs : null,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

type NormalizedRule = ReturnType<typeof normalizeRule> & { precedenceRank?: number };
type PolicyDefault = { id: string; mode: string; sourcePath: string; service?: string; actionId?: string; capability?: string; riskLevel?: string };

function buildPolicySource(
  records: readonly NormalizedRule[],
  pluginDefaults: readonly PolicyDefault[],
  builtinDefaults: readonly PolicyDefault[],
  riskDefaults: readonly PolicyDefault[],
  bundleDefault: CurrentPolicySourceSnapshotV1["bundleDefault"],
): { source: string; ranges: ReadonlyMap<string, { start_line: number; end_line: number }> } {
  const lines = CURRENT_ACTION_POLICY_PREFIX.trimEnd().split("\n");
  const ranges = new Map<string, { start_line: number; end_line: number }>();
  const candidateNames = new Map<string, string>();
  for (const [index, row] of [...records].sort(compareById).entries()) {
    const name = `candidate_rule_${index}`;
    candidateNames.set(row.id, name);
    const startLine = lines.length + 1;
    row.matchers.forEach((matcher, matcherIndex) => {
      if (matcher.op === "exists" || matcher.op === "not_exists") {
        lines.push(`path_${index}_${matcherIndex}_found if { _ = ${regoPath(matcher.segments)} }`);
      }
    });
    lines.push(`${name} := ${regoRow(row)} if {`);
    for (const condition of ruleConditions(row, index)) lines.push(`  ${condition}`);
    lines.push("}");
    ranges.set(row.id, { start_line: startLine, end_line: lines.length });
  }
  emitRegexInputLimit(lines, records);
  emitWinner(lines, "org_winner", records.filter((row) => row.ownerType === "organization"), candidateNames);
  emitWinner(lines, "team_winner", records.filter((row) => row.ownerType === "team"), candidateNames);
  emitWinner(lines, "override_winner", records.filter((row) => row.ownerType === "personal"), candidateNames);
  emitDefaultCandidates(lines, ranges, pluginDefaults, "plugin", "service", "input.action.service");
  emitBuiltinDefaults(lines, ranges, builtinDefaults);
  emitDefaultCandidates(lines, ranges, riskDefaults, "risk", "riskLevel", "input.action.riskLevel");
  const bundleStart = lines.length + 1;
  lines.push(`bundle_winner := ${canonicalJson({ id: bundleDefault.id, mode: bundleDefault.actionEffect, source: "bundle" })}`);
  ranges.set(bundleDefault.id, { start_line: bundleStart, end_line: lines.length });
  emitFactWinner(lines, "grant", 8);
  emitFactWinner(lines, "approval", 8);
  lines.push(...CURRENT_ACTION_POLICY_SUFFIX.trimStart().split("\n"));
  return { source: `${lines.join("\n")}\n`, ranges };
}

function emitRegexInputLimit(lines: string[], records: readonly NormalizedRule[]): void {
  const guards: string[] = [];
  records.forEach((row, rowIndex) => row.matchers.forEach((matcher, matcherIndex) => {
    if (matcher.op !== "regex") return;
    const guard = `regex_target_${rowIndex}_${matcherIndex}_oversized`;
    guards.push(guard);
    lines.push(`${guard} if { ${ruleApplicabilityConditions(row).join("; ")}; value := ${regoPath(matcher.segments)}; is_string(value); count(value) > 256 }`);
  }));
  lines.push(guards.length ? `regex_input_valid if { ${guards.map((guard) => `not ${guard}`).join("; ")} }` : "regex_input_valid if { true }");
}
function emitFactWinner(lines: string[], kind: "grant" | "approval", limit: number): void {
  const facts = kind === "grant" ? "grants" : "approvals";
  const match = kind === "grant" ? "input.kind in {\"tool.action\",\"workflow.action\"}; count(fact) == 10; fact[1] == input.action.id; fact[2] == input.action.service; fact[3] == input.action.id; fact[4] == input.action.riskLevel; scope_matches(fact); fact[9] == null; fact[7] <= input.context.evaluationTimeMs; fact[8] > input.context.evaluationTimeMs" : "input.facts.currentPolicy.approvalBinding[0] == input.context.requestSubjectDigest; input.facts.currentPolicy.approvalBinding[1] == input.context.originalDecisionDigest; approval_scope_matches; count(fact) == 5; fact[4] == 1; fact[1] == \"approved\"; fact[2] <= input.context.evaluationTimeMs; fact[3] > input.context.evaluationTimeMs";
  for (let i=0;i<limit;i++) lines.push(`${i ? "else" : kind+"_winner"} := fact[0] if { fact := input.facts.currentPolicy.${facts}[${i}]; ${match} }`);
  lines.push("else := null if { true }");
}

function emitWinner(lines: string[], name: string, records: readonly NormalizedRule[], candidates: ReadonlyMap<string, string>): void {
  const ordered = [...records].sort(compareCanonicalPrecedence);
  if (ordered.length === 0) { lines.push(`${name} := null`); return; }
  ordered.forEach((row, index) => {
    const candidate = candidates.get(row.id);
    if (candidate === undefined) fail("internal_builder", `Missing generated candidate for rule ${row.id}.`);
    lines.push(`${index === 0 ? `${name} := value if { value := ` : "else := value if { value := "}${candidate} }`);
  });
  lines.push("else := null if { true }");
}

function emitBuiltinDefaults(lines: string[], ranges: Map<string, { start_line: number; end_line: number }>, defaults: readonly PolicyDefault[]): void {
  for (const row of [...defaults].sort(compareById)) { const line = lines.length + 1; lines.push(`builtin_default[${canonicalJson(row.actionId)}] := ${canonicalJson({ id: row.id, mode: row.mode, source: "builtin" })}`); ranges.set(row.id, { start_line: line, end_line: line }); }
  lines.push("builtin_winner := builtin_default[input.action.id] if { input.kind == \"tool.builtin\" }");
  lines.push("else := null if { true }");
}

function emitDefaultCandidates(
  lines: string[],
  ranges: Map<string, { start_line: number; end_line: number }>,
  defaults: readonly PolicyDefault[],
  name: "plugin" | "builtin" | "risk",
  field: "service" | "actionId" | "riskLevel",
  inputRef: string,
): void {
  const candidates: string[] = [];
  for (const [index, row] of [...defaults].sort(compareById).entries()) {
    const candidate = `${name}_default_${index}`;
    const value = row[field];
    const startLine = lines.length + 1;
    lines.push(`${candidate} := ${canonicalJson({ id: row.id, mode: row.mode, source: name })} if { ${inputRef} == ${canonicalJson(value)} }`);
    ranges.set(row.id, { start_line: startLine, end_line: lines.length });
    candidates.push(candidate);
  }
  if (candidates.length === 0) { lines.push(`${name}_winner := null`); return; }
  candidates.forEach((candidate, index) => lines.push(`${index === 0 ? `${name}_winner := value if { value := ` : "else := value if { value := "}${candidate} }`));
  lines.push("else := null if { true }");
}

function ruleConditions(row: NormalizedRule, rowIndex: number): string[] {
  return [...ruleApplicabilityConditions(row), ...row.matchers.map((matcher, matcherIndex) => matcherCondition(matcher, rowIndex, matcherIndex))];
}

function ruleApplicabilityConditions(row: NormalizedRule): string[] {
  return [
    row.authorizationKind === "tool.action" ? `input.kind in {"tool.action","workflow.action"}` : `input.kind == ${canonicalJson(row.authorizationKind)}`,
    row.ownerType === "team" ? `input.subject.principal.type == "team"` : row.ownerType === "personal" ? `input.subject.principal.type == "user"` : undefined,
    row.ownerType === "organization" ? undefined : `input.subject.principal.id == ${canonicalJson(row.ownerId)}`,
    row.target.kind === "action" ? `input.action.id == ${canonicalJson(row.target.value)}` : row.target.kind === "service" ? `input.action.service == ${canonicalJson(row.target.value)}` : `input.action.riskLevel == ${canonicalJson(row.target.value)}`,
    row.appliesIn === "any" ? undefined : `applies_in == ${canonicalJson(row.appliesIn)}`,
    row.expiresAtMs === null ? undefined : `input.context.evaluationTimeMs < ${row.expiresAtMs}`,
  ].filter((condition): condition is string => condition !== undefined);
}

function matcherCondition(matcher: NormalizedRule["matchers"][number], rowIndex: number, matcherIndex: number): string {
  const path = regoPath(matcher.segments);
  const value = (): string => canonicalJson(matcher.value);
  switch (matcher.op) {
    case "exists": return `path_${rowIndex}_${matcherIndex}_found`;
    case "not_exists": return `not path_${rowIndex}_${matcherIndex}_found`;
    case "eq": return `${path} == ${value()}`;
    case "neq": return `not ${path} == ${value()}`;
    case "regex": return `is_string(${path}); regex.match(${value()}, ${path})`;
    case "in": return `${path} in ${value()}`;
    case "not_in": return `not ${path} in ${value()}`;
    case "gt": return `is_number(${path}); ${path} > ${value()}`;
    case "gte": return `is_number(${path}); ${path} >= ${value()}`;
    case "lt": return `is_number(${path}); ${path} < ${value()}`;
    case "lte": return `is_number(${path}); ${path} <= ${value()}`;
  }
}

function regoPath(segments: readonly (string | number)[]): string {
  return `input.action.parameters${segments.map((segment) => `[${canonicalJson(segment)}]`).join("")}`;
}

function regoRow(row: NormalizedRule): string {
  return canonicalJson({ id: row.id, mode: row.mode, modeRank: row.modeRank, source: row.ownerType });
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("non_json_value", "Canonical policy data contains a non-finite number.");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => utf16Compare(a, b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  fail("non_json_value", "Canonical policy data contains a non-JSON value.");
}

function bundleFile(path: string, mediaType: string, bytes: string): { path: string; mediaType: string; bytes: string } { return { path, mediaType, bytes }; }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function compareById<T extends { id: string }>(a: T, b: T): number { return utf8Compare(a.id, b.id); }
function evaluationRule(row: ReturnType<typeof normalizeRule> & { precedenceRank?: number }) {
  return {
    id: row.id,
    authorizationKind: row.authorizationKind,
    ownerType: row.ownerType,
    ...(row.ownerType === "organization" ? {} : { ownerId: row.ownerId }),
    target: { kind: row.target.kind, value: row.target.value },
    mode: row.mode,
    modeRank: row.modeRank,
    appliesIn: row.appliesIn,
    expiresAtMs: row.expiresAtMs,
    revokedAtMs: row.revokedAtMs,
    matcherCount: row.matchers.length,
    precedenceRank: row.precedenceRank,
  };
}
function compareRulePrecedence(a: ReturnType<typeof normalizeRule>, b: ReturnType<typeof normalizeRule>): number {
  return a.target.specificity - b.target.specificity || a.modeRank - b.modeRank || a.updatedAtMs - b.updatedAtMs || utf8Compare(a.id, b.id);
}
function compareCanonicalPrecedence(a: { precedenceRank?: number; id: string }, b: { precedenceRank?: number; id: string }): number {
  return (b.precedenceRank ?? 0) - (a.precedenceRank ?? 0) || utf8Compare(a.id, b.id);
}
function utf8Compare(a: string, b: string): number { return Buffer.compare(Buffer.from(a), Buffer.from(b)); }
function utf16Compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function targetKind(row: CurrentPolicyTargetV1): string { return `${row.authorizationKind ?? "tool.action"}:` + (row.actionId !== undefined ? `action:${row.actionId}` : row.service !== undefined ? `service:${row.service}` : `risk:${row.riskLevel}`); }
function rulesCanTie(
  left: CurrentPolicySourceSnapshotV1["organizationPolicies"][number] | CurrentPolicySourceSnapshotV1["teamPolicies"][number] | CurrentPersonalOverrideV1,
  right: CurrentPolicySourceSnapshotV1["organizationPolicies"][number] | CurrentPolicySourceSnapshotV1["teamPolicies"][number] | CurrentPersonalOverrideV1,
): boolean {
  const leftOwner = "principalId" in left ? `${left.principalType}:${left.principalId}` : `personal:${left.userId}`;
  const rightOwner = "principalId" in right ? `${right.principalType}:${right.principalId}` : `personal:${right.userId}`;
  const leftScope = "appliesIn" in left ? left.appliesIn : "any";
  const rightScope = "appliesIn" in right ? right.appliesIn : "any";
  return leftOwner === rightOwner
    && targetKind(left) === targetKind(right)
    && left.mode === right.mode
    && left.updatedAtMs === right.updatedAtMs
    && (leftScope === "any" || rightScope === "any" || leftScope === rightScope)
    && !matchersAreDisjoint(left.paramMatchers, right.paramMatchers);
}
function matchersAreDisjoint(left: readonly CurrentPolicyMatcherV1[], right: readonly CurrentPolicyMatcherV1[]): boolean {
  return left.some((a) => a.op === "eq" && right.some((b) => b.op === "eq" && a.path === b.path && canonicalJson(a.value) !== canonicalJson(b.value)));
}
function validateMode(id: string, mode: string): void { if (!MODES.has(mode)) fail("unknown_mode", `Rule ${id} has an unknown mode.`); }
function validateService(service: string): void { if (!isCurrentPolicyServiceV1(service)) fail("invalid_service", `Service ID ${JSON.stringify(service)} is malformed.`); }
function validateAction(service: string, action: string): void { validateService(service); const prefix = `${service}.`; if (!isCurrentPolicyActionV1(action) || !action.startsWith(prefix)) fail("invalid_action", `Action ID ${JSON.stringify(action)} is not qualified by service ${JSON.stringify(service)}.`); }
function validTimestamp(path: string, value: number): void { if (!Number.isSafeInteger(value) || value < 0) fail("invalid_timestamp", `${path} must be a non-negative integer timestamp.`); }
function nonEmpty(path: string, value: string): void { if (value.length === 0) fail("empty_identity", `${path} must not be empty.`); }
function nonBlank(value: string | undefined): value is string { return value !== undefined && value.length > 0; }
function unique(seen: Set<string>, id: string): void { nonEmpty("id", id); if (seen.has(id)) fail("duplicate_id", `Source identity ${id} is duplicated.`); seen.add(id); }
function fail(code: string, message: string): never { throw new CurrentPolicySourceError(code, message); }

// The fixed kernel validates input facts. Generated candidates use direct paths.
const CURRENT_ACTION_POLICY_PREFIX = `package valet.authz
import rego.v1

policy := data.valet.authz

supported_kind if { input.kind == "tool.action" }
supported_kind if { input.kind == "workflow.action" }
supported_kind if { input.kind == "tool.builtin" }
supported_kind if { input.kind == "api.route" }
supported_kind if { input.kind == "resource.access" }
action_context if { supported_kind }

applies_in := "session" if { input.kind == "tool.action" }
applies_in := "workflow" if { input.kind == "workflow.action" }
applies_in := "session" if { input.kind == "tool.builtin" }
applies_in := "route" if { input.kind == "api.route" }
applies_in := "resource" if { input.kind == "resource.access" }

input_valid if {
  input.schemaVersion == 1
  input.subject.orgId == policy.organizationId
  is_string(input.action.service)
  is_string(input.action.id)
  startswith(input.action.id, concat("", [input.action.service, "."]))
  input.action.riskLevel in {"low", "medium", "high", "critical"}
  is_number(input.context.evaluationTimeMs)
  supported_kind
}

current_policy_present if { _ = input.facts.currentPolicy }
dynamic_valid if { not current_policy_present }
dynamic_valid if { input.facts.currentPolicy.schemaVersion == 2; input.facts.currentPolicy.organizationId == input.subject.orgId; is_array(input.facts.currentPolicy.grants); is_array(input.facts.currentPolicy.approvals); count(input.facts.currentPolicy.grants) <= 8; count(input.facts.currentPolicy.approvals) <= 8; approval_binding_valid }
approval_binding_valid if { count(input.facts.currentPolicy.approvals) == 0; input.facts.currentPolicy.approvalBinding == null }
approval_binding_valid if { count(input.facts.currentPolicy.approvals) > 0; is_array(input.facts.currentPolicy.approvalBinding); count(input.facts.currentPolicy.approvalBinding) == 4 }
scope_matches(fact) if { applies_in == "session"; fact[5] == "session"; fact[6] == input.subject.sessionId }
scope_matches(fact) if { applies_in == "workflow"; fact[5] == "workflow"; fact[6] == input.subject.workflowExecutionId }
approval_scope_matches if { applies_in == "session"; input.facts.currentPolicy.approvalBinding[2] == "session"; input.facts.currentPolicy.approvalBinding[3] == input.subject.sessionId }
approval_scope_matches if { applies_in == "workflow"; input.facts.currentPolicy.approvalBinding[2] == "workflow"; input.facts.currentPolicy.approvalBinding[3] == input.subject.workflowExecutionId }
approval_scope_matches if { applies_in == "route"; input.facts.currentPolicy.approvalBinding[2] == "route"; input.facts.currentPolicy.approvalBinding[3] == input.context.approvalScopeId }
approval_scope_matches if { applies_in == "resource"; input.facts.currentPolicy.approvalBinding[2] == "resource"; input.facts.currentPolicy.approvalBinding[3] == input.context.approvalScopeId }
`;

const CURRENT_ACTION_POLICY_SUFFIX = `
strict_winner(org, team) := team if { org != null; team != null; team.modeRank >= org.modeRank }
else := org if { org != null }
else := team if { team != null }
else := null if { true }

base_winner(strict, plugin, builtin, risk, bundle) := strict if { strict != null }
else := plugin if { input.kind != "tool.builtin"; plugin != null }
else := builtin if { input.kind == "tool.builtin"; builtin != null }
else := risk if { risk != null }
else := bundle if { true }

static_layers := layers if {
  input.kind == "tool.builtin"
  org := org_winner
  team := team_winner
  override := override_winner
  builtin := builtin_winner
  risk := risk_winner
  strict := strict_winner(org, team)
  base := base_winner(strict, null, builtin, risk, bundle_winner)
  layers := {"org":org,"team":team,"override":override,"base":base}
}
static_layers := layers if {
  input.kind in {"api.route","resource.access"}
  org := org_winner
  team := team_winner
  override := override_winner
  strict := strict_winner(org, team)
  base := strict_winner(strict, {"id":"standard.authenticated_access","mode":"allow","modeRank":1,"source":"bundle"})
  layers := {"org":org,"team":team,"override":override,"base":base}
}
static_layers := layers if {
  input.kind in {"tool.action","workflow.action"}
  org := org_winner
  team := team_winner
  override := override_winner
  plugin := plugin_winner
  risk := risk_winner
  strict := strict_winner(org, team)
  base := base_winner(strict, plugin, null, risk, bundle_winner)
  layers := {"org":org,"team":team,"override":override,"base":base}
}

dynamic_ids := [grant_winner] if { grant_winner != null }
else := [approval_winner] if { approval_winner != null }
else := [] if { true }

approval_requirement := {"tier":"human","approverType":"org","replay":"once"}
result(effect, reason, ids) := object.union({"effect":effect,"reasonCode":reason,"matchedRuleIds":sort(ids),"obligations":[],"redactions":[]}, approval_field(effect))
approval_field(effect) := {"approvalRequirement":approval_requirement} if { effect == "require_approval" }
approval_field(effect) := {} if { effect != "require_approval" }

resolve(layers, ids) := result("deny", "organization_policy", [layers.org.id]) if { layers.org.mode == "deny" }
else := result("deny", "team_policy", [layers.team.id]) if { layers.team.mode == "deny" }
else := result("allow", "dynamic_grant", array.concat([layers.base.id], ids)) if { count(ids) > 0 }
else := result(layers.override.mode, "personal_override", [layers.base.id, layers.override.id]) if { layers.override != null }
else := result(layers.base.mode, concat("", [layers.base.source, "_", "policy"]), [layers.base.id]) if { layers.base.source in {"organization", "team"} }
else := result(layers.base.mode, concat("", [layers.base.source, "_", "default"]), [layers.base.id]) if { layers.base.source in {"plugin", "builtin", "risk", "bundle"} }

decision := result("deny", "unsupported_authorization_context", [bundle_winner.id]) if { not action_context }
else := result("deny", "policy_input_invalid", []) if { not input_valid }
else := result("deny", "input_limit", []) if { not regex_input_valid }
else := result("deny", "malformed_dynamic_facts", []) if { not dynamic_valid }
else := resolved if {
  layers := static_layers
  ids := dynamic_ids
  resolved := resolve(layers, ids)
}
`;
