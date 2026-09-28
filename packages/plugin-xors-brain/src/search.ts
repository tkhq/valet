/**
 * BM25 over the bundled brain entries, with the same parameters as the brain
 * CLI (`xors-brain/tools/brainlib.py`), so a query ranks identically in both.
 */
import { AVG_LEN, DOCS, STOPWORDS, type BrainDoc } from "./brain-data.js";

const TOKEN_RE = /[a-z0-9][a-z0-9\-_.]*/g;
const STOP = new Set(STOPWORDS);
const BY_ID = new Map(DOCS.map((d) => [d.id, d]));

export const SECTIONS = [...new Set(DOCS.map((d) => d.section))].sort();

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(TOKEN_RE) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
}

export function getDoc(id: string): BrainDoc | undefined {
  return BY_ID.get(id);
}

export function listDocs(section?: string): BrainDoc[] {
  return DOCS.filter((d) => !section || d.section === section);
}

export function search(
  query: string,
  opts: { section?: string; limit?: number } = {},
): Array<{ doc: BrainDoc; score: number }> {
  const pool = listDocs(opts.section);
  const limit = opts.limit ?? 8;
  const scores = new Map<string, number>();
  for (const term of new Set(tokenize(query))) {
    const hits = pool.filter((d) => d.tf[term]);
    if (hits.length === 0) continue;
    const idf = Math.log(1 + (pool.length - hits.length + 0.5) / (hits.length + 0.5));
    for (const d of hits) {
      const tf = d.tf[term]!;
      const denom = tf + 1.4 * (1 - 0.72 + (0.72 * (d.len || 1)) / (AVG_LEN || 1));
      scores.set(d.id, (scores.get(d.id) ?? 0) + (idf * (tf * 2.4)) / denom);
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, score]) => ({ doc: BY_ID.get(id)!, score }));
}

/** One entry as markdown: metadata header, then the body. */
export function render(doc: BrainDoc): string {
  const head = [
    `# ${doc.title}  (id: ${doc.id})`,
    `section: ${doc.section} · type: ${doc.type} · status: ${doc.status} · sensitivity: ${doc.sensitivity} · updated: ${doc.updated}`,
  ];
  if (doc.tags.length) head.push(`tags: ${doc.tags.join(", ")}`);
  if (doc.links.length) head.push(`links: ${doc.links.join(", ")}`);
  return `${head.join("\n")}\n\n${doc.body.trim()}`;
}
