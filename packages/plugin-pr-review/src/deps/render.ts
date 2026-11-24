/**
 * What the dependency review writes on GitHub. Its markers
 * (`valet-dependency-review:`) differ from the general review's
 * (`valet-pr-review:`), so neither handler reads the other's comments.
 */
import type { PackageChange } from "./diff.js";
import type { DependencyFinding, Severity } from "./findings.js";

export const SUMMARY_MARKER = "<!-- valet-dependency-review:summary";
const OPEN = "<!-- valet-dependency-review:finding";
const CLOSE = "<!-- /valet-dependency-review:finding -->";

const KIND_LABEL: Record<DependencyFinding["kind"], string> = {
  advisory: "dependency advisory",
  typosquat: "possible typosquat",
  "install-script": "install script",
  "new-package": "new package",
  maintainer: "maintainer change",
  license: "license",
};

const label = (s: Severity): string => s.charAt(0).toUpperCase() + s.slice(1);
const oneLine = (s: string): string => s.replace(/\s+/g, " ").replace(/\*\*/g, "").trim();

/** A finding as the handler posts it: its id and where it went. */
export interface PostedDependencyFinding {
  id: string;
  key: string;
  kind: DependencyFinding["kind"];
  severity: Severity;
  title: string;
  /** The anchor, when it has an inline comment or a known line. */
  path?: string;
  line?: number;
}

export function renderDependencyFinding(id: string, f: Pick<DependencyFinding, "kind" | "severity" | "title" | "body">): string {
  return [`${OPEN} ${id} ${f.severity} ${f.kind} -->`, `**${oneLine(f.title)}**`, "", f.body.trim(), CLOSE].join("\n");
}

export function renderDependencyComment(id: string, f: Pick<DependencyFinding, "kind" | "severity" | "title" | "body">): string {
  return `${label(f.severity)} · ${KIND_LABEL[f.kind]}\n\n${renderDependencyFinding(id, f)}`;
}

/** The inline comment after a later push dropped the package version it was about. */
export function renderResolvedComment(original: string, sha: string): string {
  if (original.startsWith("**Resolved in ")) return original;
  return `**Resolved in \`${sha.slice(0, 7)}\`.** The pull request no longer adds this package version.\n\n<details><summary>Original finding</summary>\n\n${original}\n</details>`;
}

/** The finding ids in a body, from their markers. */
export function dependencyFindingIds(text: string): string[] {
  return [...text.matchAll(/<!-- valet-dependency-review:finding (d\d+) /g)].map((m) => m[1]);
}

export interface DependencySummaryInput {
  head: string;
  changes: PackageChange[];
  truncated: boolean;
  open: PostedDependencyFinding[];
  /** Open findings with no inline comment, with their full text. */
  outside: { id: string; finding: Pick<DependencyFinding, "kind" | "severity" | "title" | "body">; where?: string }[];
  resolved: { title: string; sha: string }[];
  hidden: number;
  /** Why reachability was not judged for the new advisories, when it was not. */
  reachabilityNote?: string;
  /** Advisories past the per-run read limit, named by id only. */
  notes?: string[];
}

const ROWS = 100;

/** The body of the pull request's one dependency summary review, edited in place on each push. */
export function renderDependencySummary(s: DependencySummaryInput): string {
  const count = (k: PackageChange["kind"]): number => s.changes.filter((c) => c.kind === k).length;
  const transitive = s.changes.filter((c) => !c.direct && c.kind !== "removed").length;
  const parts = [["added", count("added")], ["upgraded", count("upgraded")], ["downgraded", count("downgraded")], ["removed", count("removed")]]
    .filter(([, n]) => Number(n) > 0)
    .map(([k, n]) => `${n} ${k}`);
  const order = (a: { severity: Severity }, b: { severity: Severity }): number => ["critical", "high", "medium", "low"].indexOf(a.severity) - ["critical", "high", "medium", "low"].indexOf(b.severity);
  const lines = [
    `${SUMMARY_MARKER} ${s.head} -->`,
    "## Valet dependency review",
    "",
    `Checked \`${s.head.slice(0, 7)}\`: ${parts.join(", ") || "no package changes"}${transitive > 0 ? ` (${transitive} transitive)` : ""}. Advisories come from OSV; license, age, maintainer and install-script facts come from the package registries.`,
  ];
  if (s.open.length > 0) {
    lines.push("", `### Open findings (${s.open.length})`, "");
    for (const f of [...s.open].sort(order)) lines.push(`- **${label(f.severity)}** ${f.path ? `\`${f.path}${f.line ? `:${f.line}` : ""}\` ` : ""}${oneLine(f.title)}`);
  } else {
    lines.push("", "No open findings.");
  }
  if (s.resolved.length > 0) {
    lines.push("", `### Resolved (${s.resolved.length})`, "");
    for (const r of s.resolved) lines.push(`- ~~${oneLine(r.title)}~~, resolved in \`${r.sha.slice(0, 7)}\``);
  }
  if (s.outside.length > 0) {
    lines.push("", `<details><summary>Findings outside the diff (${s.outside.length})</summary>`, "");
    for (const o of s.outside) lines.push(...(o.where ? [`\`${o.where}\``, ""] : []), renderDependencyFinding(o.id, o.finding), "");
    lines.push("</details>");
  }
  if (s.reachabilityNote) lines.push("", s.reachabilityNote);
  for (const n of s.notes ?? []) lines.push("", n);
  if (s.hidden > 0) lines.push("", `${s.hidden} finding(s) are not shown: below the line's minimum severity.`);
  if (s.changes.length > 0) {
    lines.push("", `<details><summary>Changed packages (${s.changes.length}${s.truncated ? "+" : ""})</summary>`, "", "| Package | Change | Dependency |", "| --- | --- | --- |");
    for (const c of s.changes.slice(0, ROWS)) {
      const change = c.kind === "added" ? `added ${c.to}` : c.kind === "removed" ? `removed ${c.from}` : `${c.from} → ${c.to}`;
      lines.push(`| \`${c.name}\` (${c.ecosystem}) | ${change}${c.exact ? "" : " (range)"} | ${c.direct ? "direct" : "transitive"} |`);
    }
    if (s.changes.length > ROWS) lines.push("", `${s.changes.length - ROWS} more not listed.`);
    if (s.truncated) lines.push("", `Only the first ${s.changes.length} changes were checked.`);
    lines.push("", "</details>");
  }
  return lines.join("\n");
}
