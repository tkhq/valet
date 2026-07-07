import type { D1Database } from '@cloudflare/workers-types';
import { ensureLinksIndexed } from './db/memory-link-backfill.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface SnapshotFile {
  path: string;
  content: string;
}

/** A pinned file's 1-hop neighbor — path + description + type only, never body. */
export interface SnapshotNeighbor {
  path: string;
  type: string;
  description: string;
}

export interface MemorySnapshot {
  files: SnapshotFile[];
  neighbors: SnapshotNeighbor[];
  totalTokensEstimate: number;
  truncated: boolean;
}

/** Neighbor tier is capped at 20% of the total token budget. */
const NEIGHBOR_BUDGET_FRACTION = 0.2;
/** Non-expired predicate reused across every snapshot query. */
const NOT_EXPIRED = `(expires IS NULL OR expires > datetime('now'))`;

// ─── Load Snapshot ──────────────────────────────────────────────────────────

/**
 * Load pinned memory files and recent journals for auto-injection into
 * the orchestrator's system prompt at session start.
 *
 * Priority order:
 * 1. Pinned files (preferences/*) — always included, dropped last
 * 2. Today's journal — included if it exists
 * 3. Yesterday's journal — included if it fits
 *
 * If the total exceeds the token budget, journals are truncated first,
 * then least-recently-accessed pinned files are dropped.
 */
export async function loadMemorySnapshot(
  rawDb: D1Database,
  userId: string,
  tokenBudget = 8000,
): Promise<MemorySnapshot> {
  const scope = { userId };
  // Neighbor promotion reads memory_links — make sure it is backfilled first.
  // ensureLinksIndexed never calls back into the snapshot builder (no recursion).
  await ensureLinksIndexed(rawDb, scope);

  // 1. Fetch all pinned files (expired ones never load)
  const pinnedRows = await rawDb
    .prepare(
      `SELECT path, content, last_accessed_at FROM orchestrator_memory_files
       WHERE user_id = ? AND pinned = 1 AND ${NOT_EXPIRED} ORDER BY last_accessed_at DESC`,
    )
    .bind(userId)
    .all<{ path: string; content: string; last_accessed_at: string }>();
  const pinnedFiles: (SnapshotFile & { lastAccessedAt: string })[] = (pinnedRows.results || []).map(
    (r) => ({
      path: r.path,
      content: r.content,
      lastAccessedAt: r.last_accessed_at,
    }),
  );

  // 2. Fetch today's and yesterday's journal
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const journalPaths = [`journal/${today}.md`, `journal/${yesterday}.md`];

  const journalRows = await rawDb
    .prepare(
      `SELECT path, content FROM orchestrator_memory_files
       WHERE user_id = ? AND path IN (?, ?) AND ${NOT_EXPIRED}`,
    )
    .bind(userId, journalPaths[0], journalPaths[1])
    .all<{ path: string; content: string }>();
  // Sort: today first, then yesterday
  const journalFiles: SnapshotFile[] = journalPaths
    .map((p) => (journalRows.results || []).find((r) => r.path === p))
    .filter((r): r is { path: string; content: string } => !!r && r.content.trim().length > 0);

  // 3. Estimate tokens and fit within budget
  const estimateTokens = (s: string) => Math.ceil(s.length / 4);

  // Neighbor tier is carved OUT of the total budget (not added on top), so the
  // pinned+journal tiers must fit within the remainder.
  const neighborBudget = Math.floor(tokenBudget * NEIGHBOR_BUDGET_FRACTION);
  const mainBudget = tokenBudget - neighborBudget;

  let totalTokens = 0;
  let truncated = false;
  const result: SnapshotFile[] = [];

  // Add pinned files first
  for (const f of pinnedFiles) {
    const tokens = estimateTokens(f.content);
    if (totalTokens + tokens <= mainBudget) {
      result.push({ path: f.path, content: f.content });
      totalTokens += tokens;
    } else {
      // Over budget — remaining pinned files (least-recently-accessed) are dropped
      truncated = true;
    }
  }

  // Add journals (today first, then yesterday) — truncate content if needed
  for (const f of journalFiles) {
    const tokens = estimateTokens(f.content);
    const remaining = mainBudget - totalTokens;

    if (remaining <= 0) {
      truncated = true;
      break;
    }

    if (tokens <= remaining) {
      result.push({ path: f.path, content: f.content });
      totalTokens += tokens;
    } else {
      // Truncate journal content to fit
      const charBudget = remaining * 4;
      const truncatedContent = f.content.slice(0, charBudget) + '\n\n[... truncated]';
      result.push({ path: f.path, content: truncatedContent });
      totalTokens += remaining;
      truncated = true;
    }
  }

  // 4. Neighbor tier: pinned files' 1-hop neighbors (path + description + type
  //    only, never bodies), under its own carved-out sub-budget.
  const neighbors = await loadNeighborTier(
    rawDb,
    userId,
    pinnedFiles.map((f) => f.path),
    new Set(result.map((f) => f.path)),
    neighborBudget,
  );

  return {
    files: result,
    neighbors,
    totalTokensEstimate: totalTokens,
    truncated,
  };
}

/**
 * Load the neighbor tier: files linked from any pinned file (1 hop), excluding
 * expired files and files already present in the pinned/journal tiers. Returns
 * `- [type] path — description`-shaped entries whose combined estimate stays
 * under `neighborBudget` tokens. Bodies are never loaded.
 */
async function loadNeighborTier(
  rawDb: D1Database,
  userId: string,
  pinnedPaths: string[],
  alreadyIncluded: Set<string>,
  neighborBudget: number,
): Promise<SnapshotNeighbor[]> {
  if (pinnedPaths.length === 0 || neighborBudget <= 0) return [];

  const placeholders = pinnedPaths.map(() => '?').join(',');
  const rows = await rawDb
    .prepare(
      `SELECT DISTINCT m.path AS path, m.type AS type, m.description AS description
       FROM memory_links l
       JOIN orchestrator_memory_files m ON m.user_id = l.user_id AND m.path = l.to_path
       WHERE l.user_id = ? AND l.from_path IN (${placeholders}) AND ${NOT_EXPIRED}
       ORDER BY m.path`,
    )
    .bind(userId, ...pinnedPaths)
    .all<{ path: string; type: string; description: string }>();

  const estimateTokens = (s: string) => Math.ceil(s.length / 4);
  const neighbors: SnapshotNeighbor[] = [];
  let used = 0;
  for (const r of rows.results ?? []) {
    if (alreadyIncluded.has(r.path)) continue;
    const line = formatNeighborLine(r);
    const cost = estimateTokens(line);
    if (used + cost > neighborBudget) break;
    neighbors.push({ path: r.path, type: r.type, description: r.description });
    used += cost;
  }
  return neighbors;
}

/** `- [type] path — description` (the ` — description` suffix omitted when empty). */
function formatNeighborLine(n: SnapshotNeighbor): string {
  const type = n.type || 'note';
  const desc = n.description ? ` — ${n.description}` : '';
  return `- [${type}] ${n.path}${desc}`;
}

// ─── Format Snapshot ────────────────────────────────────────────────────────

/**
 * Render a memory snapshot as markdown for injection into the orchestrator's
 * persona files. Returns empty string if no files were loaded.
 */
export function formatMemorySnapshot(snapshot: MemorySnapshot): string {
  if (snapshot.files.length === 0 && snapshot.neighbors.length === 0) return '';

  const lines: string[] = [
    '## Memory Snapshot (auto-loaded)',
    '',
    'The following files were loaded from your memory at session start. You do NOT need to call `mem_read` for these — they are already in context.',
    '',
  ];

  for (const file of snapshot.files) {
    lines.push(`### ${file.path}`, '', file.content, '');
  }

  if (snapshot.neighbors.length > 0) {
    lines.push(
      '## Related (neighbor files)',
      '',
      'Linked from your pinned files (not loaded — use `mem_read` to open):',
      '',
    );
    for (const n of snapshot.neighbors) {
      lines.push(formatNeighborLine(n));
    }
    lines.push('');
  }

  if (snapshot.truncated) {
    lines.push(
      '> Some files were omitted or truncated to fit the token budget. Use `mem_read` to access them.',
      '',
    );
  }

  return lines.join('\n');
}
