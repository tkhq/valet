import { trustedJsonClone } from "./trusted-json.js";
import type { JsonValue } from "./types.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const ACTION = /^[a-z][a-z0-9_-]*\.[a-z0-9][a-z0-9_.:-]*$/;
const SERVICE = /^[a-z][a-z0-9_-]*$/;
const HEX = /^[0-9a-f]{64}$/;
const RISKS = ["low", "medium", "high", "critical"] as const;
export type CurrentPolicyRisk = typeof RISKS[number];
export type CurrentPolicyScope = "session" | "workflow";
export type CurrentPolicyGrantTuple = readonly [string, string, string, string, CurrentPolicyRisk, CurrentPolicyScope, string, number, number, number | null];
export type CurrentPolicyApprovalBindingTuple = readonly [string, string, CurrentPolicyScope, string];
export type CurrentPolicyApprovalTuple = readonly [string, "approved" | "rejected", number, number, 1];
export interface CurrentPolicyDynamicFactsV2 extends Readonly<Record<string, JsonValue>> {
  readonly schemaVersion: 2;
  readonly organizationId: string;
  readonly grants: readonly CurrentPolicyGrantTuple[];
  readonly approvalBinding: CurrentPolicyApprovalBindingTuple | null;
  readonly approvals: readonly CurrentPolicyApprovalTuple[];
}
export interface CurrentPolicyFactContext {
  readonly organizationId: string;
  readonly service?: string;
  readonly actionId?: string;
  readonly riskLevel?: CurrentPolicyRisk;
  readonly appliesIn?: CurrentPolicyScope;
  readonly scopeId?: string;
  readonly evaluationTimeMs?: number;
  readonly requestSubjectDigest?: string;
  readonly originalDecisionDigest?: string;
}

/** Validates the compact #679 fact tuples and returns one frozen snapshot. */
export function validateCurrentPolicyDynamicFactsV2(value: unknown, context: CurrentPolicyFactContext): CurrentPolicyDynamicFactsV2 {
  const facts = trustedJsonClone(value);
  if (!record(facts) || !exact(facts, ["schemaVersion", "organizationId", "grants", "approvalBinding", "approvals"]) || facts.schemaVersion !== 2 || !id(facts.organizationId) || facts.organizationId !== context.organizationId || !Array.isArray(facts.grants) || !Array.isArray(facts.approvals) || facts.grants.length > 8 || facts.approvals.length > 8) bad();
  const identities = new Set<string>();
  for (const fact of facts.grants) {
    if (!Array.isArray(fact) || fact.length !== 10) bad();
    const [grantId, policyKey, service, actionId, risk, scope, scopeId, createdAt, expiresAt, revokedAt] = fact;
    if (!id(grantId) || !action(policyKey) || !serviceId(service) || !action(actionId) || !riskId(risk) || !scopeType(scope) || !id(scopeId) || !time(createdAt) || !time(expiresAt) || expiresAt <= createdAt || (revokedAt !== null && (!time(revokedAt) || revokedAt < createdAt))) bad();
    if (identities.has(`g:${grantId}`)) bad(); identities.add(`g:${grantId}`);
    if (context.actionId !== undefined && (policyKey !== context.actionId || actionId !== context.actionId || service !== context.service || risk !== context.riskLevel || scope !== context.appliesIn || scopeId !== context.scopeId)) bad();
    if (context.evaluationTimeMs !== undefined && (createdAt > context.evaluationTimeMs || expiresAt <= context.evaluationTimeMs || revokedAt !== null)) bad();
  }
  for (const fact of facts.approvals) {
    if (!Array.isArray(fact) || fact.length !== 5) bad();
    const [resolutionId, verdict, resolvedAt, expiresAt, version] = fact;
    if (!id(resolutionId) || (verdict !== "approved" && verdict !== "rejected") || !time(resolvedAt) || !time(expiresAt) || expiresAt <= resolvedAt || version !== 1 || identities.has(`a:${resolutionId}`)) bad();
    identities.add(`a:${resolutionId}`);
    if (context.evaluationTimeMs !== undefined && (resolvedAt > context.evaluationTimeMs || expiresAt <= context.evaluationTimeMs)) bad();
  }
  if (facts.approvals.length === 0) {
    if (facts.approvalBinding !== null) bad();
  } else {
    const binding = facts.approvalBinding;
    if (!Array.isArray(binding) || binding.length !== 4 || !hex(binding[0]) || !hex(binding[1]) || !scopeType(binding[2]) || !id(binding[3])) bad();
    if (context.appliesIn !== undefined && (binding[2] !== context.appliesIn || binding[3] !== context.scopeId || binding[0] !== context.requestSubjectDigest || binding[1] !== context.originalDecisionDigest)) bad();
  }
  if (context.evaluationTimeMs !== undefined && !time(context.evaluationTimeMs)) bad();
  return trustedJsonClone(value as CurrentPolicyDynamicFactsV2);
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)); }
function id(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
function serviceId(value: unknown): value is string { return typeof value === "string" && SERVICE.test(value); }
function action(value: unknown): value is string { return typeof value === "string" && ACTION.test(value); }
function riskId(value: unknown): value is CurrentPolicyRisk { return typeof value === "string" && RISKS.includes(value as CurrentPolicyRisk); }
function scopeType(value: unknown): value is CurrentPolicyScope { return value === "session" || value === "workflow"; }
function hex(value: unknown): value is string { return typeof value === "string" && HEX.test(value); }
function time(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function bad(): never { throw new TypeError("Current policy dynamic facts are malformed."); }
