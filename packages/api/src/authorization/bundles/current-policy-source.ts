import { createHash } from "node:crypto";
import type { JsonValue } from "@valet/engine/authorization";
import { grantPolicyKey } from "../../policies/resolution.js";
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
const RISKS = new Set(["low", "medium", "high", "critical"]);
const APPLIES_IN = new Set(["any", "session", "workflow"]);
const MATCHER_OPS = new Set(["eq", "neq", "regex", "in", "not_in", "gt", "gte", "lt", "lte", "exists", "not_exists"]);
const SERVICE_ID = /^[a-z][a-z0-9_-]*$/;
const LOCAL_ACTION_ID = /^[a-z0-9][a-z0-9_.:-]*$/;
const HEX_DIGEST = /^[0-9a-f]{64}$/;
const POLICY_PATH = "policies/current-action-policy.rego";
const DATA_PATH = "data/current-action-policy.json";
const PROVENANCE_PATH = "provenance/current-action-policy.json";

export const CURRENT_POLICY_COMPLEXITY_LIMITS_V1 = Object.freeze({
  schemaVersion: 1 as const,
  maxRules: 64,
  maxMatchersPerRule: 16,
  maxTotalMatchers: 128,
  maxPathSegments: 8,
  maxRegexLength: 128,
  maxMatcherValueBytes: 768,
  maxMatcherValueNodes: 256,
  maxMatcherValueDepth: 16,
  maxTotalMatcherValueBytes: 12_288,
  maxTotalMatcherValueNodes: 2_048,
  maxPluginDefaults: 32,
  maxDynamicGrants: 32,
  maxDynamicApprovals: 32,
});

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
    ...snapshot.organizationPolicies.map((row) => normalizeRule(row, "organization", row.principalId)),
    ...snapshot.teamPolicies.map((row) => normalizeRule(row, "team", row.principalId)),
    ...snapshot.personalOverrides.map((row) => normalizeRule(row, "personal", row.userId)),
  ].filter((row) => row.revokedAtMs === null);
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
  const generated = buildPolicySource(records, pluginDefaults, riskDefaults, snapshot.bundleDefault);
  const policySource = generated.source;
  const provenanceEntries = records.map((row) => ({
    module_id: POLICY_PATH,
    rule_id: row.id,
    source_id: `${row.sourceTable}:${row.ownerType}:${row.ownerId}:${row.id}:${row.sourcePath}`,
    ...generated.ranges.get(row.id)!,
  }));
  for (const row of [...pluginDefaults, ...riskDefaults, snapshot.bundleDefault]) {
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
      revision: "aee1a9b12b1ec1e0599a53acd665b31d3bb5ea2e",
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
}): Record<string, JsonValue> {
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
  return {
    schemaVersion: 1,
    grants: [...input.grants].sort((a, b) => utf8Compare(a.id, b.id)).map((row) => ({ ...row })),
    approvals: [...input.approvals].sort((a, b) => utf8Compare(a.resolutionId, b.resolutionId)).map((row) => ({ ...row })),
  };
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
  if (rules.length > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxRules) {
    fail("complexity_limit", `Current policy snapshots support at most ${CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxRules} rules.`);
  }
  let matcherCount = 0;
  let matcherValueBytes = 0;
  let matcherValueNodes = 0;
  for (const row of rules) {
    unique(ids, row.id);
    if (row.organizationId !== snapshot.organizationId) fail("cross_organization", `Rule ${row.id} belongs to another organization.`);
    validateTarget(row.id, row);
    validateMode(row.id, row.mode);
    validTimestamp(`${row.id}.createdAtMs`, row.createdAtMs);
    validTimestamp(`${row.id}.updatedAtMs`, row.updatedAtMs);
    if (row.updatedAtMs < row.createdAtMs) fail("invalid_timestamp", `Rule ${row.id} was updated before it was created.`);
    const valueComplexity = validateMatchers(row.id, row.paramMatchers);
    if (row.paramMatchers.length > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxMatchersPerRule) {
      fail("complexity_limit", `Rule ${row.id} supports at most ${CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxMatchersPerRule} matchers.`);
    }
    matcherCount += row.paramMatchers.length;
    matcherValueBytes += valueComplexity.bytes;
    matcherValueNodes += valueComplexity.nodes;
  }
  if (matcherCount > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxTotalMatchers) {
    fail("complexity_limit", `Current policy snapshots support at most ${CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxTotalMatchers} matchers.`);
  }
  if (matcherValueBytes > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxTotalMatcherValueBytes) {
    fail("complexity_limit", `Current policy snapshots support at most ${CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxTotalMatcherValueBytes} matcher value bytes.`);
  }
  if (matcherValueNodes > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxTotalMatcherValueNodes) {
    fail("complexity_limit", `Current policy snapshots support at most ${CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxTotalMatcherValueNodes} matcher value nodes.`);
  }
  for (const row of snapshot.organizationPolicies) {
    if (row.principalType !== "org" || row.principalId !== snapshot.organizationId || row.sourceTable !== "action_policies") {
      fail("invalid_ownership", `Organization rule ${row.id} has invalid ownership or source.`);
    }
    validatePolicyLifetime(row);
  }
  for (const row of snapshot.teamPolicies) {
    if (row.principalType !== "team" || !teamIds.has(row.principalId) || row.sourceTable !== "action_policies") {
      fail("invalid_ownership", `Team rule ${row.id} has invalid ownership or source.`);
    }
    validatePolicyLifetime(row);
  }
  for (const row of snapshot.personalOverrides) {
    if (row.userId.length === 0 || row.sourceTable !== "action_policy_overrides") {
      fail("invalid_ownership", `Personal override ${row.id} has invalid ownership or source.`);
    }
  }
  const liveRules = rules.filter((row) => !("revokedAtMs" in row) || row.revokedAtMs === null);
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
  for (const row of snapshot.riskDefaults) {
    unique(ids, row.id);
    if (!RISKS.has(row.riskLevel)) fail("unknown_risk", `Risk default ${row.id} has an unknown risk level.`);
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

function validatePolicyLifetime(row: CurrentPolicySourceSnapshotV1["organizationPolicies"][number] | CurrentPolicySourceSnapshotV1["teamPolicies"][number]): void {
  if (!APPLIES_IN.has(row.appliesIn)) fail("invalid_applies_in", `Rule ${row.id} has an invalid appliesIn value.`);
  if (row.expiresAtMs !== null) {
    validTimestamp(`${row.id}.expiresAtMs`, row.expiresAtMs);
    if (row.expiresAtMs < row.createdAtMs) fail("invalid_timestamp", `Rule ${row.id} expires before creation.`);
  }
  if (row.revokedAtMs !== null) {
    validTimestamp(`${row.id}.revokedAtMs`, row.revokedAtMs);
    if (row.revokedAtMs < row.createdAtMs) fail("invalid_timestamp", `Rule ${row.id} is revoked before creation.`);
  }
}

function validateGrant(grant: CurrentRuntimeGrantSourceV1, organizationId: string): void {
  if (grant.schemaVersion !== 1) fail("grant_schema", `Grant ${grant.id} has an unsupported schema.`);
  nonEmpty("grant.id", grant.id);
  if (grant.organizationId !== organizationId) fail("cross_organization", `Grant ${grant.id} belongs to another organization.`);
  validateService(grant.service);
  validateAction(grant.service, grant.actionId);
  if (!RISKS.has(grant.riskLevel)) fail("unknown_risk", `Grant ${grant.id} has an unknown risk level.`);
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
  fail("invalid_scope", `Fact ${id} has a scope that does not match appliesIn.`);
}

function validateTarget(id: string, target: CurrentPolicyTargetV1): void {
  const count = Number(target.service !== undefined) + Number(target.actionId !== undefined) + Number(target.riskLevel !== undefined);
  if (count !== 1) fail("invalid_target", `Rule ${id} must have exactly one target.`);
  if (target.service !== undefined) validateService(target.service);
  if (target.actionId !== undefined) {
    const separator = target.actionId.indexOf(".");
    if (separator < 1) fail("invalid_action", `Rule ${id} has a malformed action ID.`);
    validateAction(target.actionId.slice(0, separator), target.actionId);
  }
  if (target.riskLevel !== undefined && !RISKS.has(target.riskLevel)) fail("unknown_risk", `Rule ${id} has an unknown risk level.`);
}

function validateMatchers(id: string, matchers: readonly CurrentPolicyMatcherV1[]): { bytes: number; nodes: number } {
  const identities = new Set<string>();
  let bytes = 0;
  let nodes = 0;
  for (const [index, matcher] of matchers.entries()) {
    if (!MATCHER_OPS.has(matcher.op)) fail("unknown_matcher", `Rule ${id} matcher ${index} has an unknown operator.`);
    const path = parseMatcherPath(matcher.path);
    if (path.length > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxPathSegments) fail("complexity_limit", `Rule ${id} matcher ${index} exceeds the path segment limit.`);
    const valueBearing = !["exists", "not_exists"].includes(matcher.op);
    if (valueBearing !== Object.hasOwn(matcher, "value")) fail("matcher_value", `Rule ${id} matcher ${index} has an invalid value.`);
    if (["in", "not_in"].includes(matcher.op) && !Array.isArray(matcher.value)) fail("matcher_value", `Rule ${id} matcher ${index} requires an array value.`);
    if (["gt", "gte", "lt", "lte"].includes(matcher.op) && (typeof matcher.value !== "number" || !Number.isFinite(matcher.value))) fail("matcher_value", `Rule ${id} matcher ${index} requires a finite number.`);
    if (matcher.op === "regex" && (typeof matcher.value !== "string" || !isLosslessRegexV1(matcher.value))) {
      fail("non_lossless_regex", `Rule ${id} matcher ${index} cannot be translated losslessly by regex subset v1.`);
    }
    assertJsonValue(`${id}.paramMatchers[${index}].value`, matcher.value, !valueBearing);
    if (valueBearing) {
      const complexity = matcherValueComplexity(matcher.value);
      bytes += complexity.bytes;
      nodes += complexity.nodes;
      if (complexity.bytes > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxMatcherValueBytes) {
        fail("complexity_limit", `Rule ${id} matcher ${index} exceeds the matcher value byte limit.`);
      }
      if (complexity.nodes > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxMatcherValueNodes) {
        fail("complexity_limit", `Rule ${id} matcher ${index} exceeds the matcher value node limit.`);
      }
      if (complexity.depth > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxMatcherValueDepth) {
        fail("complexity_limit", `Rule ${id} matcher ${index} exceeds the matcher value depth limit.`);
      }
    }
    const identity = canonicalJson(matcher);
    if (identities.has(identity)) fail("duplicate_matcher", `Rule ${id} matcher ${index} is duplicated.`);
    identities.add(identity);
  }
  return { bytes, nodes };
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

// Pinned Regorus round-trips ASCII identifier segments and canonical decimal array indexes.
const SAFE_PATH_SEGMENT_V1 = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_ARRAY_INDEX_V1 = /^(?:0|[1-9][0-9]*)$/;

function parseMatcherPath(path: string): Array<string | number> {
  const result: Array<string | number> = [];
  let index = 0;
  while (index < path.length) {
    let end = index;
    while (end < path.length && path[end] !== "." && path[end] !== "[") end += 1;
    const segment = path.slice(index, end);
    if (!SAFE_PATH_SEGMENT_V1.test(segment)) {
      fail("non_lossless_path", `Matcher path ${JSON.stringify(path)} has an unsafe segment.`);
    }
    if (["__proto__", "constructor", "prototype"].includes(segment)) fail("non_lossless_path", `Matcher path ${JSON.stringify(path)} depends on JavaScript prototype lookup.`);
    result.push(segment);
    index = end;
    while (index < path.length && path[index] === "[") {
      const close = path.indexOf("]", index);
      if (close === -1) fail("non_lossless_path", `Matcher path ${JSON.stringify(path)} has an unterminated index.`);
      const text = path.slice(index + 1, close);
      const arrayIndex = Number(text);
      if (!SAFE_ARRAY_INDEX_V1.test(text) || !Number.isSafeInteger(arrayIndex)) {
        fail("non_lossless_path", `Matcher path ${JSON.stringify(path)} has an unsafe index.`);
      }
      result.push(arrayIndex);
      index = close + 1;
    }
    if (index === path.length) break;
    if (path[index] !== ".") fail("non_lossless_path", `Matcher path ${JSON.stringify(path)} requires a separator.`);
    index += 1;
  }
  if (result.length === 0 || path.endsWith(".")) {
    fail("non_lossless_path", `Matcher path ${JSON.stringify(path)} has an empty segment.`);
  }
  return result;
}

// This ASCII grammar has the same match language in JavaScript and the pinned Regorus regex engine.
function isLosslessRegexV1(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxRegexLength) return false;
  if ([...pattern].some((char) => char.codePointAt(0)! < 0x20 || char.codePointAt(0)! > 0x7e)) return false;
  let index = pattern.startsWith("^") ? 1 : 0;
  const end = pattern.endsWith("$") && !pattern.endsWith("\\$") ? pattern.length - 1 : pattern.length;
  let atoms = 0;
  while (index < end) {
    const char = pattern[index];
    if (char === "\\") {
      if (index + 1 >= end || !"\\.^$*+?()[]{}|-".includes(pattern[index + 1])) return false;
      index += 2;
    } else if (char === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close === -1 || close >= end || !validAsciiClass(pattern.slice(index + 1, close))) return false;
      index = close + 1;
    } else {
      if (".^$*+?()[]{}|".includes(char)) return false;
      index += 1;
    }
    atoms += 1;
    if (index < end && "*+?".includes(pattern[index])) index += 1;
  }
  return atoms > 0 && index === end;
}

function validAsciiClass(content: string): boolean {
  if (content.startsWith("^")) return false;
  const body = content;
  if (body.length === 0) return false;
  for (let index = 0; index < body.length;) {
    const first = body[index];
    if (!/[A-Za-z0-9]/.test(first)) return false;
    if (body[index + 1] !== "-") {
      index += 1;
      continue;
    }
    const last = body[index + 2];
    if (last === undefined || !/[A-Za-z0-9]/.test(last) || first.charCodeAt(0) > last.charCodeAt(0)) return false;
    index += 3;
  }
  return true;
}

type NormalizedRule = ReturnType<typeof normalizeRule> & { precedenceRank?: number };
type PolicyDefault = { id: string; mode: string; sourcePath: string; service?: string; riskLevel?: string };

function buildPolicySource(
  records: readonly NormalizedRule[],
  pluginDefaults: readonly PolicyDefault[],
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
  emitWinner(lines, "org_winner", records.filter((row) => row.ownerType === "organization"), candidateNames);
  emitWinner(lines, "team_winner", records.filter((row) => row.ownerType === "team"), candidateNames);
  emitWinner(lines, "override_winner", records.filter((row) => row.ownerType === "personal"), candidateNames);
  emitDefaultCandidates(lines, ranges, pluginDefaults, "plugin", "service", "input.action.service");
  emitDefaultCandidates(lines, ranges, riskDefaults, "risk", "riskLevel", "input.action.riskLevel");
  const bundleStart = lines.length + 1;
  lines.push(`bundle_winner := ${canonicalJson({ id: bundleDefault.id, mode: bundleDefault.actionEffect, source: "bundle" })}`);
  ranges.set(bundleDefault.id, { start_line: bundleStart, end_line: lines.length });
  lines.push(...CURRENT_ACTION_POLICY_SUFFIX.trimStart().split("\n"));
  return { source: `${lines.join("\n")}\n`, ranges };
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

function emitDefaultCandidates(
  lines: string[],
  ranges: Map<string, { start_line: number; end_line: number }>,
  defaults: readonly PolicyDefault[],
  name: "plugin" | "risk",
  field: "service" | "riskLevel",
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
  const conditions = [
    row.ownerType === "team" ? `input.subject.principal.type == "team"` : row.ownerType === "personal" ? `input.subject.principal.type == "user"` : undefined,
    row.ownerType === "organization" ? undefined : `input.subject.principal.id == ${canonicalJson(row.ownerId)}`,
    row.target.kind === "action" ? `input.action.id == ${canonicalJson(row.target.value)}` : row.target.kind === "service" ? `input.action.service == ${canonicalJson(row.target.value)}` : `input.action.riskLevel == ${canonicalJson(row.target.value)}`,
    row.appliesIn === "any" ? undefined : `applies_in == ${canonicalJson(row.appliesIn)}`,
    row.expiresAtMs === null ? undefined : `input.context.evaluationTimeMs < ${row.expiresAtMs}`,
    ...row.matchers.map((matcher, matcherIndex) => matcherCondition(matcher, rowIndex, matcherIndex)),
  ];
  return conditions.filter((condition): condition is string => condition !== undefined);
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

function matcherValueComplexity(value: unknown): { bytes: number; nodes: number; depth: number } {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  let nodes = 0;
  let depth = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    depth = Math.max(depth, current.depth);
    if (nodes > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxMatcherValueNodes
      || depth > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxMatcherValueDepth) {
      return { bytes: 0, nodes, depth };
    }
    if (Array.isArray(current.value)) {
      for (const entry of current.value) stack.push({ value: entry, depth: current.depth + 1 });
    } else if (current.value !== null && typeof current.value === "object") {
      for (const entry of Object.values(current.value as Record<string, unknown>)) {
        stack.push({ value: entry, depth: current.depth + 1 });
      }
    }
  }
  return { bytes: Buffer.byteLength(canonicalJson(value)), nodes, depth };
}

function assertJsonValue(path: string, value: unknown, allowUndefined: boolean): void {
  if (value === undefined && allowUndefined) return;
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    fail("non_json_value", `${path} contains a non-finite number.`);
  }
  if (Array.isArray(value)) { value.forEach((entry, index) => assertJsonValue(`${path}[${index}]`, entry, false)); return; }
  if (typeof value === "object") { Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => assertJsonValue(`${path}.${key}`, entry, false)); return; }
  fail("non_json_value", `${path} contains a non-JSON value.`);
}

function bundleFile(path: string, mediaType: string, bytes: string): { path: string; mediaType: string; bytes: string } { return { path, mediaType, bytes }; }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function compareById<T extends { id: string }>(a: T, b: T): number { return utf8Compare(a.id, b.id); }
function evaluationRule(row: ReturnType<typeof normalizeRule> & { precedenceRank?: number }) {
  return {
    id: row.id,
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
function targetKind(row: CurrentPolicyTargetV1): string { return row.actionId !== undefined ? `action:${row.actionId}` : row.service !== undefined ? `service:${row.service}` : `risk:${row.riskLevel}`; }
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
function validateService(service: string): void { if (!SERVICE_ID.test(service)) fail("invalid_service", `Service ID ${JSON.stringify(service)} is malformed.`); }
function validateAction(service: string, action: string): void { validateService(service); const prefix = `${service}.`; if (!action.startsWith(prefix) || !LOCAL_ACTION_ID.test(action.slice(prefix.length))) fail("invalid_action", `Action ID ${JSON.stringify(action)} is not qualified by service ${JSON.stringify(service)}.`); }
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
action_context if { supported_kind }

applies_in := "session" if { input.kind == "tool.action" }
applies_in := "workflow" if { input.kind == "workflow.action" }

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
dynamic := input.facts.currentPolicy if { current_policy_present }
else := {"schemaVersion":1,"grants":[],"approvals":[]} if { true }

dynamic_valid if {
  dynamic.schemaVersion == 1
  is_array(dynamic.grants)
  is_array(dynamic.approvals)
  every grant in dynamic.grants { grant_shape_valid(grant) }
  every approval in dynamic.approvals { approval_shape_valid(approval) }
}

grant_shape_valid(grant) if {
  grant.schemaVersion == 1
  grant.organizationId == input.subject.orgId
}

approval_shape_valid(approval) if {
  approval.schemaVersion == 1
  approval.resolutionVersion == 1
  approval.organizationId == input.subject.orgId
}

workflow_id_absent(fact) if { not fact.workflowExecutionId }
workflow_id_absent(fact) if { fact.workflowExecutionId == null }
session_id_absent(fact) if { not fact.sessionId }
session_id_absent(fact) if { fact.sessionId == null }

scope_matches(fact) if {
  applies_in == "session"
  fact.appliesIn == "session"
  fact.sessionId == input.subject.sessionId
  workflow_id_absent(fact)
}
scope_matches(fact) if {
  applies_in == "workflow"
  fact.appliesIn == "workflow"
  fact.workflowExecutionId == input.subject.workflowExecutionId
  session_id_absent(fact)
}
`;

const CURRENT_ACTION_POLICY_SUFFIX = `
strict_winner(org, team) := team if { org != null; team != null; team.modeRank >= org.modeRank }
else := org if { org != null }
else := team if { team != null }
else := null if { true }

base_winner(strict, plugin, risk, bundle) := strict if { strict != null }
else := plugin if { plugin != null }
else := risk if { risk != null }
else := bundle if { true }

static_layers := layers if {
  org := org_winner
  team := team_winner
  override := override_winner
  plugin := plugin_winner
  risk := risk_winner
  strict := strict_winner(org, team)
  base := base_winner(strict, plugin, risk, bundle_winner)
  layers := {"org":org,"team":team,"override":override,"base":base}
}

grant_ids := [grant.id | grant := dynamic.grants[_]; grant.policyKey == input.action.id; grant.service == input.action.service; grant.actionId == input.action.id; grant.riskLevel == input.action.riskLevel; grant.revokedAtMs == null; grant.createdAtMs <= input.context.evaluationTimeMs; grant.expiresAtMs > input.context.evaluationTimeMs; scope_matches(grant)]
approval_ids := [approval.resolutionId | approval := dynamic.approvals[_]; approval.verdict == "approved"; approval.resolvedAtMs <= input.context.evaluationTimeMs; approval.expiresAtMs > input.context.evaluationTimeMs; approval.requestSubjectDigest == input.context.requestSubjectDigest; approval.originalDecisionDigest == input.context.originalDecisionDigest; scope_matches(approval)]
dynamic_ids := sort(array.concat(grant_ids, approval_ids))

approval_requirement := {"tier":"human","approverType":"org","replay":"once"}
result(effect, reason, ids) := object.union({"effect":effect,"reasonCode":reason,"matchedRuleIds":sort(ids),"obligations":[],"redactions":[]}, approval_field(effect))
approval_field(effect) := {"approvalRequirement":approval_requirement} if { effect == "require_approval" }
approval_field(effect) := {} if { effect != "require_approval" }

resolve(layers, ids) := result("deny", "organization_policy", [layers.org.id]) if { layers.org.mode == "deny" }
else := result("deny", "team_policy", [layers.team.id]) if { layers.team.mode == "deny" }
else := result("allow", "dynamic_grant", array.concat([layers.base.id], ids)) if { count(ids) > 0 }
else := result(layers.override.mode, "personal_override", [layers.base.id, layers.override.id]) if { layers.override != null }
else := result(layers.base.mode, concat("", [layers.base.source, "_", "policy"]), [layers.base.id]) if { layers.base.source in {"organization", "team"} }
else := result(layers.base.mode, concat("", [layers.base.source, "_", "default"]), [layers.base.id]) if { layers.base.source in {"plugin", "risk", "bundle"} }

decision := result("deny", "unsupported_authorization_context", [bundle_winner.id]) if { not action_context }
else := result("deny", "policy_input_invalid", []) if { not input_valid }
else := result("deny", "malformed_dynamic_facts", []) if { not dynamic_valid }
else := resolved if {
  layers := static_layers
  ids := dynamic_ids
  resolved := resolve(layers, ids)
}
`;
