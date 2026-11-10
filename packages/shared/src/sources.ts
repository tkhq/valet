/**
 * Where a fact in a reply came from: one item a tool read, such as a Slack
 * message, a file at a commit, or a memory file. A tool returns sources
 * without ids; the engine gives each one a thread-scoped id ("s3") that the
 * model sees in the tool result and stores the records on the tool event.
 */
export interface SourceRecord {
  /** Thread-scoped id the model cites, such as "s3". */
  id: string;
  /** The service that holds the item, such as "slack", "github", or "memory". */
  service: string;
  title: string;
  /** An http(s) link, or a path in the Valet web app that starts with "/". */
  url?: string;
  /** A short excerpt of the item. */
  snippet?: string;
  /** The exact place in the item, such as "L10-L24 at 3f2a1c9". */
  location?: string;
}

export type SourceInput = Omit<SourceRecord, "id">;

export const MAX_SOURCES_PER_CALL = 20;
/** Thread metadata key: the last source number this thread gave out. */
export const THREAD_SOURCE_SEQ_KEY = "sourceSeq";
const MAX_SNIPPET = 300;

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim().slice(0, max) : undefined;
}

function link(value: unknown): string | undefined {
  const url = text(value, 2000);
  return url && (/^https?:\/\//i.test(url) || /^\/(?!\/)/.test(url)) ? url : undefined;
}

/** Pure: a source a tool returned, trimmed and bounded, or null when it has no service or title. */
export function normalizeSource(value: unknown): SourceInput | null {
  if (typeof value !== "object" || value === null) return null;
  const record: Record<string, unknown> = { ...value };
  const service = text(record.service, 40);
  const title = text(record.title, 200);
  if (!service || !title) return null;
  const url = link(record.url);
  const snippet = text(record.snippet, MAX_SNIPPET);
  const location = text(record.location, 120);
  return { service, title, ...(url ? { url } : {}), ...(snippet ? { snippet } : {}), ...(location ? { location } : {}) };
}

/** Pure: the sources stored on a persisted tool result (`details.sources`). */
export function readSources(result: unknown): SourceRecord[] {
  if (typeof result !== "object" || result === null || !("details" in result)) return [];
  const details = result.details;
  if (typeof details !== "object" || details === null || !("sources" in details) || !Array.isArray(details.sources)) return [];
  return details.sources.flatMap((value: unknown): SourceRecord[] => {
    const source = normalizeSource(value);
    const id = typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" && /^s\d+$/.test(value.id) ? value.id : undefined;
    return source && id ? [{ id, ...source }] : [];
  });
}

/** Visit bare citation tags in prose. Code and Markdown links stay literal. */
function mapSourceCitations(input: string, replace: (id: string) => string): string {
  if (!/\[s\d+\]/.test(input)) return input;
  const tokens = /^(?: {0,3}>[ \t]?)* {0,3}(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})[^\n]*(?:\n|$)|^(?: {0,3}>[ \t]?)*(?: {4}|\t)[^\n]*(?:\n|$)|`+|\\[\s\S]|!?\[|\]/gm;
  const tag = /\[(s\d+)\]/y;
  const brackets: number[] = [];
  const literals: { start: number; end: number }[] = [];
  const citations: { start: number; end: number; id: string }[] = [];
  const referenceIds = new Set<string>();
  let token: RegExpExecArray | null;
  while ((token = tokens.exec(input)) !== null) {
    const start = token.index;
    const value = token[0];
    const fence = token[1];
    if (fence) {
      const end = new RegExp(`^(?: {0,3}>[ \t]?)* {0,3}${fence[0]}{${fence.length},}[ \t]*$`, "gm");
      end.lastIndex = tokens.lastIndex;
      tokens.lastIndex = end.exec(input) ? end.lastIndex : input.length;
    } else if (value.startsWith("`")) {
      const end = new RegExp(`(?<!\x60)\x60{${value.length}}(?!\x60)`, "g");
      end.lastIndex = tokens.lastIndex;
      if (end.exec(input)) tokens.lastIndex = end.lastIndex;
    } else if (value === "[" || value === "![") {
      brackets.push(start);
      tag.lastIndex = start;
      const citation = tag.exec(input);
      if (citation && citation[1])
        citations.push({ start, end: tag.lastIndex, id: citation[1] });
    } else if (value === "]") {
      const opening = brackets.pop();
      if (opening === undefined) continue;
      let cursor = tokens.lastIndex;
      const next = input[cursor];
      if (next === ":" && /^(?: {0,3}>[ \t]?)* {0,3}$/.test(input.slice(input.lastIndexOf("\n", opening) + 1, opening))) {
        const id = input.slice(opening + 1, start);
        if (/^s\d+$/.test(id)) referenceIds.add(id);
      }
      if (next !== "(" && (next !== "[" || /^\[s\d+\]/.test(input.slice(cursor, cursor + 100)))) continue;
      const closing = next === "(" ? ")" : "]";
      let depth = 1;
      cursor++;
      while (cursor < input.length && depth > 0) {
        if (input[cursor] === "\\") cursor++;
        else if (input[cursor] === next) depth++;
        else if (input[cursor] === closing) depth--;
        cursor++;
      }
      // An unfinished link destination is literal while it streams.
      literals.push({ start: opening, end: cursor });
      tokens.lastIndex = cursor;
    }
  }
  literals.sort((a, b) => a.start - b.start);
  let range = 0;
  let copied = 0;
  let output = "";
  for (const citation of citations) {
    if (referenceIds.has(citation.id)) continue;
    while (literals[range] && literals[range].end <= citation.start) range++;
    const literal = literals[range];
    if (literal && literal.start <= citation.start && citation.end <= literal.end) continue;
    output += input.slice(copied, citation.start) + replace(citation.id);
    copied = citation.end;
  }
  return output + input.slice(copied);
}

/** Remove unknown source tags before the engine stores a settled reply. */
export function filterSourceCitations(text: string, sourceIds: ReadonlySet<string>): string {
  return mapSourceCitations(text, id => sourceIds.has(id) ? `[${id}]` : "");
}

/**
 * Mark another thread's citation tags, so a reader in this thread cannot
 * take them for its own ids: with label "child", "[s3]" becomes "[child s3]".
 */
export function markForeignCitations(text: string, label: string): string {
  return mapSourceCitations(text, id => `[${label} ${id}]`);
}

/**
 * The line a child's settled result carries when the child cited sources.
 * The parent cannot cite the child's ids; `child_read` gives the parent new
 * ids for them. Empty when the result cites nothing.
 */
export function childCitationNote(text: string, childSessionId: string): string {
  const cited = new Set(sourceCitationIds(text)).size;
  if (cited === 0) return "";
  const what = cited === 1 ? "1 source. To cite it" : `${cited} sources. To cite them`;
  return `\n\n[The child cited ${what} here, call child_read with child_session_id "${childSessionId}".]`;
}

/** Citation ids in prose, including repeated uses, for quality checks. */
export function sourceCitationIds(text: string): string[] {
  const ids: string[] = [];
  mapSourceCitations(text, id => { ids.push(id); return `[${id}]`; });
  return ids;
}
