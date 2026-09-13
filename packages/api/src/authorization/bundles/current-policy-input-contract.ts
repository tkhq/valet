import type { JsonValue } from "@valet/engine/authorization";
/** Browser-safe restrictions shared by the current source builder and authoring model. */
export const CURRENT_POLICY_COMPLEXITY_LIMITS_V1 = Object.freeze({
  schemaVersion: 1 as const, maxRules: 64, maxMatchersPerRule: 16, maxTotalMatchers: 128,
  maxPathSegments: 8, maxRegexLength: 64, maxRegexMatchers: 2, maxRegexTargetCodeUnits: 256,
  maxMatcherValueBytes: 768, maxMatcherValueNodes: 256, maxMatcherValueDepth: 16,
  maxTotalMatcherValueBytes: 12_288, maxTotalMatcherValueNodes: 2_048,
  maxPluginDefaults: 32, maxDynamicGrants: 8, maxDynamicApprovals: 8,
});
const SERVICE = /^[a-z][a-z0-9_-]*$/, ACTION = /^[a-z0-9][a-z0-9_.:-]*$/, RISKS = new Set(["low", "medium", "high", "critical"]);
export const isCurrentPolicyRiskV1 = (value: string): boolean => RISKS.has(value);
export const isCurrentPolicyServiceV1 = (value: string): boolean => SERVICE.test(value);
export const isCurrentPolicyActionV1 = (value: string): boolean => { const at = value.indexOf("."); return at > 0 && isCurrentPolicyServiceV1(value.slice(0, at)) && ACTION.test(value.slice(at + 1)); };
export function currentPolicyTargetIssueV1(target: { service?: unknown; actionId?: unknown; riskLevel?: unknown }): string | null {
  const entries = [target.service, target.actionId, target.riskLevel].filter(value => value !== undefined); if (entries.length !== 1) return "invalid_target";
  if (target.service !== undefined) return typeof target.service === "string" && isCurrentPolicyServiceV1(target.service) ? null : "invalid_service";
  if (target.actionId !== undefined) return typeof target.actionId === "string" && isCurrentPolicyActionV1(target.actionId) ? null : "invalid_action";
  return typeof target.riskLevel === "string" && isCurrentPolicyRiskV1(target.riskLevel) ? null : "unknown_risk";
}
export const utf16CodeUnitCompare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/, INDEX = /^(?:0|[1-9][0-9]*)$/;
export function parseCurrentPolicyMatcherPathV1(path: string): Array<string | number> | null {
  const out: Array<string | number> = []; let at = 0;
  while (at < path.length) {
    let end = at; while (end < path.length && path[end] !== "." && path[end] !== "[") end++;
    const segment = path.slice(at, end); if (!SEGMENT.test(segment) || ["__proto__", "constructor", "prototype"].includes(segment)) return null;
    out.push(segment); at = end;
    while (path[at] === "[") { const close = path.indexOf("]", at), text = path.slice(at + 1, close), value = Number(text); if (close < 0 || !INDEX.test(text) || !Number.isSafeInteger(value)) return null; out.push(value); at = close + 1; }
    if (at === path.length) break; if (path[at++] !== ".") return null;
  }
  return out.length && !path.endsWith(".") ? out : null;
}
export function isLosslessRegexV1(pattern: string): boolean {
  if (!pattern || new TextEncoder().encode(pattern).length > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxRegexLength || [...pattern].some(char => char.codePointAt(0)! < 0x20 || char.codePointAt(0)! > 0x7e)) return false;
  let at = pattern.startsWith("^") ? 1 : 0, atoms = 0; const end = pattern.endsWith("$") && !pattern.endsWith("\\$") ? pattern.length - 1 : pattern.length;
  while (at < end) {
    const char = pattern[at];
    if (char === "\\") { if (at + 1 >= end || !"\\.^$*+?()[]{}|-".includes(pattern[at + 1])) return false; at += 2; }
    else if (char === "[") { const close = pattern.indexOf("]", at + 1); if (close < 0 || close >= end || !validClass(pattern.slice(at + 1, close))) return false; at = close + 1; }
    else { if (".^$*+?()[]{}|".includes(char)) return false; at++; }
    atoms++; if (at < end && "*+?".includes(pattern[at])) at++;
  }
  return atoms > 0 && at === end;
}
function validClass(body: string): boolean {
  if (!body || body.startsWith("^")) return false;
  for (let at = 0; at < body.length;) { const first = body[at]; if (!/[A-Za-z0-9]/.test(first)) return false; if (body[at + 1] !== "-") { at++; continue; } const last = body[at + 2]; if (!last || !/[A-Za-z0-9]/.test(last) || first.charCodeAt(0) > last.charCodeAt(0)) return false; at += 3; }
  return true;
}
export interface CurrentPolicyValueComplexityV1 { readonly bytes: number; readonly nodes: number; readonly depth: number }
/** Rejects accessors, exotic prototypes, cycles, sparse arrays, -0, and non-JSON values before canonicalization. */
export function currentPolicyValueComplexityV1(value: unknown): CurrentPolicyValueComplexityV1 | null {
  const seen = new WeakSet<object>(); let nodes = 0, depth = 0;
  try {
    const walk = (item: unknown, level: number): boolean => {
      nodes++; depth = Math.max(depth, level);
      if (item === null || typeof item === "string" || typeof item === "boolean") return true;
      if (typeof item === "number") return Number.isFinite(item) && !Object.is(item, -0);
      if (typeof item !== "object" || seen.has(item)) return false;
      seen.add(item); const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string") || Object.values(descriptors).some(d => d.get || d.set)) return false;
      if (Array.isArray(item)) { if (Object.keys(item).filter(key => key !== "length").length !== item.length) return false; return item.every(entry => walk(entry, level + 1)); }
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
      return Object.keys(descriptors).every(key => walk(descriptors[key].value, level + 1));
    };
    if (!walk(value, 1)) return null;
    return { bytes: new TextEncoder().encode(canonicalCurrentPolicyJsonV1(value)).length, nodes, depth };
  } catch { return null; }
}
export function canonicalCurrentPolicyJsonV1(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalCurrentPolicyJsonV1).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => utf16CodeUnitCompare(a, b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalCurrentPolicyJsonV1(item)}`).join(",")}}`;
}
export function currentPolicyMatcherIssuesV1(matcher: { path: string; op: string; value?: unknown }): string[] {
  const limits = CURRENT_POLICY_COMPLEXITY_LIMITS_V1, path = parseCurrentPolicyMatcherPathV1(matcher.path), valueBearing = !["exists", "not_exists"].includes(matcher.op), out: string[] = [];
  if (!path || path.length > limits.maxPathSegments) out.push("unsafe_path");
  if (valueBearing !== Object.hasOwn(matcher, "value")) out.push("invalid_value");
  if (["in", "not_in"].includes(matcher.op) && !Array.isArray(matcher.value)) out.push("invalid_value");
  if (["gt", "gte", "lt", "lte"].includes(matcher.op) && (typeof matcher.value !== "number" || !Number.isFinite(matcher.value) || Object.is(matcher.value, -0))) out.push("invalid_value");
  if (matcher.op === "regex" && (typeof matcher.value !== "string" || !isLosslessRegexV1(matcher.value))) out.push("unsafe_regex");
  if (valueBearing) { const size = currentPolicyValueComplexityV1(matcher.value); if (!size) out.push("invalid_value"); else if (size.bytes > limits.maxMatcherValueBytes || size.nodes > limits.maxMatcherValueNodes || size.depth > limits.maxMatcherValueDepth) out.push("complexity_limit"); }
  return [...new Set(out)];
}
export function containsSensitiveTextV1(value: JsonValue): boolean {
  if (typeof value === "string") return /(secret|token|credential|private.?key|password)/i.test(value);
  if (value && typeof value === "object") return Object.entries(value).some(([key, item]) => containsSensitiveTextV1(key) || containsSensitiveTextV1(item));
  return false;
}
