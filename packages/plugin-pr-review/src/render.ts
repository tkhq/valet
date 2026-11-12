/**
 * What the review handler writes on GitHub, and how it reads its own
 * findings back. GitHub holds the finding text; the plugin store holds only
 * ids, paths and lines. Each finding block carries a marker so a later run
 * can find its title, body and severity again.
 */
import type { Finding } from "./types.js";

/** A finding as the handler tracks it: the reviewer's finding plus its stable id. */
export interface PostedFinding extends Finding {
  /** `f<n>`, in the order the PR's findings were first reported. */
  id: string;
}

const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const OPEN = "<!-- valet-pr-review:finding";
const CLOSE = "<!-- /valet-pr-review:finding -->";
const BLOCK_RE = /<!-- valet-pr-review:finding (f\d+) (critical|high|medium|low) ([a-z_]+) -->\n\*\*(.*)\*\*\n\n([\s\S]*?)\n<!-- \/valet-pr-review:finding -->/g;

const label = (severity: Finding["severity"]): string => severity.charAt(0).toUpperCase() + severity.slice(1);

/** One finding as markdown: the marker, the title, the body and an optional suggestion. */
export function renderFinding(f: PostedFinding): string {
  return [
    `${OPEN} ${f.id} ${f.severity} ${f.category} -->`,
    `**${oneLine(f.title)}**`,
    "",
    `${f.body.trim()}${f.suggestion ? `\n\n\`\`\`suggestion\n${f.suggestion.replace(/\n+$/, "")}\n\`\`\`` : ""}`,
    CLOSE,
  ].join("\n");
}

/** The body of an inline review comment. */
export function renderInlineComment(f: PostedFinding): string {
  return `${label(f.severity)} · ${f.category.replace("_", " ")}\n\n${renderFinding(f)}`;
}

/** An inline comment after a later commit fixed it. The marker stays, so the text can still be read back. */
export function renderFixedComment(original: string, sha: string, reason: string): string {
  if (isResolvedComment(original)) return original;
  return `**Fixed in \`${sha.slice(0, 7)}\`.** ${oneLine(reason).slice(0, 300)}\n\n<details><summary>Original finding</summary>\n\n${original}\n</details>`;
}

/** An inline comment the reviewer withdrew: a recheck refuted it, and no commit changed its code. */
export function renderWithdrawnComment(original: string, reason: string): string {
  if (isResolvedComment(original)) return original;
  return `**Withdrawn.** A recheck found this claim does not hold, and no commit changed this code. ${oneLine(reason).slice(0, 300)}\n\n<details><summary>Original finding</summary>\n\n${original}\n</details>`;
}

function isResolvedComment(body: string): boolean {
  return body.startsWith("**Fixed in ") || body.startsWith("**Withdrawn.**");
}

/** Every finding block in `text`, keyed by id. `path` and `line` come from the plugin store, not from here. */
export function parseFindings(text: string): Map<string, Omit<PostedFinding, "path" | "line">> {
  const out = new Map<string, Omit<PostedFinding, "path" | "line">>();
  for (const m of text.matchAll(BLOCK_RE)) {
    const [, id, severity, category, title, rest] = m;
    const fence = rest.indexOf("\n\n```suggestion\n");
    const body = fence === -1 ? rest : rest.slice(0, fence);
    const suggestion = fence === -1 ? undefined : rest.slice(fence + "\n\n```suggestion\n".length).replace(/\n```$/, "");
    out.set(id, {
      id,
      severity: severity as Finding["severity"], // the regex admits only the four severities
      category: category as Finding["category"], // written by renderFinding from a schema-checked finding
      title,
      body,
      ...(suggestion !== undefined ? { suggestion } : {}),
    });
  }
  return out;
}

export interface SummaryInput {
  head: string;
  /** Set for a follow-up review: the head the last review covered. */
  incrementFrom?: string;
  summary: string;
  confidence: number;
  /** Open findings with an inline comment. */
  inline: PostedFinding[];
  /** Open findings on lines GitHub cannot comment on: their text lives here. */
  outsideDiff: PostedFinding[];
  /** Findings a recheck resolved at `sha`. `withdrawn`: no commit changed their code. */
  fixed: { finding: Pick<PostedFinding, "id" | "title" | "path">; sha: string; withdrawn?: boolean }[];
  /** Findings the reviewer reported that the line's settings or a missing line hid. */
  hidden: number;
}

/** The body of the PR's one summary review, edited in place on each review. */
export function renderSummary(s: SummaryInput): string {
  const scope = s.incrementFrom ? `the commits since \`${s.incrementFrom.slice(0, 7)}\`` : "the whole pull request";
  const open = [...s.inline, ...s.outsideDiff].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  const lines = [
    `<!-- valet-pr-review:summary ${s.head} -->`,
    "## Valet review",
    "",
    s.summary.trim(),
    "",
    `**Merge confidence: ${s.confidence}/5** · Reviewed \`${s.head.slice(0, 7)}\` (${scope})`,
  ];
  if (open.length > 0) {
    lines.push("", `### Open findings (${open.length})`, "");
    for (const f of open) lines.push(`- **${label(f.severity)}** \`${f.path}:${f.line}\`${f.side === "LEFT" ? " (deleted line)" : ""} ${oneLine(f.title)}`);
  } else {
    lines.push("", "No open findings.");
  }
  const fixed = s.fixed.filter((r) => !r.withdrawn);
  if (fixed.length > 0) {
    lines.push("", `### Fixed (${fixed.length})`, "");
    for (const { finding, sha } of fixed) lines.push(`- ~~${oneLine(finding.title)}~~ \`${finding.path}\`, fixed in \`${sha.slice(0, 7)}\``);
  }
  const withdrawn = s.fixed.filter((r) => r.withdrawn);
  if (withdrawn.length > 0) {
    lines.push("", `### Withdrawn (${withdrawn.length})`, "");
    for (const { finding } of withdrawn) lines.push(`- ~~${oneLine(finding.title)}~~ \`${finding.path}\`, withdrawn on recheck`);
  }
  if (s.outsideDiff.length > 0) {
    lines.push("", `<details><summary>Findings outside the diff (${s.outsideDiff.length})</summary>`, "");
    for (const f of s.outsideDiff) lines.push(`\`${f.path}:${f.line}\``, "", renderFinding(f), "");
    lines.push("</details>");
  }
  if (s.hidden > 0) lines.push("", `${s.hidden} finding(s) are not shown: below the line's minimum severity, in excluded paths, or on a line that does not exist at this head.`);
  return lines.join("\n");
}

/** The summary posted instead of a review on a pull request from a fork whose author has no write access to the base repository. */
export function renderForkNotice(head: string): string {
  return [
    `<!-- valet-pr-review:summary ${head} -->`,
    "## Valet review",
    "",
    "Valet reviews a pull request from a fork only when its author has write access to this repository. To get a review, push the branch to this repository.",
  ].join("\n");
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").replace(/\*\*/g, "").trim();
}

/** A review recorded in the plugin thread only. Nothing of it is on GitHub. */
export function renderShadowReview(r: { slug: string; commit: string; summary: string; confidence: number; findings: Finding[]; hidden: number }): string {
  const sorted = [...r.findings].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  const lines = [
    `## Shadow review of ${r.slug} at \`${r.commit.slice(0, 7)}\``,
    "",
    "Valet recorded this review here only. Nothing is posted on GitHub.",
    "",
    r.summary.trim(),
    "",
    `**Merge confidence: ${r.confidence}/5** · ${sorted.length} finding(s)`,
  ];
  for (const f of sorted) {
    lines.push("", `### ${label(f.severity)} · \`${f.path}:${f.line}\`${f.side === "LEFT" ? " (deleted line)" : ""}`, "", `**${oneLine(f.title)}**`, "", f.body.trim());
    if (f.suggestion) lines.push("", "```suggestion", f.suggestion.replace(/\n+$/, ""), "```");
  }
  if (r.hidden > 0) lines.push("", `${r.hidden} finding(s) are not shown: below the line's minimum severity, in excluded paths, or on a line that does not exist at this commit.`);
  return lines.join("\n");
}

/** Why a shadow review did not run. */
export function renderShadowNotice(slug: string, reason: string): string {
  return `## Shadow review of ${slug}\n\n${reason}`;
}
