import { useMemo } from "react";
import type { MemoryPrincipleEntry, MemoryTreeEntry } from "@valet/api/wire";
import { BUILTIN_PRINCIPLES, builtinPrinciplePath, type BuiltinPrinciple } from "@valet/shared";
import { useMemoryPrinciples, useMemoryTree } from "~/api/memory";
import { Badge, Spinner } from "~/components/primitives";
import { relativeTime } from "~/lib/relative-time";
import { useListOwner } from "~/lib/use-list-owner";
import { usageLabel } from "./memory-usage";

/**
 * The principles view (brain spec, "Principles"): the rules agents follow.
 * The base principle comes first, then saved principles (own, then team),
 * then principles synced from a repository's `.valet/memory/principles/`,
 * which mount read-only at `lib/principles/` (own, team, or `org:{id}/`).
 * The built-in principles Valet ships come last, minus any that a saved
 * file at the same path replaces. Usage and edit times come from the
 * own-scope tree, so only own files show them.
 */

/** The read prefix of a team or org path: `team:{id}/` or `org:{id}/`. */
const SCOPE_PREFIX = /^(?:team|org):[^/]+\//;

/** A principle file, saved (`principles/`) or synced (`lib/principles/`),
 * in the own scope or under a team or org prefix. */
export function isPrincipleEntry(entry: Pick<MemoryTreeEntry, "path" | "dir">): boolean {
  return !entry.dir && /^(?:lib\/)?principles\/[^/]+\.md$/.test(entry.path.replace(SCOPE_PREFIX, ""));
}

/** True for a principle synced from a repository. */
export function isSyncedPrinciple(path: string): boolean {
  return path.replace(SCOPE_PREFIX, "").startsWith("lib/principles/");
}

/** Own saved first, then team saved, then synced; path order in each group. */
export function sortPrinciples<T extends { path: string }>(entries: T[]): T[] {
  const group = (e: T) => (isSyncedPrinciple(e.path) ? 2 : SCOPE_PREFIX.test(e.path) ? 1 : 0);
  return [...entries].sort((a, b) => group(a) - group(b) || a.path.localeCompare(b.path));
}

/** The built-in principles that no saved own file replaces. */
export function unchangedBuiltins(entries: Array<{ path: string }>): BuiltinPrinciple[] {
  const own = new Set(entries.map((entry) => entry.path));
  return BUILTIN_PRINCIPLES.filter((principle) => !own.has(builtinPrinciplePath(principle)));
}

function scopeBadge(path: string): string | null {
  if (path.startsWith("team:")) return "Team";
  if (path.startsWith("org:")) return "Org";
  return null;
}

export function MemoryPrinciplesPanel({ onSelect }: { onSelect: (path: string) => void }) {
  const owner = useListOwner();
  const principlesQ = useMemoryPrinciples(owner);
  const treeQ = useMemoryTree(owner);
  const principles = useMemo(
    () => sortPrinciples((principlesQ.data?.principles ?? []).filter((p) => isPrincipleEntry({ path: p.path, dir: false }))),
    [principlesQ.data],
  );
  const own = useMemo(() => new Map((treeQ.data?.entries ?? []).map((entry) => [entry.path, entry])), [treeQ.data]);
  const builtins = useMemo(() => unchangedBuiltins(principles), [principles]);
  const now = Date.now();

  if (principlesQ.isLoading) {
    return <div className="flex flex-1 items-center justify-center p-8"><Spinner /></div>;
  }

  const row = (principle: MemoryPrincipleEntry) => {
    const entry = own.get(principle.path);
    const badge = scopeBadge(principle.path);
    return (
      <li key={principle.path} aria-label={principle.path} className="px-4 py-3">
        <button
          type="button"
          onClick={() => onSelect(principle.path)}
          className="flex max-w-full items-center gap-2 truncate text-left text-sm text-ink hover:underline"
        >
          <span className="truncate">{principle.title || principle.path}</span>
          {badge && <Badge>{badge}</Badge>}
          {isSyncedPrinciple(principle.path) && <Badge>Synced</Badge>}
        </button>
        {principle.description && <p className="mt-1 text-xs text-muted">{principle.description}</p>}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          {entry && <span>{usageLabel(entry, now)}</span>}
          {entry && <span>{`Edited ${relativeTime(entry.updatedAt, now)}`}</span>}
          <span className="truncate font-mono">{principle.path}</span>
        </div>
      </li>
    );
  };

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
        {principles.map(row)}
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
