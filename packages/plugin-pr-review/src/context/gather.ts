/**
 * The gather stage: from the diff and one scan of the repository checkout,
 * pick the conventions, domain notes, definitions, callers, tests and team
 * memory the reviewer should read first, and build the context pack.
 */
import { matchesGlob } from "./glob.js";
import { noteMatch, parseNote, type DomainNote } from "./notes.js";
import { buildContextPack, isTestPath, MAX_CALLER_REFS, type ContextPack, type ConventionFile, type MemoryItem, type PackDrop } from "./pack.js";
import { instructionPath, noiseKind, PLAYBOOK, ROOT_CONVENTIONS, NESTED_CONVENTIONS } from "./paths.js";
import type { DroppedFile } from "./rank.js";
import type { RepoRunner } from "./repo.js";
import { CONTEXT_LINES, fetchLines, fillContext, scanRepo, type LineRange } from "./scan.js";
import { diffSymbols, langOf, parseDiff } from "./symbols.js";

/** The owner's memory, read-only: the subset of the plugin memory port the gather stage uses. */
export interface PackMemory {
  search(query: string, opts?: { limit?: number }): Promise<{ path: string; title: string; description: string; snippet: string }[]>;
  read(path: string): Promise<{ path: string; content: string } | null>;
  list(prefix: string, opts?: { limit?: number }): Promise<{ path: string; title: string; description: string }[]>;
}

export interface GatherInput {
  /** Runs git commands in a checkout at HEAD: the reviewer child's sandbox in the plugin, a local shell in the eval. */
  runner: RepoRunner;
  /**
   * A file's text at the merge base: the target branch's trusted state.
   * Convention files and playbooks are instructions, so the pack reads them
   * here and never from the PR head, which the PR author controls.
   * Undefined: the file does not exist at the merge base.
   */
  readTrusted: (path: string) => Promise<string | undefined>;
  /** The whole PR diff, before the diff budget. */
  patch: string;
  /** Files the diff budget left out of the review prompt. */
  diffDropped: DroppedFile[];
  title: string;
  /** `owner/name`, for memory queries. */
  repo?: string;
  memory?: PackMemory;
  budgetChars: number;
}

/** Symbol names the scan looks up. */
const MAX_WORDS = 80;
/** Changed files whose first lines are read for their imports. */
const MAX_IMPORT_FILES = 40;
const IMPORT_LINES = 400;
/** Hits per word and kind (definition, reference, test) whose lines are read. */
const QUOTED_PER_WORD = 6;
/** Lines read after a definition, for its body. */
const DEFINITION_READ = 45;

const PLAYBOOK_DIRS = 3;
const MAX_MEMORY_QUERIES = 16;
/**
 * Where review rules live in memory: notes a content source syncs read-only
 * (a source repo's `.valet/memory/code-review/notes/` mounts at
 * `lib/code-review/notes/`). Agents cannot write under a top-level `lib/`,
 * so a rule there has a person behind it. A team's or org's copy carries a
 * `team:{id}/` or `org:{id}/` prefix. A deeper `lib/` (`notes/lib/...`) is
 * writable, so it is not a rule. Other matching notes are background only.
 */
const RULE_DIR = "lib/code-review/notes/";
const RULE_NOTES = /^((team|org):[^/]+\/)?lib\/code-review\/notes\/[^/]+\.md$/;
/** Rule notes listed at most. An org keeps a few, so every one is read and matched. */
const MAX_RULE_NOTES = 100;
const MAX_MEMORY_READS = 12;

export async function gatherContext(input: GatherInput): Promise<ContextPack> {
  const sourcePatch = parseDiff(input.patch).length > 0 ? onlySource(input.patch) : input.patch;
  const symbols = diffSymbols(sourcePatch);
  // Source files at HEAD: the code scans read only these.
  const changedPaths = symbols.headPaths;
  // Every path the diff touches: added, changed, deleted, and both sides of a rename.
  // Rules and memory follow all of them, so a deletion or a move out of a directory keeps that directory's rules.
  const touched = diffPaths(input.patch);
  const touchedSource = touched.filter((p) => noiseKind(p) === undefined);
  const words = [...new Set([...symbols.changed.map((s) => s.name), ...symbols.used])].slice(0, MAX_WORDS);
  // Instruction files this PR adds, edits or deletes: reviewed as part of the diff, never followed.
  const changedConventions = touched.filter(instructionPath);
  const ancestors = new Set([""]);
  for (const p of touched) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) ancestors.add(parts.slice(0, i).join("/"));
  }
  const isConvention = (path: string): boolean => {
    if (ROOT_CONVENTIONS.has(path) || PLAYBOOK.test(path)) return true;
    const slash = path.lastIndexOf("/");
    return NESTED_CONVENTIONS.has(path.slice(slash + 1)) && ancestors.has(slash === -1 ? "" : path.slice(0, slash));
  };

  // The head scan finds code facts (data): the file list, the symbol hits, then the lines the pack can quote.
  const changed = new Set(symbols.paths);
  const scan = await scanRepo(input.runner, { words, keepPath: (p) => isConvention(p) || isTestPath(p) });
  const ranges: LineRange[] = changedPaths.filter((p) => langOf(p) !== "other").slice(0, MAX_IMPORT_FILES).map((path) => ({ path, from: 1, to: IMPORT_LINES }));
  const taken = new Map<string, number>();
  const take = (key: string, cap: number): boolean => {
    const n = (taken.get(key) ?? 0) + 1;
    taken.set(key, n);
    return n <= cap;
  };
  scan.hits = scan.hits.filter((h) => {
    if (h.def) return take(`def:${h.word}`, QUOTED_PER_WORD);
    if (changed.has(h.path) || (scan.counts.get(h.word) ?? 0) > MAX_CALLER_REFS) return false;
    return take(`${isTestPath(h.path) ? "test" : "ref"}:${h.word}`, QUOTED_PER_WORD);
  });
  for (const h of scan.hits) ranges.push({ path: h.path, from: Math.max(1, h.line - CONTEXT_LINES), to: h.line + (h.def ? DEFINITION_READ : CONTEXT_LINES) });
  const fetched = await fetchLines(input.runner, ranges);
  scan.incomplete.push(...fetched.incomplete);
  fillContext(scan.hits, fetched.lines);
  const extraDrops: PackDrop[] = [];

  // Candidate convention paths: those at HEAD plus those the PR deletes. Their text comes from the merge base.
  const candidates = [...new Set([...scan.paths, ...changedConventions])].filter(isConvention);
  // A failed read fails the pack (the handler notes it); only a missing file reads as undefined.
  const trusted = (path: string): Promise<string | undefined> => input.readTrusted(path);

  // Conventions: root and nested files first (deepest last), then the playbooks that match the change.
  const conventions: ConventionFile[] = [];
  for (const path of candidates.filter((p) => !PLAYBOOK.test(p)).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))) {
    const text = await trusted(path);
    if (text === undefined) continue; // added by this PR: not a rule yet
    const dir = path.includes("/") && !ROOT_CONVENTIONS.has(path) ? path.slice(0, path.lastIndexOf("/")) : "";
    conventions.push({ path, text, why: dir ? `applies to ${dir}/` : "repo root" });
  }
  const changeTokens = tokens([...touchedSource, input.title].join(" "));
  const playbookDirs = new Map<string, { score: number; files: string[]; hits: string[] }>();
  for (const path of candidates.filter((p) => PLAYBOOK.test(p))) {
    const rel = path.slice(path.search(/playbooks\//i) + "playbooks/".length);
    const dir = rel.includes("/") ? rel.slice(0, rel.indexOf("/")) : rel.replace(/\.md$/i, "");
    const hits = [...tokens(rel)].filter((t) => changeTokens.has(t));
    const entry = playbookDirs.get(dir) ?? { score: 0, files: [], hits: [] };
    entry.files.push(path);
    entry.score = Math.max(entry.score, hits.length);
    entry.hits = [...new Set([...entry.hits, ...hits])];
    playbookDirs.set(dir, entry);
  }
  const matchedDirs = [...playbookDirs.entries()].filter(([, e]) => e.score > 0).sort((a, b) => b[1].score - a[1].score);
  for (const [dir, e] of matchedDirs.slice(0, PLAYBOOK_DIRS)) {
    // README first, then the rest by name.
    for (const path of e.files.sort((a, b) => Number(!/readme\.md$/i.test(a)) - Number(!/readme\.md$/i.test(b)) || a.localeCompare(b))) {
      const text = await trusted(path);
      if (text !== undefined) conventions.push({ path, text, why: `playbook ${dir} matches ${e.hits.join(", ")}` });
    }
  }
  for (const [dir] of matchedDirs.slice(PLAYBOOK_DIRS)) extraDrops.push({ section: "conventions", ref: `playbooks/${dir}`, reason: `more than ${PLAYBOOK_DIRS} playbooks matched` });
  const unmatched = playbookDirs.size - matchedDirs.length;
  if (unmatched > 0) extraDrops.push({ section: "conventions", ref: `${unmatched} playbook(s)`, reason: "no match with the changed paths or title" });

  // Domain notes come from team memory only: the plugin ships no organization's rules.
  const addedText = parseDiff(sourcePatch).flatMap((f) => f.added).join("\n");
  const change = { paths: touchedSource, addedText, title: input.title };
  const notes: { note: DomainNote; why: string }[] = [];
  const memory: MemoryItem[] = [];

  if (input.memory) {
    // A failed memory call is logged in the pack, not read as "nothing found".
    const mem = input.memory;
    const search = async (q: string, limit: number): Promise<Awaited<ReturnType<PackMemory["search"]>>> => {
      try {
        return await mem.search(q, { limit });
      } catch (err) {
        extraDrops.push({ section: "memory", ref: `search "${q}"`, reason: `failed: ${err instanceof Error ? err.message : String(err)}` });
        return [];
      }
    };
    // Principles: listed by title, read on demand.
    const principles = (await search("principle", 40)).filter((h) => /(^|\/)principles\//.test(h.path));
    for (const p of principles) memory.push({ path: p.path, title: p.title, text: p.description, kind: "principle" });
    const read = async (path: string): Promise<{ path: string; content: string } | null> => {
      try {
        return await mem.read(path);
      } catch (err) {
        extraDrops.push({ section: "memory", ref: path, reason: `read failed: ${err instanceof Error ? err.message : String(err)}` });
        return null;
      }
    };
    // One broken note is skipped and logged; it must not drop the whole pack.
    const parse = (path: string, content: string): DomainNote | undefined => {
      const note = parseNote(baseName(path), content, "memory", path);
      if (!note.invalid) return note;
      extraDrops.push({ section: "memory", ref: path, reason: `skipped: ${note.invalid}` });
      return undefined;
    };
    const hasRule = (note: DomainNote): boolean => note.paths.length > 0 || note.terms.length > 0 || note.titlePattern !== undefined;

    // Rule notes: every one is listed, read and matched by its own paths,
    // terms and title pattern, so a rule never depends on a keyword search.
    let listed: { path: string }[] = [];
    try {
      listed = (await mem.list(RULE_DIR, { limit: MAX_RULE_NOTES })).filter((f) => RULE_NOTES.test(f.path));
    } catch (err) {
      extraDrops.push({ section: "notes", ref: `list ${RULE_DIR}`, reason: `failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    if (listed.length >= MAX_RULE_NOTES) extraDrops.push({ section: "notes", ref: RULE_DIR, reason: `listed the first ${MAX_RULE_NOTES} rule notes; more may exist` });
    let unmatchedRules = 0;
    for (const { path } of listed) {
      const file = await read(path);
      const note = file ? parse(path, file.content) : undefined;
      if (!note) continue;
      const why = hasRule(note) ? noteMatch(note, change, matchesGlob) : undefined;
      if (why) notes.push({ note, why });
      else if (!hasRule(note)) memory.push({ path, title: note.title, text: note.body, kind: "note" });
      else unmatchedRules++;
    }
    if (unmatchedRules > 0) extraDrops.push({ section: "notes", ref: `${unmatchedRules} rule note(s)`, reason: "their paths, terms and title pattern do not match this change" });

    // Background notes and playbooks found by what the change names:
    // repository, paths, symbols, distinctive terms in added lines, and
    // title words. A note's own paths, terms and title pattern then decide
    // whether it applies. Only the listed rule notes above become rules.
    const queries = [...new Set([
      input.repo ?? "",
      input.repo?.split("/")[1] ?? "",
      ...topDirs(touchedSource),
      ...pathWords(touchedSource),
      ...symbols.changed.slice(0, 3).map((s) => s.name),
      ...distinctiveTerms(addedText),
      ...input.title.split(/[^A-Za-z0-9]+/).filter((w) => w.length >= 5),
    ])].filter((q) => q.length >= 3);
    const hits = new Map<string, { title: string }>();
    for (const q of queries.slice(0, MAX_MEMORY_QUERIES)) {
      for (const h of await search(q, 5)) {
        if (!/(^|\/)principles\//.test(h.path) && !RULE_NOTES.test(h.path)) hits.set(h.path, { title: h.title });
      }
    }
    for (const [path, { title }] of [...hits.entries()].slice(0, MAX_MEMORY_READS)) {
      const file = await read(path);
      const note = file ? parse(path, file.content) : undefined;
      if (!note) continue;
      const ruled = hasRule(note);
      const why = ruled ? noteMatch(note, change, matchesGlob) : undefined;
      if (why) memory.push({ path, title: note.title, text: note.body, kind: "note" });
      else if (!ruled && /playbook|convention|review|runbook/i.test(path)) memory.push({ path, title, text: note.body, kind: "note" });
      else extraDrops.push({ section: "memory", ref: path, reason: ruled ? "its paths and terms do not match this change" : "search match with no path rule" });
    }
  }

  const pack = buildContextPack({ scan, lines: fetched.lines, symbols, conventions, changedConventions, notes, memory, diffDropped: input.diffDropped, budgetChars: input.budgetChars });
  if (extraDrops.length === 0) return pack;
  // Log these drops in the manifest and in the pack's last section.
  const lines = extraDrops.map((d) => `- ${d.section}: ${d.ref} (${d.reason})`).join("\n");
  const text = pack.text.includes("### Left out of this pack") ? `${pack.text}\n${lines}` : `${pack.text}\n\n### Left out of this pack\n${lines}`;
  return { text, manifest: { ...pack.manifest, usedChars: text.length, dropped: [...pack.manifest.dropped, ...extraDrops] } };
}

/** Every path a unified diff names, old and new: a deleted file has only its old path. */
function diffPaths(patch: string): string[] {
  const out = new Set<string>();
  for (const m of patch.matchAll(/^diff --git a\/(.*) b\/(.*)$/gm)) {
    out.add(m[1]);
    out.add(m[2]);
  }
  return [...out];
}

/** The diff without noise files: their symbols are not worth looking up. */
function onlySource(patch: string): string {
  return patch
    .split(/^(?=diff --git )/m)
    .filter((chunk) => {
      const path = /^diff --git a\/.* b\/(.*)$/m.exec(chunk)?.[1];
      return path === undefined || noiseKind(path) === undefined;
    })
    .join("");
}

function tokens(text: string): Set<string> {
  const stop = new Set(["playbooks", "readme", "docs", "the", "and", "for", "with", "src", "lib", "pkg", "internal", "main", "index", "fix", "feat", "add", "update", "chore", "yaml", "json"]);
  return new Set(
    text
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !stop.has(t)),
  );
}

/** File and directory names of the changed paths, without extensions. */
function pathWords(paths: string[]): string[] {
  return [...new Set(paths.flatMap((p) => p.split("/").map((part) => part.replace(/\.[^.]+$/, ""))))].filter((w) => w.length >= 4).slice(0, 8);
}

/** Identifier-like terms in added lines that a note may name (camelCase, CONSTANT_CASE), most used first. */
function distinctiveTerms(added: string): string[] {
  const counts = new Map<string, number>();
  for (const m of added.matchAll(/[A-Za-z][A-Za-z0-9_]{5,}/g)) {
    const t = m[0];
    if (!/[a-z][A-Z]|_/.test(t)) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t);
}

function topDirs(paths: string[]): string[] {
  return [...new Set(paths.map((p) => p.split("/").slice(0, 2).join("/")).filter((d) => d.includes("/") || !d.includes(".")))].slice(0, 4);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
}
