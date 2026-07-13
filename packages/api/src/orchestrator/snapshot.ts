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
import { listFiles, readFile, type MemoryScope } from "../services/memory.js";
import type { AppDb } from "../lib/drizzle.js";

export interface AssembleMemorySnapshotOptions {
  budgetChars?: number;
}

/** Default snapshot budget, in characters (decision 18). */
export const DEFAULT_SNAPSHOT_BUDGET_CHARS = 48_000;

const RECENT_JOURNAL_COUNT = 3;

interface SnapshotBlock {
  path: string;
  content: string;
  updatedAt: number;
}

function ownerLabel(scope: MemoryScope): string {
  return `${scope.owner.type}:${scope.owner.id}`;
}

function renderSnapshot(header: string, pinned: SnapshotBlock[], journals: SnapshotBlock[], indexContent: string): string {
  const pinnedPart = pinned.map((b) => `\n## pinned: ${b.path}\n\n${b.content}\n`).join("");
  const journalPart = journals.map((b) => `\n## journal: ${b.path}\n\n${b.content}\n`).join("");
  return `${header}${pinnedPart}${journalPart}\n## index: /\n\n${indexContent}`;
}

/**
 * Assembles the wake-time memory snapshot for `scope`: a header line, the
 * full rendered body of every pinned file (path order), the 3 most recent
 * journal files, and the virtual root `index.md`. Own-scope only — never
 * pulls in team-projected files, even though `listFiles`/`readFile` would
 * happily union them in for a regular read.
 *
 * When the assembled content exceeds `budgetChars`, pinned + journal
 * blocks are dropped oldest-first (by `updatedAt`) until it fits (or until
 * none remain — the header and root index are never dropped), and a
 * truncation note is appended.
 */
export async function assembleMemorySnapshot(
  db: AppDb,
  scope: MemoryScope,
  opts?: AssembleMemorySnapshotOptions,
): Promise<string> {
  const budgetChars = opts?.budgetChars ?? DEFAULT_SNAPSHOT_BUDGET_CHARS;

  const summaries = await listFiles(db, scope);
  // Real stored paths never contain a colon (normalizePath rejects it) —
  // `listFiles`' `team:{id}/…` virtual-prefix entries are the only ones
  // that do, so this filter is an exact own-scope check, not a heuristic.
  const own = summaries.filter((f) => !f.path.includes(":"));

  const pinnedSummaries = own.filter((f) => f.pinned).sort((a, b) => a.path.localeCompare(b.path));
  // "Most recent" journal files means most recent *calendar date*, not
  // write timestamp — journal paths are `journal/YYYY-MM-DD.md`, which
  // sorts lexicographically identically to chronologically, and doing it
  // this way sidesteps `updatedAt` ties when several journal files are
  // written back-to-back within the same millisecond (routine in tests,
  // and not impossible in production during a backfill/import).
  const journalSummaries = own
    .filter((f) => f.path.startsWith("journal/"))
    .sort((a, b) => b.path.localeCompare(a.path))
    .slice(0, RECENT_JOURNAL_COUNT);

  const pinnedBlocks: SnapshotBlock[] = [];
  for (const s of pinnedSummaries) {
    const result = await readFile(db, scope, s.path);
    if (result.kind === "file") {
      pinnedBlocks.push({ path: s.path, content: result.rendered, updatedAt: s.updatedAt });
    }
  }

  const journalBlocks: SnapshotBlock[] = [];
  for (const s of journalSummaries) {
    const result = await readFile(db, scope, s.path);
    if (result.kind === "file") {
      journalBlocks.push({ path: s.path, content: result.rendered, updatedAt: s.updatedAt });
    }
  }

  const indexResult = await readFile(db, scope, "");
  const indexContent = indexResult.kind === "directory" ? indexResult.rendered : "";

  const header = `# Memory snapshot — ${ownerLabel(scope)} — ${new Date().toISOString().slice(0, 10)}\n`;

  // `journalBlocks` is already newest-first (see the sort above); its last
  // element is the oldest of the (up to 3) included journals.
  let remainingPinned = [...pinnedBlocks];
  let remainingJournals = [...journalBlocks];
  let rendered = renderSnapshot(header, remainingPinned, remainingJournals, indexContent);
  let droppedCount = 0;

  // Oldest-first within each section (decision 18): journals (routine,
  // high-volume, ordered by calendar date) are trimmed before pinned
  // files (explicitly curated, ordered by write recency) — journals are
  // the section explicitly deemed "recent-only" by the spec; pinned files
  // have no such cap and are the higher-value, deliberately-kept set.
  while (rendered.length > budgetChars && remainingJournals.length > 0) {
    remainingJournals = remainingJournals.slice(0, -1);
    droppedCount++;
    rendered = renderSnapshot(header, remainingPinned, remainingJournals, indexContent);
  }
  while (rendered.length > budgetChars && remainingPinned.length > 0) {
    let oldestIdx = 0;
    for (let i = 1; i < remainingPinned.length; i++) {
      if (remainingPinned[i].updatedAt < remainingPinned[oldestIdx].updatedAt) oldestIdx = i;
    }
    remainingPinned = remainingPinned.filter((_, i) => i !== oldestIdx);
    droppedCount++;
    rendered = renderSnapshot(header, remainingPinned, remainingJournals, indexContent);
  }

  if (droppedCount > 0) {
    rendered += `\n\n---\n_[snapshot truncated: ${droppedCount} file(s) omitted to fit the ${budgetChars}-char budget]_\n`;
  }

  return rendered;
}
