/**
 * Wake-time memory snapshot assembly (Phase 4 decision 18). Injected into
 * the orchestrator session as a `systemContext` fragment
 * (`{ name: 'memory-snapshot', content, order: 10 }` — Task 7's concern,
 * not this module's).
 *
 * NOTE on the HTTP-seam rule (decision 15): that rule binds *tools* — code
 * that runs inside a session's tool-call loop and must stay portable to a
 * split deployment. This module runs in the host process at orchestrator
 * wake, before any session exists, so it imports the memory service
 * directly. Don't "fix" this to go over HTTP; there's no tool boundary to
 * preserve here.
 */
import { listFiles, PRINCIPLES_DIR, readFile, SYNCED_PRINCIPLES_DIR, type MemoryFileKey, type MemoryFileSummary, type MemoryScope } from "../services/memory.js";
import { memoryUsageRecorder } from "../services/memory-usage.js";
import type { AppDb } from "../lib/drizzle.js";
import { renderPrinciplesSection, selectIndexedPrinciples } from "./principles.js";

export interface AssembleMemorySnapshotOptions {
  budgetChars?: number;
  /** The session has only the read-only memory tools, so the base
   * principle must not tell it to write. */
  readOnly?: boolean;
  /** The snapshot build time, for expiry. Tests pass a fixed value. */
  now?: number;
}

/** Default snapshot budget, in characters (decision 18). */
export const DEFAULT_SNAPSHOT_BUDGET_CHARS = 48_000;

/** Budget for a child session or a workflow step. These run often and in
 * parallel, so their snapshot drops older pinned files and index lines
 * sooner. The Principles section is never dropped. */
export const DELEGATED_SNAPSHOT_BUDGET_CHARS = 16_000;

/** Most lines the memory index lists before it points at mem_search. */
export const MEMORY_INDEX_MAX_LINES = 200;

/** Most characters of one description an index line shows. */
const INDEX_DESCRIPTION_MAX_CHARS = 140;

/** Folders the index collapses to one line: dated notes and deliverables
 * are found by search, not listed one by one. */
const COLLAPSED_FOLDERS = ["journal/", "artifacts/"];

interface SnapshotBlock {
  path: string;
  key: MemoryFileKey;
  content: string;
  updatedAt: number;
}

function ownerLabel(scope: MemoryScope): string {
  return `${scope.owner.type}:${scope.owner.id}`;
}

function renderSnapshot(header: string, principles: string, pinned: SnapshotBlock[], index: string[]): string {
  const pinnedPart = pinned.map((b) => `\n## pinned: ${b.path}\n\n${b.content}\n`).join("");
  return `${header}\n${principles}\n${pinnedPart}\n${renderIndex(index)}`;
}

function renderIndex(lines: string[]): string {
  return [
    "## Memory index",
    "",
    "Every file you can mem_read, with its description. Read a file before you rely on it. Use mem_search for text inside files.",
    "",
    ...lines,
  ].join("\n");
}

function indexLine(file: MemoryFileSummary): string {
  const description = file.description.trim().replace(/\s+/g, " ");
  const shown = description.length > INDEX_DESCRIPTION_MAX_CHARS
    ? `${description.slice(0, INDEX_DESCRIPTION_MAX_CHARS - 1)}…`
    : description;
  return shown ? `- ${file.path}: ${shown}` : `- ${file.path}`;
}

/**
 * The memory index lines: one per own file, newest first up to
 * `maxLines`, then listed in path order. Pinned files and principles are
 * already in the snapshot, and expired files are stale, so none of them
 * is listed. Each
 * collapsed folder becomes one line with its file count and date range.
 */
export function memoryIndexLines(files: MemoryFileSummary[], opts: { now: number; maxLines?: number }): string[] {
  const maxLines = opts.maxLines ?? MEMORY_INDEX_MAX_LINES;
  const live = files.filter((f) => !f.pinned && (f.expires === null || f.expires > opts.now)
    && !f.path.startsWith(PRINCIPLES_DIR) && !f.path.startsWith(SYNCED_PRINCIPLES_DIR));
  const folderLines: string[] = [];
  for (const folder of COLLAPSED_FOLDERS) {
    const inFolder = live.filter((f) => f.path.startsWith(folder)).map((f) => f.path).sort();
    if (inFolder.length === 0) continue;
    const range = inFolder.length === 1 ? inFolder[0] : `${inFolder[0]} … ${inFolder[inFolder.length - 1]}`;
    folderLines.push(`- ${folder} (${inFolder.length} file${inFolder.length === 1 ? "" : "s"}: ${range}). Find them with mem_search.`);
  }
  const listed = live
    .filter((f) => !COLLAPSED_FOLDERS.some((folder) => f.path.startsWith(folder)))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const kept = listed.slice(0, Math.max(0, maxLines - folderLines.length)).sort((a, b) => a.path.localeCompare(b.path));
  const lines = [...kept.map(indexLine), ...folderLines];
  const omitted = listed.length - kept.length;
  if (omitted > 0) lines.push(`- ${omitted} older file${omitted === 1 ? "" : "s"} not listed. Find them with mem_search.`);
  return lines;
}

/**
 * Assembles the wake-time memory snapshot for `scope`: a header line, the
 * Principles section (`./principles.ts`), the full rendered body of every
 * pinned file (path order), and the memory index (`memoryIndexLines`).
 * Own-scope only: it never pulls in team-projected files, even though
 * `listFiles`/`readFile` union them in for a regular read.
 *
 * When the assembled content exceeds `budgetChars`, pinned blocks are
 * dropped oldest-first (by `updatedAt`), then the oldest index lines,
 * until it fits. The header and principles are never dropped, and a
 * truncation note is appended.
 */
export async function assembleMemorySnapshot(
  db: AppDb,
  scope: MemoryScope,
  opts?: AssembleMemorySnapshotOptions,
): Promise<string> {
  const budgetChars = opts?.budgetChars ?? DEFAULT_SNAPSHOT_BUDGET_CHARS;
  const now = opts?.now ?? Date.now();

  const summaries = await listFiles(db, scope);
  // Real stored paths never contain a colon (normalizePath rejects it) —
  // `listFiles`' `team:{id}/…` virtual-prefix entries are the only ones
  // that do, so this filter is an exact own-scope check, not a heuristic.
  const own = summaries.filter((f) => scope.owner.type === "team" || !f.path.includes(":"));

  const pinnedSummaries = own
    .filter((f) => f.pinned && (f.expires === null || f.expires > now))
    .sort((a, b) => a.path.localeCompare(b.path));
  const pinnedBlocks: SnapshotBlock[] = [];
  for (const s of pinnedSummaries) {
    const result = await readFile(db, scope, s.path);
    if (result.kind === "file") {
      pinnedBlocks.push({ path: s.path, key: s.key, content: result.rendered, updatedAt: s.updatedAt });
    }
  }

  // The principle index reads the whole read-union: a team's principles
  // guide its members too. It is never dropped for the budget, so
  // `renderPrinciplesSection` caps it.
  const principles = renderPrinciplesSection(summaries, { readOnly: opts?.readOnly });

  const header = `# Memory snapshot — ${ownerLabel(scope)} — snapshot built ${new Date(now).toISOString().slice(0, 10)} UTC (the date the snapshot was built, not the current date)\n`;

  let remainingPinned = [...pinnedBlocks];
  let maxLines = MEMORY_INDEX_MAX_LINES;
  let index = memoryIndexLines(own, { now, maxLines });
  let rendered = renderSnapshot(header, principles, remainingPinned, index);
  let droppedCount = 0;

  // Pinned files are dropped oldest-first before the index shrinks: the
  // index is how the model finds every other file.
  while (rendered.length > budgetChars && remainingPinned.length > 0) {
    let oldestIdx = 0;
    for (let i = 1; i < remainingPinned.length; i++) {
      if (remainingPinned[i].updatedAt < remainingPinned[oldestIdx].updatedAt) oldestIdx = i;
    }
    remainingPinned = remainingPinned.filter((_, i) => i !== oldestIdx);
    droppedCount++;
    rendered = renderSnapshot(header, principles, remainingPinned, index);
  }
  while (rendered.length > budgetChars && maxLines > 10) {
    maxLines = Math.floor(maxLines / 2);
    index = memoryIndexLines(own, { now, maxLines });
    rendered = renderSnapshot(header, principles, remainingPinned, index);
  }

  if (droppedCount > 0) {
    rendered += `\n\n---\n_[snapshot truncated: ${droppedCount} pinned file(s) omitted to fit the ${budgetChars}-char budget]_\n`;
  }

  // Usage: the files this prompt carries, and the principles its index
  // lists. The model did not choose them, so they count as injections, not
  // reads. A block the budget dropped never reached the prompt.
  const usage = memoryUsageRecorder(db);
  const injectedAt = Date.now();
  for (const block of remainingPinned) usage.record(block.key, "inject", injectedAt);
  for (const principle of selectIndexedPrinciples(summaries)) usage.record(principle.key, "inject", injectedAt);

  return rendered;
}
