/** Browser-safe projection of the current source builder input restrictions. */
export const CURRENT_POLICY_COMPLEXITY_LIMITS_V1 = Object.freeze({
  schemaVersion: 1 as const,
  maxRules: 64,
  maxMatchersPerRule: 16,
  maxTotalMatchers: 128,
  maxPathSegments: 8,
  maxRegexLength: 64,
  maxRegexMatchers: 2,
  maxRegexTargetCodeUnits: 256,
  maxMatcherValueBytes: 768,
  maxMatcherValueNodes: 256,
  maxMatcherValueDepth: 16,
  maxTotalMatcherValueBytes: 12_288,
  maxTotalMatcherValueNodes: 2_048,
  maxPluginDefaults: 32,
  maxDynamicGrants: 8,
  maxDynamicApprovals: 8,
});
const SAFE_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_INDEX = /^(?:0|[1-9][0-9]*)$/;
export function parseCurrentPolicyMatcherPathV1(path: string): Array<string | number> | null {
  const result: Array<string | number> = [];
  let index = 0;
  while (index < path.length) {
    let end = index;
    while (end < path.length && path[end] !== "." && path[end] !== "[") end++;
    const segment = path.slice(index, end);
    if (!SAFE_SEGMENT.test(segment) || ["__proto__", "constructor", "prototype"].includes(segment)) return null;
    result.push(segment);
    index = end;
    while (path[index] === "[") {
      const close = path.indexOf("]", index),
        text = path.slice(index + 1, close);
      const value = Number(text);
      if (close < 0 || !SAFE_INDEX.test(text) || !Number.isSafeInteger(value)) return null;
      result.push(value);
      index = close + 1;
    }
    if (index === path.length) break;
    if (path[index++] !== ".") return null;
  }
  return result.length > 0 && !path.endsWith(".") ? result : null;
}
/** ASCII subset with the same match language in JavaScript and pinned Regorus. */
export function isLosslessRegexV1(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > CURRENT_POLICY_COMPLEXITY_LIMITS_V1.maxRegexLength || [...pattern].some((char) => char.codePointAt(0)! < 0x20 || char.codePointAt(0)! > 0x7e)) return false;
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
      if (close < 0 || close >= end || !validClass(pattern.slice(index + 1, close))) return false;
      index = close + 1;
    } else {
      if (".^$*+?()[]{}|".includes(char)) return false;
      index++;
    }
    atoms++;
    if (index < end && "*+?".includes(pattern[index])) index++;
  }
  return atoms > 0 && index === end;
}
function validClass(body: string): boolean {
  if (!body || body.startsWith("^")) return false;
  for (let index = 0; index < body.length; ) {
    const first = body[index];
    if (!/[A-Za-z0-9]/.test(first)) return false;
    if (body[index + 1] !== "-") {
      index++;
      continue;
    }
    const last = body[index + 2];
    if (!last || !/[A-Za-z0-9]/.test(last) || first.charCodeAt(0) > last.charCodeAt(0)) return false;
    index += 3;
  }
  return true;
}
