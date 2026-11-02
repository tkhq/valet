import { useMemo } from "react";
import type { MemoryTreeEntry } from "@valet/api/wire";
import { useMemoryTree } from "~/api/memory";
import { Badge, Spinner } from "~/components/primitives";
import { relativeTime } from "~/lib/relative-time";
import { useListOwner } from "~/lib/use-list-owner";
import { usageLabel } from "./memory-usage";

/**
 * The principles view (brain spec, "Principles"): the rules agents follow,
 * saved with save_principle when a person corrects Valet or states a rule.
 * The built-in principle comes first; each saved principle shows its rule,
 * its scope, and how often agents used it.
 */

/** A principle file, in the own scope or under a team's `team:{id}/` prefix. */
export function isPrincipleEntry(entry: MemoryTreeEntry): boolean {
  return !entry.dir && /^(?:team:[^/]+\/)?principles\/[^/]+\.md$/.test(entry.path);
}

/** Own principles first, then team principles; most used first in each group. */
export function sortPrinciples(entries: MemoryTreeEntry[]): MemoryTreeEntry[] {
  const team = (e: MemoryTreeEntry) => (e.path.startsWith("team:") ? 1 : 0);
  return [...entries].sort((a, b) => team(a) - team(b) || b.useCount - a.useCount || a.path.localeCompare(b.path));
}

export function MemoryPrinciplesPanel({ onSelect }: { onSelect: (path: string) => void }) {
  const owner = useListOwner();
  const treeQ = useMemoryTree(owner);
  const principles = useMemo(() => sortPrinciples((treeQ.data?.entries ?? []).filter(isPrincipleEntry)), [treeQ.data]);
  const now = Date.now();

  if (treeQ.isLoading) {
    return <div className="flex flex-1 items-center justify-center p-8"><Spinner /></div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="border-b border-line p-4 text-sm text-muted">
        Rules Valet follows in every conversation. Correct Valet or tell it a rule, and it saves a principle here.
      </p>
      <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
        <li className="px-4 py-3">
          <div className="flex items-center gap-2 text-sm text-ink">
            <span>Learn from the org</span>
            <Badge>Built in</Badge>
          </div>
          <p className="mt-1 text-xs text-muted">Saves a principle when you correct Valet or state a rule, and checks principles before open-ended work.</p>
        </li>
        {principles.length === 0 ? (
          <li className="p-8 text-center text-sm text-muted">No saved principles yet. Tell Valet a rule for your work to add one.</li>
        ) : (
          principles.map((entry) => (
            <li key={entry.path} aria-label={entry.path} className="px-4 py-3">
              <button
                type="button"
                onClick={() => onSelect(entry.path)}
                className="flex max-w-full items-center gap-2 truncate text-left text-sm text-ink hover:underline"
              >
                <span className="truncate">{entry.title || entry.path}</span>
                {entry.path.startsWith("team:") && <Badge>Team</Badge>}
              </button>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                <span>{usageLabel(entry, now)}</span>
                <span>{`Edited ${relativeTime(entry.updatedAt, now)}`}</span>
                <span className="truncate font-mono">{entry.path}</span>
              </div>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
