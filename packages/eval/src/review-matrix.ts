/**
 * Reviewer matrix: for each `pull_request` case, the union of issues that
 * any reviewer raised, and who raised each one. Reviewers are the human
 * golden comments, every recorded run of the Valet reviewer, and reference
 * reviewers (Copilot, CodeRabbit, a Martian vendor, an older Valet bot).
 *
 * Issue identity uses the `review_match` judge prompt: a candidate joins
 * the first-best row it matches, else it opens a new row. Golden comments
 * seed the rows, so human findings keep their wording.
 *
 * Reference reviewers come in two shapes:
 * - `reference` on the `review_match` check (Martian, the trial suite):
 *   the golden indexes each tool matched, plus an unmatched-issue count.
 *   These mark golden rows and add a count-only line.
 * - A sidecar file `<cases>/reference/<case id>.json` with each reference
 *   finding as short text and a link. These become rows of their own.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { judgePair, type ReviewLlm } from "./checks/review-match.js";
import type { EvalCase, GoldenComment, Trajectory } from "./types.js";

/** One finding by a reference reviewer, from a sidecar file. */
export interface ReferenceFinding {
  reviewer: string;
  /** Short issue text. No code. */
  issue: string;
  url?: string;
  /** The author changed the code under the comment before merge (the review thread went outdated). */
  acted?: boolean;
  /** A person judged the finding wrong. */
  noise?: boolean;
}

/** `<cases>/reference/<case id>.json`. */
export interface ReferenceSidecar {
  /** Links to the human threads, one list per golden comment, in golden order. */
  golden_links?: string[][];
  findings: ReferenceFinding[];
}

/** One recorded Valet review: the findings it submitted. */
export interface RunReview {
  label: string;
  findings: { path: string; line: number; title: string; body: string; severity?: string; category?: string }[];
}

export type RowStatus = "human" | "acted" | "corroborated" | "unconfirmed" | "noise";

export interface MatrixRow {
  issue: string;
  category?: string;
  severity?: string;
  /** Reviewer name → links or locations of the comments that raised it (empty string when there is none). */
  caughtBy: Record<string, string[]>;
  status: RowStatus;
}

export interface CaseMatrix {
  caseId: string;
  rows: MatrixRow[];
  /** Count-only reference tools: unmatched issues they raised that have no text here. */
  unmatchedCounts: Record<string, number>;
  judgeErrors: number;
}

export const HUMAN = "human";

/** Parallel judge calls per candidate. */
const ROW_CONCURRENCY = 12;

export async function loadReferenceSidecar(casesDir: string, caseId: string): Promise<ReferenceSidecar | undefined> {
  try {
    return JSON.parse(await readFile(join(casesDir, "reference", `${caseId}.json`), "utf8")) as ReferenceSidecar;
  } catch {
    return undefined;
  }
}

/** The review a baseline trajectory recorded, as `RunReview` findings. */
export function runFindings(t: Trajectory): RunReview["findings"] | undefined {
  const r = t.metadata?.review;
  if (typeof r !== "object" || r === null || !("findings" in r) || !Array.isArray(r.findings)) return undefined;
  // Shape written by the runner from the reviewer's validated submit_review args.
  return r.findings as RunReview["findings"];
}

export async function buildCaseMatrix(
  llm: ReviewLlm,
  evalCase: EvalCase,
  runs: RunReview[],
  sidecar: ReferenceSidecar | undefined,
): Promise<CaseMatrix> {
  const check = evalCase.checks.find((c) => c.type === "review_match");
  const golden: GoldenComment[] = check?.type === "review_match" ? check.golden : [];
  const rows: MatrixRow[] = golden.map((g, i) => ({
    issue: g.comment,
    category: g.category,
    ...(g.severity !== undefined ? { severity: g.severity } : {}),
    caughtBy: { [HUMAN]: sidecar?.golden_links?.[i] ?? [""] },
    status: "human",
  }));
  const unmatchedCounts: Record<string, number> = {};
  if (check?.type === "review_match") {
    for (const [tool, ref] of Object.entries(check.reference ?? {})) {
      for (const i of ref.matched) if (rows[i]) rows[i].caughtBy[tool] = [""];
      unmatchedCounts[tool] = ref.fp;
    }
  }

  interface Candidate { reviewer: string; issue: string; where: string; category?: string; severity?: string; acted?: boolean; noise?: boolean }
  const candidates: Candidate[] = [
    ...(sidecar?.findings ?? []).map((f) => ({ reviewer: f.reviewer, issue: f.issue, where: f.url ?? "", ...(f.acted ? { acted: true } : {}), ...(f.noise ? { noise: true } : {}) })),
    ...runs.flatMap((r) =>
      r.findings.map((f) => ({
        reviewer: r.label,
        issue: `${f.title}. ${f.body}`,
        where: `${f.path}:${f.line}`,
        ...(f.category !== undefined ? { category: f.category } : {}),
        ...(f.severity !== undefined ? { severity: f.severity } : {}),
      })),
    ),
  ];

  let judgeErrors = 0;
  const flags = new Map<MatrixRow, { acted: boolean; noise: boolean; clean: boolean }>();
  for (const c of candidates) {
    const verdicts = await mapLimit(rows, ROW_CONCURRENCY, (row) =>
      judgePair(llm, row.issue, c.issue).catch(() => {
        judgeErrors++;
        return { match: false, confidence: 0 };
      }),
    );
    let best = -1;
    verdicts.forEach((v, i) => {
      if (v.match && (best < 0 || v.confidence > verdicts[best].confidence)) best = i;
    });
    let row: MatrixRow;
    if (best >= 0) {
      row = rows[best];
    } else {
      row = { issue: c.issue, ...(c.category !== undefined ? { category: c.category } : {}), ...(c.severity !== undefined ? { severity: c.severity } : {}), caughtBy: {}, status: "unconfirmed" };
      rows.push(row);
    }
    (row.caughtBy[c.reviewer] ??= []).push(c.where);
    const f = flags.get(row) ?? { acted: false, noise: false, clean: false };
    if (c.acted) f.acted = true;
    if (c.noise) f.noise = true;
    else f.clean = true;
    flags.set(row, f);
  }

  for (const row of rows) {
    if (row.status === "human") continue;
    const f = flags.get(row);
    // Runs of the Valet reviewer are one reviewer: two runs agreeing is not corroboration.
    const reviewers = new Set(Object.keys(row.caughtBy).map((r) => (r.startsWith("valet") ? "valet" : r))).size;
    row.status = f?.noise && !f.clean ? "noise" : f?.acted ? "acted" : reviewers >= 2 ? "corroborated" : "unconfirmed";
  }
  return { caseId: evalCase.id, rows, unmatchedCounts, judgeErrors };
}

const STATUS_NOTE: Record<RowStatus, string> = {
  human: "found by the human reviewer",
  acted: "the author changed the code under a reference comment",
  corroborated: "raised by two or more independent reviewers",
  unconfirmed: "raised by one reviewer, not confirmed",
  noise: "judged wrong by a person",
};

/** Reviewer columns in a stable order: human, then Valet runs, then reference reviewers by name. */
export function matrixColumns(matrices: CaseMatrix[], runLabels: string[]): string[] {
  const refs = new Set<string>();
  for (const m of matrices) {
    for (const row of m.rows) for (const r of Object.keys(row.caughtBy)) if (r !== HUMAN && !runLabels.includes(r)) refs.add(r);
    for (const r of Object.keys(m.unmatchedCounts)) refs.add(r);
  }
  return [HUMAN, ...runLabels, ...[...refs].sort()];
}

/** Per column: rows caught, split by status. */
export function matrixTotals(matrices: CaseMatrix[], columns: string[]): Record<string, Record<RowStatus | "all", number>> {
  const totals: Record<string, Record<RowStatus | "all", number>> = {};
  for (const col of columns) totals[col] = { all: 0, human: 0, acted: 0, corroborated: 0, unconfirmed: 0, noise: 0 };
  for (const m of matrices) {
    for (const row of m.rows) {
      for (const col of columns) {
        if (row.caughtBy[col] === undefined) continue;
        totals[col].all++;
        totals[col][row.status]++;
      }
    }
  }
  return totals;
}

function cell(locs: string[] | undefined): string {
  if (locs === undefined) return "";
  const links = locs.filter((l) => l.startsWith("http"));
  return links.length > 0 ? links.map((l, i) => `[x${links.length > 1 ? i + 1 : ""}](${l})`).join(" ") : "x";
}

function escapeCell(s: string, max = 160): string {
  const one = s.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function renderMatrixMarkdown(matrices: CaseMatrix[], runLabels: string[]): string {
  const columns = matrixColumns(matrices, runLabels);
  const out: string[] = [];
  const head = `| issue | category | severity | status | ${columns.join(" | ")} |`;
  const rule = `|---|---|---|---|${columns.map(() => "---").join("|")}|`;
  for (const m of matrices) {
    out.push(`### ${m.caseId}`, "", head, rule);
    for (const row of m.rows) {
      out.push(`| ${escapeCell(row.issue)} | ${row.category ?? ""} | ${row.severity ?? ""} | ${row.status} | ${columns.map((c) => cell(row.caughtBy[c])).join(" | ")} |`);
    }
    const counts = Object.entries(m.unmatchedCounts).filter(([, n]) => n > 0);
    if (counts.length > 0) out.push("", `Unmatched issues with no text: ${counts.map(([t, n]) => `${t} ${n}`).join(", ")}.`);
    if (m.judgeErrors > 0) out.push("", `${m.judgeErrors} judge call(s) failed and counted as no match.`);
    out.push("");
  }
  const totals = matrixTotals(matrices, columns);
  out.push("### Totals", "", `| reviewer | issues | human | acted | corroborated | unconfirmed | noise |`, `|---|---|---|---|---|---|---|`);
  for (const col of columns) {
    const t = totals[col];
    out.push(`| ${col} | ${t.all} | ${t.human} | ${t.acted} | ${t.corroborated} | ${t.unconfirmed} | ${t.noise} |`);
  }
  out.push("", "Status: " + (Object.entries(STATUS_NOTE) as [RowStatus, string][]).map(([s, n]) => `\`${s}\` ${n}`).join("; ") + ".");
  return out.join("\n");
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}
