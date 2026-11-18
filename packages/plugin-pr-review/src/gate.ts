/**
 * The outcome gate: learn from silence. A new finding that resembles
 * findings this repository's authors left unaddressed on several merged pull
 * requests goes to the summary instead of an inline comment.
 *
 * The rule follows Greptile's comment filter: block a comment similar to at
 * least three distinct unaddressed ones, unless it is also similar to at
 * least three that authors addressed. Valet has no embeddings, so similarity
 * is lexical: shared words in the title and body (Jaccard), plus a small
 * bonus for the same directory and the same category. The gate never drops
 * a finding, and it never moves a high, critical or security finding.
 */
import type { FindingRecord } from "./records.js";
import { FINDINGS_COLLECTION } from "./records.js";
import type { ScopedPluginStore } from "@valet/engine";
import type { Finding } from "./types.js";

export interface GateOptions {
  /** Similar unaddressed findings, on distinct pull requests, that move a finding to the summary. */
  minNeighbors: number;
  /** Similarity from 0 to 1 at which a past finding counts as a neighbor. */
  similarity: number;
}

export const DEFAULT_GATE: GateOptions = { minNeighbors: 3, similarity: 0.35 };
/** Newest records with an outcome that the gate compares against. */
const MAX_HISTORY = 2000;
/** Records scanned at most per review. Keys sort by text (`repo#10` before `repo#9`), so the scan reads them all, then keeps the newest. */
const MAX_SCAN = 20_000;
/** Placements the author saw as an open finding. Summary-only tiers rarely get a reaction, so their outcomes would teach the gate to hide more. */
const SEEN: ReadonlySet<FindingRecord["placement"]> = new Set(["inline", "outside"]);
const STOP = new Set(["the", "and", "for", "with", "that", "this", "when", "from", "into", "are", "was", "not", "but", "its", "can", "has", "have", "will", "which", "than", "then", "there", "their", "they", "them", "only", "also", "does", "each", "every", "after", "before", "because", "while", "where", "what", "would", "could", "should"]);

export function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length >= 3 && !STOP.has(w)));
}

const dir = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** How alike two findings are, from 0 to 1. */
export function similarity(a: Pick<Finding, "title" | "body" | "path" | "category">, b: Pick<FindingRecord, "title" | "body" | "path" | "category">): number {
  const x = words(`${a.title} ${a.body}`);
  const y = words(`${b.title} ${b.body}`);
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  const union = x.size + y.size - shared;
  const jaccard = union === 0 ? 0 : shared / union;
  return Math.min(1, jaccard + (dir(a.path) === dir(b.path) ? 0.1 : 0) + (a.category === b.category ? 0.1 : 0));
}

export interface GateDecision {
  suppress: boolean;
  /** Distinct merged pull requests with a similar finding the author left unaddressed and none addressed. */
  unaddressed: number;
  /** Distinct merged pull requests with a similar finding the author addressed. */
  addressed: number;
}

/** Whether `f` goes to the summary, from the repository's past findings on merged pull requests. */
export function gateFinding(f: Pick<Finding, "title" | "body" | "path" | "category" | "severity">, history: readonly FindingRecord[], opts: GateOptions = DEFAULT_GATE, currentPull?: number): GateDecision {
  if (f.severity === "high" || f.severity === "critical" || f.category === "security") return { suppress: false, unaddressed: 0, addressed: 0 };
  const unaddressedPulls = new Set<number>();
  const addressedPulls = new Set<number>();
  for (const r of history) {
    if (!r.outcome?.merged || r.shadow || !SEEN.has(r.placement) || r.number === currentPull) continue;
    if (similarity(f, r) < opts.similarity) continue;
    (r.outcome.result === "addressed" ? addressedPulls : unaddressedPulls).add(r.number);
  }
  // A pull request where the author addressed a similar finding counts as addressed only.
  for (const n of addressedPulls) unaddressedPulls.delete(n);
  return { suppress: unaddressedPulls.size >= opts.minNeighbors && addressedPulls.size < opts.minNeighbors, unaddressed: unaddressedPulls.size, addressed: addressedPulls.size };
}

/** The repository's newest `MAX_HISTORY` finding records with an outcome, by close time. */
export async function repoHistory(store: ScopedPluginStore, repo: string): Promise<FindingRecord[]> {
  const out: FindingRecord[] = [];
  let scanned = 0;
  let cursor: string | null = null;
  do {
    const page: Awaited<ReturnType<typeof store.list<FindingRecord>>> = await store.list<FindingRecord>(FINDINGS_COLLECTION, { prefix: `${repo}#`, limit: 1000, ...(cursor ? { cursor } : {}) });
    scanned += page.items.length;
    for (const item of page.items) if (item.doc.outcome) out.push(item.doc);
    cursor = page.nextCursor;
    if (cursor && scanned >= MAX_SCAN) {
      console.warn(`pr-review ${repo}: the outcome gate read only the first ${scanned} finding records`);
      break;
    }
  } while (cursor);
  return out.sort((a, b) => (b.outcome?.at ?? "").localeCompare(a.outcome?.at ?? "")).slice(0, MAX_HISTORY);
}
