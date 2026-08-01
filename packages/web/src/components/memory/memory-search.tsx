import { useState, type KeyboardEvent } from "react";
import { Search, X } from "lucide-react";
import type { MemoryTreeEntry } from "@valet/api/wire";
import { useMemorySearch, useMemoryTree } from "~/api/memory";
import { useDebouncedValue } from "~/hooks/use-debounced-value";
import { Badge, Input, Spinner } from "~/components/primitives";
import { formatBytes } from "~/lib/format-bytes";
import { MemoryTree } from "./memory-tree";

/** Pure: tree entries → the header stats line, V1-style
 * ("346 files · 3.8 MB · 35 pinned"; pinned omitted when zero). */
export function treeStatsLine(entries: readonly MemoryTreeEntry[]): string {
  let bytes = 0;
  let pinned = 0;
  for (const e of entries) {
    bytes += e.sizeBytes;
    if (e.pinned) pinned += 1;
  }
  const parts = [`${entries.length} file${entries.length === 1 ? "" : "s"}`, formatBytes(bytes)];
  if (pinned > 0) parts.push(`${pinned} pinned`);
  return parts.join(" · ");
}

const DEBOUNCE_MS = 250;

export interface MemorySearchPaneProps {
  /** Currently open file's path, for the active-row highlight. */
  activePath?: string;
  onSelect: (path: string) => void;
}

/**
 * Left pane of the memory explorer (Task 6 brief): a search box above the
 * tree that, once a query settles (debounced 250ms), swaps the tree for a
 * result list; ESC or the clear button restores the tree. Self-contained —
 * owns both the tree query (for the resting state) and the search query
 * (for the active state), matching the dashboard cards' "own your query"
 * pattern so the two route shells (`/memory`, `/memory/$`) just mount this
 * with an `activePath`.
 */
export function MemorySearchPane({ activePath, onSelect }: MemorySearchPaneProps) {
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query, DEBOUNCE_MS);
  const active = debounced.trim().length > 0;

  const treeQ = useMemoryTree({ enabled: !active });
  const searchQ = useMemorySearch(debounced);

  function clear() {
    setQuery("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") clear();
  }

  return (
    <div className="flex h-full flex-col">
      <div className="relative p-2">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search memory…"
          aria-label="Search memory"
          className="h-8 pl-8 pr-8 text-sm"
        />
        {query.length > 0 && (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear search"
            className="absolute right-4 top-1/2 -translate-y-1/2 text-muted hover:text-ink"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {!active && treeQ.data && treeQ.data.entries.length > 0 && (
        <p className="px-4 pb-1.5 text-[11px] text-muted">{treeStatsLine(treeQ.data.entries)}</p>
      )}

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {active ? (
          <SearchResults query={searchQ} onSelect={onSelect} />
        ) : (
          <>
            {treeQ.isLoading && (
              <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted">
                <Spinner size={14} /> Loading…
              </div>
            )}
            {treeQ.error && (
              <div className="px-2 py-2 text-xs text-danger-500">
                Couldn't load memory.{" "}
                <button type="button" className="underline" onClick={() => treeQ.refetch()}>
                  Retry
                </button>
              </div>
            )}
            {treeQ.data && (
              <MemoryTree entries={treeQ.data.entries} activePath={activePath} onSelect={onSelect} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SearchResults({
  query,
  onSelect,
}: {
  query: ReturnType<typeof useMemorySearch>;
  onSelect: (path: string) => void;
}) {
  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted">
        <Spinner size={14} /> Searching…
      </div>
    );
  }
  if (query.error) {
    return (
      <div className="px-2 py-2 text-xs text-danger-500">
        Couldn't search memory.{" "}
        <button type="button" className="underline" onClick={() => query.refetch()}>
          Retry
        </button>
      </div>
    );
  }
  const results = query.data?.results ?? [];
  if (results.length === 0) {
    return <p className="px-2 py-2 text-xs text-muted">No matches.</p>;
  }
  return (
    <ul className="space-y-0.5">
      {results.map((r) => (
        <li key={r.path}>
          <button
            type="button"
            onClick={() => onSelect(r.path)}
            className="flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left hover:bg-ink-wash"
          >
            <span className="flex w-full items-center gap-1.5">
              <span className="truncate text-sm text-ink">{r.title || r.path}</span>
              <Badge className="ml-auto shrink-0">{r.type}</Badge>
            </span>
            {r.description && <span className="line-clamp-2 text-xs text-muted">{r.description}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}
