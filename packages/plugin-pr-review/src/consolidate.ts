/**
 * The consolidate stage: drop findings that repeat an earlier one, without a
 * model. A finding repeats another when both sit on the same file within a
 * few lines and cite the same thing (the same `evidence` path:line
 * references or the same trigger) with no conflicting citation. Titles do not count: "null deref of
 * user.email" and "null deref of user.name" share most words and are two
 * defects. Each drop keeps its reason, so the plugin thread and the eval can
 * show what was dropped and why.
 */
import type { Finding } from "./types.js";

export interface Consolidation {
  kept: Finding[];
  dropped: { finding: Finding; reason: string }[];
}

/** Findings this close on the same file can be one report. */
const NEAR_LINES = 3;

export function consolidateFindings(findings: Finding[]): Consolidation {
  const kept: Finding[] = [];
  const dropped: Consolidation["dropped"] = [];
  for (const f of findings) {
    const twin = kept.find((k) => k.path === f.path && Math.abs(k.line - f.line) <= NEAR_LINES && sameCitation(k, f) !== undefined);
    if (twin) dropped.push({ finding: f, reason: `repeats "${twin.title}" at ${twin.path}:${twin.line} (${sameCitation(twin, f)})` });
    else kept.push(f);
  }
  return { kept, dropped };
}

/**
 * What two findings both cite, or undefined when they are two reports. They
 * are one report when they match on evidence or trigger and conflict on
 * neither: two defects in one statement cite the same line with different
 * triggers, and stay apart.
 */
export function sameCitation(a: Finding, b: Finding): string | undefined {
  const refs = (f: Finding): string => [...new Set((f.evidence ?? "").match(/[\w./-]+\.\w+:\d+(?:-\d+)?/g) ?? [])].sort().join(" ");
  // Dots stay inside names (user.email); sentence punctuation does not count.
  const trigger = (f: Finding): string => (f.trigger ?? "").toLowerCase().replace(/[^a-z0-9_.]+/g, " ").replace(/\.+(\s|$)/g, "$1").trim();
  const [ra, rb, ta, tb] = [refs(a), refs(b), trigger(a), trigger(b)];
  const conflict = (x: string, y: string): boolean => x !== "" && y !== "" && x !== y;
  if (conflict(ra, rb) || conflict(ta, tb)) return undefined;
  if (ra !== "" && ra === rb) return `same evidence ${ra}`;
  if (ta !== "" && ta === tb) return "same trigger";
  return undefined;
}
