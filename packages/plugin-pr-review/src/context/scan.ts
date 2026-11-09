/**
 * The repository scan, as shell commands through a `RepoRunner`: the file
 * list (git), then every line that names one of the symbols the diff touches
 * (ripgrep, or git grep where ripgrep is missing)
 * (capped per symbol, definitions always kept), then the line ranges the
 * pack quotes. In the plugin the runner is the reviewer child's sandbox,
 * so the scan covers the whole checkout without a second download.
 */
import { definesName, langOf } from "./symbols.js";
import { noiseKind } from "./paths.js";
import type { RepoRunner } from "./repo.js";

export interface Hit {
  word: string;
  path: string;
  /** 1-based line number at HEAD. */
  line: number;
  text: string;
  /** The line defines `word`. */
  def: boolean;
  /** The hit line with up to `CONTEXT_LINES` lines on each side, from `contextStart`. Empty until `fillContext`. */
  context: string[];
  contextStart: number;
}

/** Lines kept on each side of a hit. */
export const CONTEXT_LINES = 3;

export interface ScanRequest {
  words: string[];
  /** Paths to keep in `paths` (the pack needs convention files and tests). Default: none; `fileCount` counts all. */
  keepPath?: (path: string) => boolean;
  /** Lines recorded per word; more are counted, not kept. Definitions are always kept. Default 60. */
  maxHitsPerWord?: number;
}

export interface ScanResult {
  /** Tracked source paths at HEAD that `keepPath` accepted, at most `MAX_KEPT_PATHS`. */
  paths: string[];
  /** Tracked source paths at HEAD (noise paths excluded). */
  fileCount: number;
  hits: Hit[];
  /** References per word, including the ones past `maxHitsPerWord`. */
  counts: Map<string, number>;
  skipped: { noise: number };
  /** Why the scan is incomplete, such as a command whose output passed its cap. Empty when complete. */
  incomplete: string[];
}

/** Lines of files at HEAD, by path and 1-based line number. */
export type LineStore = Map<string, Map<number, string>>;

const LIST_BYTES = 32 * 1024 * 1024;
const GREP_BYTES = 16 * 1024 * 1024;
const LINES_BYTES = 16 * 1024 * 1024;
const LONG_LINE = 400;
/** Paths a scan keeps in memory; past this it counts and notes the cut. */
export const MAX_KEPT_PATHS = 20_000;

export async function scanRepo(runner: RepoRunner, req: ScanRequest): Promise<ScanResult> {
  const cap = req.maxHitsPerWord ?? 60;
  const words = [...new Set(req.words)].filter((w) => /^[A-Za-z_$][\w$]*$/.test(w));
  const result: ScanResult = { paths: [], fileCount: 0, hits: [], counts: new Map(), skipped: { noise: 0 }, incomplete: [] };

  const list = await runner.run("git ls-files -z", { maxOutputBytes: LIST_BYTES, timeoutMs: 60_000 });
  if (list.exitCode !== 0 && !list.truncated) throw new Error(`git ls-files failed (${list.exitCode}): ${list.stderr.trim().slice(0, 300)}. The reviewer's checkout must be a git repository.`);
  if (list.truncated) result.incomplete.push(`the file list passed ${LIST_BYTES / 1048576} MB`);
  let cut = false;
  for (const path of list.stdout.split("\0")) {
    if (!path) continue;
    if (noiseKind(path) !== undefined) {
      result.skipped.noise++;
      continue;
    }
    result.fileCount++;
    if (!req.keepPath?.(path)) continue;
    if (result.paths.length < MAX_KEPT_PATHS) result.paths.push(path);
    else cut = true;
  }
  if (cut) result.incomplete.push(`more than ${MAX_KEPT_PATHS} convention and test paths; kept the first ${MAX_KEPT_PATHS}`);
  if (words.length === 0) return result;

  // One `git grep` for every word. awk splits the matches by word, keeps the
  // first `cap` per word plus anything shaped like a definition, and counts all.
  const grep = await runner.run(
    [
      'w=$(mktemp) && cat > "$w" &&',
      // ripgrep matches many fixed words in one pass; `git grep -w -F` with dozens of words is 100x slower on a large repo.
      'if command -v rg >/dev/null 2>&1; then rg -n --no-heading --no-messages --hidden -g "!.git/" -w -F -f "$w" .; else git grep -n -I -w -F --no-color -f "$w" -- .; fi |',
      `awk -v wf="$w" -v cap=${cap} -v long=${LONG_LINE} '`,
      "BEGIN { while ((getline l < wf) > 0) { n++; W[n] = l; e = l; gsub(/\\$/, \"\\\\$\", e);",
      '  R[n] = "(^|[^A-Za-z0-9_$])" e "([^A-Za-z0-9_$]|$)";',
      '  D[n] = "(def|class|func|function|interface|type|struct|enum|trait|fn|module|object|record)[ \\t]+" e "([^A-Za-z0-9_$]|$)" } }',
      // index() first: a plain substring test is cheap, and some awks recompile a dynamic regex on every match.
      "{ t = $0; sub(/^[^:]*:[0-9]+:/, \"\", t); for (i = 1; i <= n; i++) if (index(t, W[i]) && t ~ R[i]) { c[i]++; if (c[i] <= cap || t ~ D[i]) print i \"\\t\" substr($0, 1, long) } }",
      "END { for (i = 1; i <= n; i++) print \"#\\t\" W[i] \"\\t\" (c[i] + 0) }'",
      '; rm -f "$w"',
    ].join(" "),
    { stdin: `${words.join("\n")}\n`, maxOutputBytes: GREP_BYTES, timeoutMs: 120_000 },
  );
  if (grep.truncated) result.incomplete.push(`the symbol search passed ${GREP_BYTES / 1048576} MB`);
  if (grep.timedOut) result.incomplete.push("the symbol search timed out");
  for (const row of grep.stdout.split("\n")) {
    if (row.startsWith("#\t")) {
      const [, word, n] = row.split("\t");
      if (word) result.counts.set(word, Number(n) || 0);
      continue;
    }
    const tab = row.indexOf("\t");
    if (tab < 0) continue;
    const word = words[Number(row.slice(0, tab)) - 1];
    const m = /^(.*?):(\d+):(.*)$/.exec(row.slice(tab + 1));
    if (!word || !m) continue;
    const [, rawPath, lineNo, text] = m;
    // ripgrep searching `.` prefixes each path with `./`.
    const path = rawPath.startsWith("./") ? rawPath.slice(2) : rawPath;
    if (noiseKind(path) !== undefined) continue;
    const lang = langOf(path);
    result.hits.push({ word, path, line: Number(lineNo), text: text.trim().slice(0, 240), def: lang !== "other" && definesName(text, word, lang), context: [], contextStart: Number(lineNo) });
  }
  return result;
}

export interface LineRange {
  path: string;
  from: number;
  to: number;
}

/** The lines of each range at HEAD, read with one command. */
export async function fetchLines(runner: RepoRunner, ranges: LineRange[]): Promise<{ lines: LineStore; incomplete: string[] }> {
  const lines: LineStore = new Map();
  const wanted = ranges.filter((r) => r.to >= r.from && !/[\t\n]/.test(r.path));
  if (wanted.length === 0) return { lines, incomplete: [] };
  const out = await runner.run(
    'IFS="$(printf \'\\t\')"; while read -r f a b; do printf \'\\036%s\\t%s\\n\' "$f" "$a"; sed -n "${a},${b}p" -- "$f" 2>/dev/null; done',
    { stdin: wanted.map((r) => `${r.path}\t${Math.max(1, r.from)}\t${r.to}`).join("\n") + "\n", maxOutputBytes: LINES_BYTES, timeoutMs: 120_000 },
  );
  for (const block of out.stdout.split("\x1e")) {
    const nl = block.indexOf("\n");
    if (nl < 0) continue;
    const [path, start] = block.slice(0, nl).split("\t");
    const body = block.slice(nl + 1).split("\n");
    if (body.length > 0 && body[body.length - 1] === "") body.pop();
    const file = lines.get(path) ?? new Map<number, string>();
    body.forEach((l, i) => file.set(Number(start) + i, l.length > 240 ? `${l.slice(0, 240)}…` : l));
    lines.set(path, file);
  }
  const incomplete = [
    ...(out.truncated ? [`the quoted lines passed ${LINES_BYTES / 1048576} MB`] : []),
    ...(out.timedOut ? ["reading the quoted lines timed out"] : []),
  ];
  return { lines, incomplete };
}

/** Fill each hit's context from fetched lines: `CONTEXT_LINES` on each side, cut at the end of the file. */
export function fillContext(hits: Hit[], lines: LineStore): void {
  for (const h of hits) {
    const file = lines.get(h.path);
    if (!file) continue;
    const from = Math.max(1, h.line - CONTEXT_LINES);
    const context: string[] = [];
    for (let n = from; n <= h.line + CONTEXT_LINES && file.has(n); n++) context.push(file.get(n) ?? "");
    h.context = context;
    h.contextStart = from;
  }
}
