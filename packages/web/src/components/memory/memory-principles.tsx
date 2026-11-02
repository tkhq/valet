import { useMemo } from "react";
import type { MemoryTreeEntry } from "@valet/api/wire";
import { BUILTIN_PRINCIPLES, builtinPrinciplePath, type BuiltinPrinciple } from "@valet/shared";
import { useMemoryTree } from "~/api/memory";
import { Badge, Spinner } from "~/components/primitives";
import { relativeTime } from "~/lib/relative-time";
import { useListOwner } from "~/lib/use-list-owner";
import { usageLabel } from "./memory-usage";

/**
 * The principles view (brain spec, "Principles"): the rules agents follow,
 * saved with save_principle when a person corrects Valet or states a rule.
 * The base principle comes first. Each saved principle shows its rule, its
 * scope, and how often agents used it. Synced principles come from a
 * repository's `.valet/memory/principles/` and mount read-only at
 * `lib/principles/`. The built-in principles Valet ships come last, minus
 * any that a saved file at the same path replaces.
 */

/** A principle file, in the own scope or under a team's `team:{id}/` prefix,
 * saved (`principles/`) or synced from a repository (`lib/principles/`). */
export function isPrincipleEntry(entry: MemoryTreeEntry): boolean {
  return !entry.dir && /^(?:team:[^/]+\/)?(?:lib\/)?principles\/[^/]+\.md$/.test(entry.path);
}

/** True for a principle synced from a repository. */
export function isSyncedPrinciple(path: string): boolean {
  return /^(?:team:[^/]+\/)?lib\/principles\//.test(path);
}

/** The built-in principles that no saved own file replaces. */
export function unchangedBuiltins(entries: MemoryTreeEntry[]): BuiltinPrinciple[] {
  const own = new Set(entries.map((entry) => entry.path));
  return BUILTIN_PRINCIPLES.filter((principle) => !own.has(builtinPrinciplePath(principle)));
}

/** Own principles first, then team principles, then synced ones; most used
 * first in each group. */
export function sortPrinciples(entries: MemoryTreeEntry[]): MemoryTreeEntry[] {
  const group = (e: MemoryTreeEntry) => (isSyncedPrinciple(e.path) ? 2 : e.path.startsWith("team:") ? 1 : 0);
  return [...entries].sort((a, b) => group(a) - group(b) || b.useCount - a.useCount || a.path.localeCompare(b.path));
}

export function MemoryPrinciplesPanel({ onSelect }: { onSelect: (path: string) => void }) {
  const owner = useListOwner();
  const treeQ = useMemoryTree(owner);
  const principles = useMemo(() => sortPrinciples((treeQ.data?.entries ?? []).filter(isPrincipleEntry)), [treeQ.data]);
  const builtins = useMemo(() => unchangedBuiltins(principles), [principles]);
  const now = Date.now();

  if (treeQ.isLoading) {
    return <div className="flex flex-1 items-center justify-center p-8"><Spinner /></div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="border-b border-line p-4 text-sm text-muted">
        Rules Valet follows in every conversation. Correct Valet or tell it a rule, and it saves or updates a principle here.
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
                {isSyncedPrinciple(entry.path) && <Badge>Synced</Badge>}
              </button>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                <span>{usageLabel(entry, now)}</span>
                <span>{`Edited ${relativeTime(entry.updatedAt, now)}`}</span>
                <span className="truncate font-mono">{entry.path}</span>
              </div>
            </li>
          ))
        )}
        {builtins.map((principle) => (
          <li key={principle.name} aria-label={builtinPrinciplePath(principle)} className="px-4 py-3">
            <button
              type="button"
              onClick={() => onSelect(builtinPrinciplePath(principle))}
              className="flex max-w-full items-center gap-2 truncate text-left text-sm text-ink hover:underline"
            >
              <span className="truncate">{principle.rule}</span>
              <Badge>Built in</Badge>
            </button>
            <p className="mt-1 text-xs text-muted">{principle.when}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
