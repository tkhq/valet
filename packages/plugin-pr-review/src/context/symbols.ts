/**
 * Symbols a pull request touches, read from its unified diff with
 * per-language patterns. No parser: the patterns cover the definition forms
 * of TS/JS, Python, Go, Java/Kotlin, Ruby and Rust well enough to pick the
 * names worth looking up. A miss costs one lookup the reviewer can still do
 * with grep.
 */

export interface ChangedSymbol {
  name: string;
  path: string;
  /** `removed`: a definition line only on the base side. */
  change: "added" | "changed" | "removed";
}

export interface DiffSymbols {
  changed: ChangedSymbol[];
  /** Identifiers that added lines call or name, defined outside the diff, most used first. */
  used: string[];
  /** Paths of the files the diff adds, changes or deletes (a renamed file by its new path). */
  paths: string[];
  /** The subset of `paths` that exists at HEAD: not deleted. */
  headPaths: string[];
}

type Lang = "ts" | "py" | "go" | "java" | "rb" | "rs" | "other";

export function langOf(path: string): Lang {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"].includes(ext)) return "ts";
  if (ext === "py") return "py";
  if (ext === "go") return "go";
  if (["java", "kt", "scala"].includes(ext)) return "java";
  if (["rb", "rake"].includes(ext)) return "rb";
  if (ext === "rs") return "rs";
  return "other";
}

const IDENT = "[A-Za-z_$][\\w$]*";

/** Definition forms per language. Group 1 is the defined name. */
const DEFINITIONS: Record<Lang, RegExp[]> = {
  ts: [
    new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\*?\\s+(${IDENT})`),
    new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?(?:class|interface|enum)\\s+(${IDENT})`),
    new RegExp(`^\\s*(?:export\\s+)?type\\s+(${IDENT})\\s*[=<]`),
    new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+(${IDENT})\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:\\([^)]*\\)|${IDENT})\\s*(?::[^=]+)?=>`),
    new RegExp(`^\\s*(?:public\\s+|private\\s+|protected\\s+|static\\s+|async\\s+|readonly\\s+|override\\s+)*(${IDENT})\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\{\\s*$`),
  ],
  py: [new RegExp(`^\\s*(?:async\\s+)?def\\s+(${IDENT})`), new RegExp(`^\\s*class\\s+(${IDENT})`)],
  go: [
    new RegExp(`^func\\s+(?:\\([^)]*\\)\\s*)?(${IDENT})\\s*[(\\[]`),
    new RegExp(`^\\s*type\\s+(${IDENT})\\s+(?:struct|interface|func|\\w)`),
  ],
  java: [
    new RegExp(`^\\s*(?:public|private|protected|internal|abstract|final|static|sealed|data|open|\\s)*(?:class|interface|enum|record|object)\\s+(${IDENT})`),
    new RegExp(`^\\s*(?:public|private|protected|static|final|abstract|synchronized|override|suspend|\\s)+[\\w<>\\[\\],.? ]+\\s+(${IDENT})\\s*\\([^;]*$`),
    new RegExp(`^\\s*(?:override\\s+)?fun\\s+(?:<[^>]+>\\s*)?(?:${IDENT}\\.)?(${IDENT})\\s*\\(`),
  ],
  rb: [new RegExp(`^\\s*def\\s+(?:self\\.)?(${IDENT}[?!=]?)`), new RegExp(`^\\s*(?:class|module)\\s+(${IDENT})`)],
  rs: [
    new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?(?:unsafe\\s+)?fn\\s+(${IDENT})`),
    new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:struct|enum|trait|type|union)\\s+(${IDENT})`),
  ],
  other: [],
};

/** The name a line defines, or undefined. */
export function definedName(line: string, lang: Lang): string | undefined {
  for (const re of DEFINITIONS[lang]) {
    const m = re.exec(line);
    if (m && !KEYWORDS.has(m[1])) return m[1];
  }
  return undefined;
}

/** Whether `line` defines `name`. */
export function definesName(line: string, name: string, lang: Lang): boolean {
  return line.includes(name) && definedName(line, lang) === name;
}

/** Words that look like identifiers in every language here but name nothing to look up. */
const KEYWORDS = new Set(
  (
    "if else for while do switch case return function class interface type enum const let var new delete typeof instanceof void " +
    "import export from default async await yield try catch finally throw throws def elif lambda pass raise with as is not and or in " +
    "func go defer chan map struct range select package public private protected static final abstract extends implements super this self " +
    "fn impl pub mut match loop where trait use mod crate unsafe ref move dyn begin end rescue ensure unless until module then elsif " +
    "true false null nil None True False undefined NaN print println printf len make append cap panic recover require include assert " +
    "string number boolean object any unknown never int float bool str bytes byte rune error Error Object String Number Boolean Array Promise " +
    "Map Set List Dict Optional Any Result Option Some Ok Err Vec Box Self get set has add put push pop keys values items list dict tuple " +
    "log info warn debug err ctx req res next value key data name id args kwargs opts options config props state event cb fn callback " +
    "test it describe expect should mock spy setUp tearDown assertEqual assertTrue assertFalse t s e i j k x y v n ok"
  ).split(/\s+/),
);

/** Names shorter than this are never looked up. */
const MIN_NAME = 4;

/** A name long and specific enough that its references are worth reading. All-caps names need 6 chars. */
function lookupWorthy(name: string): boolean {
  if (name.length < MIN_NAME || KEYWORDS.has(name) || name.startsWith("__")) return false;
  return !/^[A-Z0-9_]+$/.test(name) || name.length >= 6;
}

interface FileDiff {
  /** The new path, or the old path of a deleted file. */
  path: string;
  /** The base-side path: differs from `path` for a rename, empty for an added file. */
  oldPath: string;
  deleted: boolean;
  added: string[];
  removed: string[];
  /** Enclosing function names from hunk headers (`@@ ... @@ func Foo(`). */
  contexts: string[];
}

/** Split a unified diff into its files' added lines, removed lines and hunk contexts. */
export function parseDiff(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | undefined;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      cur = { path: m ? m[2] : "", oldPath: m ? m[1] : "", deleted: false, added: [], removed: [], contexts: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      // A deleted file keeps its old path: its removed definitions still have callers.
      if (line === "+++ /dev/null") cur.deleted = true;
      if (line === "--- /dev/null") cur.oldPath = "";
      continue;
    }
    if (line.startsWith("@@")) {
      const ctx = /^@@[^@]*@@\s?(.*)$/.exec(line)?.[1];
      if (ctx) cur.contexts.push(ctx);
    } else if (line.startsWith("+")) cur.added.push(line.slice(1));
    else if (line.startsWith("-")) cur.removed.push(line.slice(1));
  }
  return files.filter((f) => f.path !== "");
}

/** Changed and used symbols of a unified diff. */
export function diffSymbols(patch: string, opts: { maxUsed?: number } = {}): DiffSymbols {
  const files = parseDiff(patch);
  const changed = new Map<string, ChangedSymbol>();
  const definedInDiff = new Set<string>();
  const uses = new Map<string, number>();
  for (const f of files) {
    const lang = langOf(f.path);
    if (lang === "other") continue;
    const addedDefs = new Set(f.added.map((l) => definedName(l, lang)).filter((n): n is string => n !== undefined));
    const removedDefs = new Set(f.removed.map((l) => definedName(l, lang)).filter((n): n is string => n !== undefined));
    for (const name of addedDefs) definedInDiff.add(name);
    const put = (name: string, change: ChangedSymbol["change"]): void => {
      if (!lookupWorthy(name)) return;
      const key = `${f.path}\0${name}`;
      if (!changed.has(key)) changed.set(key, { name, path: f.path, change });
    };
    for (const name of addedDefs) put(name, removedDefs.has(name) ? "changed" : "added");
    for (const name of removedDefs) if (!addedDefs.has(name)) put(name, "removed");
    for (const ctx of f.contexts) {
      const name = definedName(ctx, lang);
      if (name) put(name, "changed");
    }
    for (const line of f.added) {
      if (/^\s*(?:\/\/|#|\*|\/\*)/.test(line)) continue;
      const code = line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
      for (const m of code.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*[(<{]|\.([A-Za-z_$][\w$]*)\s*\(|\b([A-Z][a-z0-9]+[A-Z]?\w*)\b/g)) {
        const name = m[1] ?? m[2] ?? m[3];
        if (name && lookupWorthy(name)) uses.set(name, (uses.get(name) ?? 0) + 1);
      }
    }
  }
  const used = [...uses.entries()]
    .filter(([name]) => !definedInDiff.has(name))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, opts.maxUsed ?? 40)
    .map(([name]) => name);
  return { changed: [...changed.values()], used, paths: files.map((f) => f.path), headPaths: files.filter((f) => !f.deleted).map((f) => f.path) };
}
