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
  const policySource = CURRENT_ACTION_POLICY_REGO.replace("# GENERATED_MATCHER_RULES", buildMatcherRules(records));
  const endLine = policySource.split("\n").length - 1;
  const provenanceEntries = records.map((row) => ({
    module_id: POLICY_PATH,
    rule_id: row.id,
    source_id: `${row.sourceTable}:${row.ownerType}:${row.ownerId}:${row.id}:${row.sourcePath}`,
    start_line: 1,
    end_line: endLine,
  }));
  for (const row of [...pluginDefaults, ...riskDefaults, snapshot.bundleDefault]) {
    provenanceEntries.push({
      module_id: POLICY_PATH,
      rule_id: row.id,
      source_id: `default:${row.id}:${row.sourcePath}`,
      start_line: 1,
      end_line: endLine,
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
  for (const row of rules) {
    unique(ids, row.id);
    if (row.organizationId !== snapshot.organizationId) fail("cross_organization", `Rule ${row.id} belongs to another organization.`);
    validateTarget(row.id, row);
    validateMode(row.id, row.mode);
    validTimestamp(`${row.id}.createdAtMs`, row.createdAtMs);
    validTimestamp(`${row.id}.updatedAtMs`, row.updatedAtMs);
    if (row.updatedAtMs < row.createdAtMs) fail("invalid_timestamp", `Rule ${row.id} was updated before it was created.`);
    validateMatchers(row.id, row.paramMatchers);
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
  const ambiguous = new Set<string>();
  for (const row of rules) {
    const owner = "principalId" in row ? row.principalId : row.userId;
    const authority = "principalType" in row ? row.principalType : "personal";
    const identity = canonicalJson([authority, owner, targetKind(row), row.mode, row.updatedAtMs]);
    if (ambiguous.has(identity)) fail("ambiguous_identity", `Rule ${row.id} has an ambiguous equal-precedence identity.`);
    ambiguous.add(identity);
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

function validateMatchers(id: string, matchers: readonly CurrentPolicyMatcherV1[]): void {
  const identities = new Set<string>();
  for (const [index, matcher] of matchers.entries()) {
    const identity = canonicalJson(matcher);
    if (identities.has(identity)) fail("duplicate_matcher", `Rule ${id} matcher ${index} is duplicated.`);
    identities.add(identity);
    if (!MATCHER_OPS.has(matcher.op)) fail("unknown_matcher", `Rule ${id} matcher ${index} has an unknown operator.`);
    const path = parseMatcherPath(matcher.path);
    if (path.length > 128) fail("matcher_path", `Rule ${id} matcher ${index} exceeds the path limit.`);
    const valueBearing = !["exists", "not_exists"].includes(matcher.op);
    if (valueBearing !== Object.hasOwn(matcher, "value")) fail("matcher_value", `Rule ${id} matcher ${index} has an invalid value.`);
    if (["in", "not_in"].includes(matcher.op) && !Array.isArray(matcher.value)) fail("matcher_value", `Rule ${id} matcher ${index} requires an array value.`);
    if (["gt", "gte", "lt", "lte"].includes(matcher.op) && (typeof matcher.value !== "number" || !Number.isFinite(matcher.value))) fail("matcher_value", `Rule ${id} matcher ${index} requires a finite number.`);
    if (matcher.op === "regex") {
      if (typeof matcher.value !== "string" || hasNonLosslessRegexFeature(matcher.value)) fail("non_lossless_regex", `Rule ${id} matcher ${index} cannot be translated losslessly to the canonical engine.`);
      try { new RegExp(matcher.value); } catch { fail("invalid_regex", `Rule ${id} matcher ${index} has an invalid regular expression.`); }
    }
    assertJsonValue(`${id}.paramMatchers[${index}].value`, matcher.value, !valueBearing);
  }
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

function parseMatcherPath(path: string): Array<string | number> {
  const result: Array<string | number> = [];
  if (path === "") return result;
  let index = 0;
  while (index < path.length) {
    if (path[index] === ".") { index += 1; continue; }
    if (path[index] === "[") {
      const close = path.indexOf("]", index);
      if (close === -1) fail("matcher_path", `Matcher path ${JSON.stringify(path)} has an unterminated index.`);
      const text = path.slice(index + 1, close);
      const arrayIndex = Number(text);
      if (!Number.isSafeInteger(arrayIndex) || arrayIndex < 0) fail("matcher_path", `Matcher path ${JSON.stringify(path)} has an invalid index.`);
      result.push(arrayIndex);
      index = close + 1;
      continue;
    }
    let end = index;
    while (end < path.length && path[end] !== "." && path[end] !== "[") end += 1;
    const segment = path.slice(index, end);
    if (segment.length === 0) fail("matcher_path", `Matcher path ${JSON.stringify(path)} has an empty segment.`);
    if (["__proto__", "constructor", "prototype"].includes(segment)) fail("non_lossless_path", `Matcher path ${JSON.stringify(path)} depends on JavaScript prototype lookup.`);
    result.push(segment);
    index = end;
  }
  return result;
}

function hasNonLosslessRegexFeature(pattern: string): boolean {
  return /\(\?[=!<]|\\[1-9]|\\k<|\(\?>|\(\?\(/.test(pattern);
}

function buildMatcherRules(records: readonly ReturnType<typeof normalizeRule>[]): string {
  return records.filter((row) => row.matchers.length > 0).map((row) => {
    const conditions = row.matchers.map((matcher, index) => {
      const encoded = `policy.matchersByRule[${JSON.stringify(row.id)}][${index}]`;
      const actual = `matcher_value(${encoded})`;
      switch (matcher.op) {
        case "exists": return `matcher_found(${encoded})`;
        case "not_exists": return `not matcher_found(${encoded})`;
        case "eq": return `${actual} == ${encoded}.value`;
        case "neq": return `not ${actual} == ${encoded}.value`;
        case "regex": return `is_string(${actual}); regex.match(${encoded}.value, ${actual})`;
        case "in": return `${actual} in ${encoded}.value`;
        case "not_in": return `not ${actual} in ${encoded}.value`;
        case "gt": return `is_number(${actual}); ${actual} > ${encoded}.value`;
        case "gte": return `is_number(${actual}); ${actual} >= ${encoded}.value`;
        case "lt": return `is_number(${actual}); ${actual} < ${encoded}.value`;
        case "lte": return `is_number(${actual}); ${actual} <= ${encoded}.value`;
      }
    });
    return `matcher_rule_matches(${JSON.stringify(row.id)}) if {\n  ${conditions.length === 0 ? "true" : conditions.join("\n  ")}\n}`;
  }).join("\n");
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
function validateMode(id: string, mode: string): void { if (!MODES.has(mode)) fail("unknown_mode", `Rule ${id} has an unknown mode.`); }
function validateService(service: string): void { if (!SERVICE_ID.test(service)) fail("invalid_service", `Service ID ${JSON.stringify(service)} is malformed.`); }
function validateAction(service: string, action: string): void { validateService(service); const prefix = `${service}.`; if (!action.startsWith(prefix) || !LOCAL_ACTION_ID.test(action.slice(prefix.length))) fail("invalid_action", `Action ID ${JSON.stringify(action)} is not qualified by service ${JSON.stringify(service)}.`); }
function validTimestamp(path: string, value: number): void { if (!Number.isSafeInteger(value) || value < 0) fail("invalid_timestamp", `${path} must be a non-negative integer timestamp.`); }
function nonEmpty(path: string, value: string): void { if (value.length === 0) fail("empty_identity", `${path} must not be empty.`); }
function nonBlank(value: string | undefined): value is string { return value !== undefined && value.length > 0; }
function unique(seen: Set<string>, id: string): void { nonEmpty("id", id); if (seen.has(id)) fail("duplicate_id", `Source identity ${id} is duplicated.`); seen.add(id); }
function fail(code: string, message: string): never { throw new CurrentPolicySourceError(code, message); }

// This fixed kernel keeps source review separate from generated canonical data.
// It uses only pure capability-profile v1 built-ins and explicit evaluation facts.
export const CURRENT_ACTION_POLICY_REGO = `package valet.authz
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
  is_string(input.action.riskLevel)
  input.action.riskLevel in {"low", "medium", "high", "critical"}
  is_number(input.context.evaluationTimeMs)
  supported_kind
}

params := object.get(input.action, "parameters", {})
dynamic := object.get(input.facts, "currentPolicy", {"schemaVersion":1,"grants":[],"approvals":[]})

dynamic_valid if {
  count(object.keys(dynamic)) == 3
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

scope_matches(fact) if {
  applies_in == "session"
  fact.appliesIn == "session"
  fact.sessionId == input.subject.sessionId
  object.get(fact, "workflowExecutionId", null) == null
}
scope_matches(fact) if {
  applies_in == "workflow"
  fact.appliesIn == "workflow"
  fact.workflowExecutionId == input.subject.workflowExecutionId
  object.get(fact, "sessionId", null) == null
}

target_matches(rule) if { rule.target.kind == "action"; rule.target.value == input.action.id }
target_matches(rule) if { rule.target.kind == "service"; rule.target.value == input.action.service }
target_matches(rule) if { rule.target.kind == "risk"; rule.target.value == input.action.riskLevel }

rule_live(rule) if {
  object.get(rule, "revokedAtMs", null) == null
  expires := object.get(rule, "expiresAtMs", null)
  expires == null
}
rule_live(rule) if {
  object.get(rule, "revokedAtMs", null) == null
  rule.expiresAtMs > input.context.evaluationTimeMs
}

path_result(value, segments) := {"found":true,"value":value} if { count(segments) == 0 }
path_result(value, segments) := result if {
  count(segments) > 0
  segment := segments[0]
  rest := array.slice(segments, 1, count(segments))
  is_string(segment)
  is_object(value)
  next := value[segment]
  result := path_result(next, rest)
}
path_result(value, segments) := result if {
  count(segments) > 0
  segment := segments[0]
  rest := array.slice(segments, 1, count(segments))
  is_number(segment)
  is_array(value)
  segment >= 0
  segment < count(value)
  next := value[segment]
  result := path_result(next, rest)
}

matcher_found(matcher) if { path_result(params, matcher.segments) }
matcher_value(matcher) := value if { result := path_result(params, matcher.segments); value := result.value }

matcher_rule_matches("__never__") if { false }
# GENERATED_MATCHER_RULES

rule_matches(rule) if {
  target_matches(rule)
  rule_live(rule)
  rule.appliesIn in {"any", applies_in}
  rule.matcherCount == 0
}
rule_matches(rule) if {
  target_matches(rule)
  rule_live(rule)
  rule.appliesIn in {"any", applies_in}
  rule.matcherCount > 0
  matcher_rule_matches(rule.id)
}

org_matches := [rule | rule := policy.organizationRules[_]; rule_matches(rule)]
team_matches := [rule | rule := policy.teamRules[_]; input.subject.principal.type == "team"; rule.ownerId == input.subject.principal.id; rule_matches(rule)]
override_matches := [rule | rule := policy.personalOverrides[_]; input.subject.principal.type == "user"; rule.ownerId == input.subject.principal.id; rule_matches(rule)]

org_winner := org_matches[0] if { count(org_matches) > 0 }
team_winner := team_matches[0] if { count(team_matches) > 0 }
override_winner := override_matches[0] if { count(override_matches) > 0 }

strict_winner := team_winner if { not org_winner; team_winner }
strict_winner := org_winner if { org_winner; not team_winner }
strict_winner := team_winner if { org_winner; team_winner; team_winner.modeRank >= org_winner.modeRank }
strict_winner := org_winner if { org_winner; team_winner; org_winner.modeRank > team_winner.modeRank }

plugin_winner := row if { row := policy.pluginDefaults[_]; row.service == input.action.service }
risk_winner := row if { row := policy.riskDefaults[_]; row.riskLevel == input.action.riskLevel }
base_winner := strict_winner if { strict_winner }
base_winner := plugin_winner if { not strict_winner; plugin_winner }
base_winner := risk_winner if { not strict_winner; not plugin_winner; risk_winner }
base_winner := {"id":policy.bundleDefault.id,"mode":policy.bundleDefault.actionEffect} if { not strict_winner; not plugin_winner; not risk_winner }

grant_ids := [grant.id | grant := dynamic.grants[_]; grant.policyKey == input.action.id; grant.service == input.action.service; grant.actionId == input.action.id; grant.riskLevel == input.action.riskLevel; grant.revokedAtMs == null; grant.createdAtMs <= input.context.evaluationTimeMs; grant.expiresAtMs > input.context.evaluationTimeMs; scope_matches(grant)]
approval_ids := [approval.resolutionId | approval := dynamic.approvals[_]; approval.verdict == "approved"; approval.resolvedAtMs <= input.context.evaluationTimeMs; approval.expiresAtMs > input.context.evaluationTimeMs; approval.requestSubjectDigest == input.context.requestSubjectDigest; approval.originalDecisionDigest == input.context.originalDecisionDigest; scope_matches(approval)]
dynamic_ids := sort(array.concat(grant_ids, approval_ids))

approval_requirement := {"tier":"human","approverType":"org","replay":"once"}
result(effect, reason, ids) := object.union({"effect":effect,"reasonCode":reason,"matchedRuleIds":sort(ids),"obligations":[],"redactions":[]}, approval_field(effect))
approval_field(effect) := {"approvalRequirement":approval_requirement} if { effect == "require_approval" }
approval_field(effect) := {} if { effect != "require_approval" }

decision := result("deny", "unsupported_authorization_context", [policy.bundleDefault.id]) if { not action_context }
else := result("deny", "policy_input_invalid", []) if { not input_valid }
else := result("deny", "malformed_dynamic_facts", []) if { not dynamic_valid }
else := result(org_winner.mode, "organization_policy", [org_winner.id]) if { org_winner.mode == "deny" }
else := result(team_winner.mode, "team_policy", [team_winner.id]) if { team_winner.mode == "deny" }
else := result("allow", "dynamic_grant", array.concat([base_winner.id], dynamic_ids)) if { count(dynamic_ids) > 0 }
else := result(override_winner.mode, "personal_override", [base_winner.id, override_winner.id]) if { override_winner }
else := result(base_winner.mode, base_reason, [base_winner.id]) if { base_reason := base_reason_for(base_winner) }

base_reason_for(row) := "team_policy" if { row.ownerType == "team" }
base_reason_for(row) := "organization_policy" if { row.ownerType == "organization" }
base_reason_for(row) := "plugin_default" if { row.service }
base_reason_for(row) := "risk_default" if { row.riskLevel }
base_reason_for(row) := "bundle_default" if { row.id == policy.bundleDefault.id }
`;
