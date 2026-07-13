/**
 * Wake bootstrap (Phase 4 decision 17): before assembling the memory
 * snapshot, the orchestrator wake path ensures today's journal file
 * exists so the snapshot always has somewhere fresh to journal into and
 * so `assembleMemorySnapshot`'s "3 most recent journal files" section is
 * never empty on a brand-new day.
 */
import { NotFoundError } from "@valet/shared";
import { readFile, writeFile, type MemoryScope } from "../services/memory.js";
import type { AppDb } from "../lib/drizzle.js";

/** `journal/YYYY-MM-DD.md`, UTC date (`Date#toISOString` is always UTC). */
export function todayJournalPath(now: Date = new Date()): string {
  return `journal/${now.toISOString().slice(0, 10)}.md`;
}

/**
 * Creates today's journal file (`type: 'journal-entry'`) with a minimal
 * header body if it doesn't already exist. Idempotent — a second call on
 * the same UTC day is a no-op (checked via `readFile`, not a blind write,
 * so it never bumps `version`/`updatedAt` on an already-bootstrapped day).
 * Returns the journal path either way.
 */
export async function ensureTodayJournal(db: AppDb, scope: MemoryScope, now: Date = new Date()): Promise<string> {
  const path = todayJournalPath(now);

  try {
    await readFile(db, scope, path);
    return path;
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
  }

  const dateLabel = path.slice("journal/".length, -".md".length);
  await writeFile(db, scope, {
    path,
    content: `# ${dateLabel}\n`,
    type: "journal-entry",
  });
  return path;
}
