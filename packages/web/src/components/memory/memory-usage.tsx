import { useMemo, useState } from "react";
import { Pin } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import type { MemoryTreeEntry } from "@valet/api/wire";
import { api } from "~/api/client";
import { useMemoryTree } from "~/api/memory";
import { Badge, Button, Checkbox, ConfirmDialog, FilterChips, Spinner } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { relativeTime } from "~/lib/relative-time";
import { useListOwner } from "~/lib/use-list-owner";

/**
 * The memory usage view (brain spec, "Usage"): when an agent last used each
 * file, which files no agent has used, and a way to trim stale files.
 *
 * "Used" means an agent chose to read the file, or a turn cited it. A file
 * the memory snapshot loads at wake shows that separately: the agent did
 * not choose it, so a load alone is not a use. It is not "never used"
 * either: a pinned file is in every prompt, so no agent needs to open it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** A file with no use and no edit for this long is stale. */
export const STALE_AFTER_MS = 30 * DAY_MS;

export type UsageFilter = "all" | "never" | "stale";
export type UsageSort = "least-recent" | "most-used" | "path";

/** No use, no load at wake and no edit for 30 days. A new file that no
 * agent used yet is not stale: it has not had the chance. Nor is any file
 * before tracking (`usageSince`) has run for 30 days: an old file can be
 * in daily use. */
export function isStale(entry: MemoryTreeEntry, now: number, usageSince: number): boolean {
  return Math.max(entry.lastUsedAt ?? 0, entry.lastLoadedAt ?? 0, entry.updatedAt, usageSince) < now - STALE_AFTER_MS;
}

/** No agent read it, no turn cited it, and no snapshot loaded it. */
function isNeverUsed(entry: MemoryTreeEntry): boolean {
  return entry.lastUsedAt === null && entry.lastLoadedAt === null;
}

export function filterUsage(entries: MemoryTreeEntry[], filter: UsageFilter, now: number, usageSince: number): MemoryTreeEntry[] {
  if (filter === "never") return entries.filter(isNeverUsed);
  if (filter === "stale") return entries.filter((e) => isStale(e, now, usageSince));
  return entries;
}

function trackedFor(now: number, usageSince: number): string {
  const days = Math.floor((now - usageSince) / DAY_MS);
  if (days < 1) return "Valet started to track use today.";
  return `Valet has tracked use for ${days} ${days === 1 ? "day" : "days"}.`;
}

/** `least-recent` puts never-used files first (oldest edit first), then
 * the rest by last use, oldest first. */
export function sortUsage(entries: MemoryTreeEntry[], sort: UsageSort): MemoryTreeEntry[] {
  const out = [...entries];
  if (sort === "path") return out.sort((a, b) => a.path.localeCompare(b.path));
  if (sort === "most-used") return out.sort((a, b) => b.useCount - a.useCount || a.path.localeCompare(b.path));
  return out.sort((a, b) => {
    if (a.lastUsedAt === null || b.lastUsedAt === null) {
      if (a.lastUsedAt !== b.lastUsedAt) return a.lastUsedAt === null ? -1 : 1;
      return a.updatedAt - b.updatedAt || a.path.localeCompare(b.path);
    }
    return a.lastUsedAt - b.lastUsedAt || a.path.localeCompare(b.path);
  });
}

export function usageLabel(entry: MemoryTreeEntry, now: number): string {
  if (entry.lastUsedAt === null) {
    return entry.lastLoadedAt === null ? "Never used" : `Loaded at wake ${relativeTime(entry.lastLoadedAt, now)}`;
  }
  return `Used ${relativeTime(entry.lastUsedAt, now)} · ${entry.useCount} ${entry.useCount === 1 ? "use" : "uses"}`;
}

/** A file under `lib/` mirrors a repository. Only the repository can
 * remove it, so the view offers no trim for it. */
function isTrimmable(entry: MemoryTreeEntry): boolean {
  return !entry.path.startsWith("lib/");
}

function fileCount(n: number): string {
  return `${n} ${n === 1 ? "file" : "files"}`;
}

const FILTERS: readonly { value: UsageFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "never", label: "Never used" },
  { value: "stale", label: "Stale" },
];

const SORTS: readonly { value: UsageSort; label: string }[] = [
  { value: "least-recent", label: "Least recent" },
  { value: "most-used", label: "Most used" },
  { value: "path", label: "Path" },
];

export function MemoryUsagePanel({ onSelect, now = Date.now() }: {
  onSelect: (path: string) => void;
  /** Injectable for tests. */
  now?: number;
}) {
  const owner = useListOwner();
  const treeQ = useMemoryTree(owner);
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<UsageFilter>("all");
  const [sort, setSort] = useState<UsageSort>("least-recent");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);

  const entries = useMemo(() => treeQ.data?.entries ?? [], [treeQ.data]);
  // An unknown start reads as now, so nothing looks stale.
  const usageSince = treeQ.data?.usageSince ?? now;
  const visible = useMemo(
    () => sortUsage(filterUsage(entries, filter, now, usageSince), sort),
    [entries, filter, sort, now, usageSince],
  );
  // Act only on what the filter shows, so a hidden row is never deleted.
  const chosen = visible.filter((e) => selected.has(e.path)).map((e) => e.path);
  const neverUsed = entries.filter(isNeverUsed).length;

  function toggle(path: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  async function trim() {
    setPending(true);
    setFailed([]);
    const missed: string[] = [];
    for (const path of chosen) {
      try {
        await api.deleteMemoryDoc(path, owner);
      } catch {
        missed.push(path);
      }
    }
    await queryClient.invalidateQueries({ queryKey: ["memory"] });
    setPending(false);
    setSelected(new Set(missed));
    setFailed(missed);
    if (missed.length === 0) setConfirming(false);
  }

  if (treeQ.isLoading) {
    return <div className="flex flex-1 items-center justify-center p-8"><Spinner /></div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-3 border-b border-line p-4">
        <p className="text-sm text-muted">
          {fileCount(entries.length)}, {neverUsed} never used. A file is used when an agent reads it or a
          turn cites it. Pinned files and principles load at wake instead. Stale means no use, no load and no edit for 30 days. {trackedFor(now, usageSince)}
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted" aria-hidden>Show</span>
            <FilterChips label="Show" options={FILTERS} value={filter} onChange={(v) => { setFilter(v); setSelected(new Set()); }} />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted" aria-hidden>Sort</span>
            <FilterChips label="Sort" options={SORTS} value={sort} onChange={setSort} />
          </div>
          <Button
            type="button"
            variant="danger"
            size="sm"
            className="ml-auto"
            disabled={chosen.length === 0}
            onClick={() => { setFailed([]); setConfirming(true); }}
          >
            {chosen.length === 0 ? "Delete" : `Delete ${fileCount(chosen.length)}`}
          </Button>
        </div>
      </div>
      {visible.length === 0 ? (
        <p className="p-8 text-center text-sm text-muted">
          {filter === "stale" && now - usageSince < STALE_AFTER_MS
            ? "No file can be stale before Valet has tracked use for 30 days."
            : "No files match this filter."}
        </p>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
          {visible.map((entry) => (
            <li key={entry.path} aria-label={entry.path} className="flex items-start gap-3 px-4 py-3">
              {isTrimmable(entry) ? (
                <Checkbox
                  className="mt-0.5"
                  aria-label={`Select ${entry.path}`}
                  checked={selected.has(entry.path)}
                  onCheckedChange={(on) => toggle(entry.path, on)}
                />
              ) : (
                <span className="h-4 w-4 shrink-0" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => onSelect(entry.path)}
                  className="flex max-w-full items-center gap-1.5 truncate text-left text-sm text-ink hover:underline"
                >
                  {entry.pinned && <Pin className="h-3 w-3 shrink-0 text-muted" aria-label="Pinned" />}
                  <span className="truncate">{entry.path}</span>
                </button>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                  <span className={cn(isNeverUsed(entry) && "text-ink")}>{usageLabel(entry, now)}</span>
                  {entry.lastUsedAt !== null && entry.lastLoadedAt !== null && <Badge>{`Loaded at wake ${relativeTime(entry.lastLoadedAt, now)}`}</Badge>}
                  <span>{`Edited ${relativeTime(entry.updatedAt, now)}`}</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => { if (!pending) setConfirming(open); }}
        title={`Delete ${fileCount(chosen.length)}?`}
        description="Agents can no longer read or load these files. You cannot undo this."
        confirmLabel={`Delete ${fileCount(chosen.length)}`}
        pendingLabel="Deleting…"
        pending={pending}
        error={failed.length > 0
          ? `Could not delete ${failed.join(", ")}. Check that you have permission to edit this workspace's memory, then try again.`
          : undefined}
        onConfirm={() => void trim()}
      >
        <ul className="max-h-48 overflow-y-auto text-sm text-ink">
          {chosen.map((path) => <li key={path} className="truncate">{path}</li>)}
        </ul>
      </ConfirmDialog>
    </div>
  );
}
