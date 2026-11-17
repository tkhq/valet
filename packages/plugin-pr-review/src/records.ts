/**
 * Finding records: one store document per posted finding, and what happened
 * to it when the pull request closed. They are the labels that measure
 * reviews in production: the address rate per repository and per build, the
 * input of an outcome-based gate, and replay cases.
 *
 * A record keeps the finding's text, so it does not depend on the GitHub
 * comment that carried it. Outcomes follow the eval `review-outcomes` rule:
 * - `addressed`: the flagged lines (with their context) changed between the
 *   commit the finding was posted on and the head at close;
 * - `rejected`: the code stayed and a person disagreed: a thumbs-down, a
 *   thread a person resolved, or a withdrawal by the reviewer;
 * - `ignored`: any other finding.
 * A changed line does not prove the finding was right. Compare rates across
 * repositories and builds, not as a precision score.
 */
import type { ScopedPluginStore } from "@valet/engine";
import type { PostedFinding } from "./render.js";

export const FINDINGS_COLLECTION = "findings";

/** Where the finding was posted: an inline comment, the summary's outside-the-diff list, or a summary-only tier. */
export type FindingPlacement = "inline" | "outside" | "unconfirmed" | "unsupported" | "suppressed" | "shadow";
export type FindingOutcome = "addressed" | "rejected" | "ignored";

export interface FindingRecord {
  /** `owner/repo`. */
  repo: string;
  number: number;
  id: string;
  title: string;
  body: string;
  severity: PostedFinding["severity"];
  category: PostedFinding["category"];
  confidence?: number;
  path: string;
  line: number;
  side?: "LEFT";
  placement: FindingPlacement;
  /** The commit the finding was posted on. */
  head: string;
  /** ISO time of posting. */
  at: string;
  /** The host build that posted it, when known. */
  build?: string;
  /** Rule notes and learned lessons in the reviewer's pack. */
  rules: string[];
  commentId?: number;
  /**
   * The outcome gate in `log` mode would have moved it to the summary. It
   * posted as usual, so its outcome shows whether the gate would hide
   * findings authors fix.
   */
  wouldGate?: true;
  /** A shadow line's finding: recorded, never posted. A shadow line keeps only its latest review of a pull request. */
  shadow?: true;
  outcome?: {
    result: FindingOutcome;
    /** False for a pull request closed without a merge. Rates count merged pull requests only. */
    merged: boolean;
    /** The head when the pull request closed. */
    closedHead: string;
    at: string;
  };
}

/** `owner/repo#n/f3`: listing by `owner/repo#n/` returns one pull request's records. */
export const recordKey = (slug: string, id: string): string => `${slug}/${id}`;

/** A record for each newly posted finding. */
export function newRecords(input: {
  repo: string;
  number: number;
  slug: string;
  head: string;
  build?: string;
  rules: string[];
  posted: { finding: PostedFinding; placement: FindingPlacement; commentId?: number; wouldGate?: true }[];
  at?: Date;
}): FindingRecord[] {
  const at = (input.at ?? new Date()).toISOString();
  return input.posted.map(({ finding: f, placement, commentId, wouldGate }) => ({
    repo: input.repo,
    number: input.number,
    id: f.id,
    title: f.title,
    body: f.body,
    severity: f.severity,
    category: f.category,
    ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
    path: f.path,
    line: f.line,
    ...(f.side === "LEFT" ? { side: "LEFT" as const } : {}),
    placement,
    head: input.head,
    at,
    ...(input.build ? { build: input.build } : {}),
    rules: input.rules,
    ...(commentId !== undefined ? { commentId } : {}),
    ...(wouldGate ? { wouldGate } : {}),
  }));
}

/** The outcome rule. `changed`: the flagged lines changed by close. `disagreed`: a person showed disagreement, or the reviewer withdrew it. */
export function classifyOutcome(facts: { changed: boolean; disagreed: boolean }): FindingOutcome {
  if (facts.changed) return "addressed";
  return facts.disagreed ? "rejected" : "ignored";
}

/**
 * Replace a shadow line's records for one pull request with its latest
 * review. Keys are `<slug>/s<n>`, apart from posted findings' `<slug>/f<n>`.
 */
export async function replaceShadowRecords(store: ScopedPluginStore, slug: string, records: FindingRecord[]): Promise<void> {
  for (const old of await pullRecords(store, slug)) if (old.record.shadow && old.record.outcome === undefined) await store.delete(FINDINGS_COLLECTION, old.key);
  for (const [i, r] of records.entries()) await store.put(FINDINGS_COLLECTION, recordKey(slug, `s${i + 1}`), { ...r, id: `s${i + 1}`, shadow: true as const });
}

export async function writeRecords(store: ScopedPluginStore, slug: string, records: FindingRecord[]): Promise<void> {
  for (const r of records) await store.put(FINDINGS_COLLECTION, recordKey(slug, r.id), r);
}

/** One pull request's records, with their store revisions. */
export async function pullRecords(store: ScopedPluginStore, slug: string): Promise<{ key: string; record: FindingRecord; revision: number }[]> {
  const out: { key: string; record: FindingRecord; revision: number }[] = [];
  let cursor: string | null = null;
  do {
    const page: Awaited<ReturnType<typeof store.list<FindingRecord>>> = await store.list<FindingRecord>(FINDINGS_COLLECTION, { prefix: `${slug}/`, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const item of page.items) out.push({ key: item.key, record: item.doc, revision: item.revision });
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}
