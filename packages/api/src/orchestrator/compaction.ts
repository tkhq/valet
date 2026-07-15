/**
 * Journal compaction hook (Phase 4 decisions 9 + 17): wired into an
 * orchestrator session's `compactionHooks`, this appends a "## Compaction"
 * section to today's journal file whenever a compaction completes on the
 * session.
 *
 * The engine awaits compaction hooks INSIDE the turn path (decision 9) — a
 * slow hook stalls the agent loop. This hook is intentionally a single
 * read + write against the memory service directly (host-side, same
 * reasoning as `snapshot.ts`'s HTTP-seam exemption note): no network hop,
 * no retries, no fan-out.
 */
import { and, eq } from "drizzle-orm";
import type { CompactionHook } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { memoryFiles } from "../schema/index.js";
import { writeFile, type MemoryScope } from "../services/memory.js";
import { todayJournalPath } from "./bootstrap.js";

/** Builds a `CompactionHook` that appends to `scope`'s journal for "today"
 * (evaluated at hook-fire time, not session-build time — a hook fired just
 * after midnight lands in the new day's journal). */
export function journalCompactionHook(db: AppDb, scope: MemoryScope): CompactionHook {
  return async ({ mode, summary }) => {
    const path = todayJournalPath();

    const existingRows = await db
      .select({ content: memoryFiles.content })
      .from(memoryFiles)
      .where(
        and(
          eq(memoryFiles.ownerType, scope.owner.type),
          eq(memoryFiles.ownerId, scope.owner.id),
          eq(memoryFiles.path, path),
        ),
      )
      .limit(1);
    const existing = existingRows[0];

    const dateLabel = path.slice("journal/".length, -".md".length);
    const base = existing?.content ?? `# ${dateLabel}\n`;
    const section = `\n\n## Compaction (${mode}, ${new Date().toISOString()})\n${summary}\n`;

    await writeFile(db, scope, { path, content: base + section });
  };
}
