import type { RedactionDirective } from "./types.js";

/** Applies ordered canonical redactions to a JSON-compatible value. */
export function redactCanonicalValue<T>(value: T, directives: readonly RedactionDirective[]): T {
  if (directives.length === 0) return value;
  const copy = JSON.parse(JSON.stringify(value)) as T;
  for (const directive of directives) for (const path of directive.jsonPaths) {
    if (!/^\$(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(path)) throw new Error("Unsupported canonical redaction path.");
    const parts = path.slice(2).split(".");
    let parent: unknown = copy;
    for (const part of parts.slice(0, -1)) {
      if (!parent || typeof parent !== "object" || Array.isArray(parent)) { parent = undefined; break; }
      parent = (parent as Record<string, unknown>)[part];
    }
    if (parent && typeof parent === "object" && !Array.isArray(parent)) delete (parent as Record<string, unknown>)[parts.at(-1)!];
  }
  return copy;
}
