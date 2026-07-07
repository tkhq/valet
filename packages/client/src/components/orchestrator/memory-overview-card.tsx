import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/cn';
import { formatRelativeTime } from '@/lib/format';
import type { MemoryFileListing } from '@/api/types';
import {
  fileName,
  formatSize,
  getDirColor,
  sortFilesForDisplay,
} from './memory-explorer-utils';

const RECENT_COUNT = 5;
const PINNED_COUNT = 4;

/**
 * Abridged memory card for the orchestrator dashboard: headline stats plus
 * pinned and recently-updated shortcuts. The full browsing/editing/graph
 * experience lives on the dedicated /orchestrator/memory page.
 */
export function MemoryOverviewCard({ files }: { files: MemoryFileListing[] }) {
  const totalSize = React.useMemo(() => files.reduce((s, f) => s + f.size, 0), [files]);
  const pinned = React.useMemo(
    () => sortFilesForDisplay(files.filter((f) => f.pinned)).slice(0, PINNED_COUNT),
    [files],
  );
  const recent = React.useMemo(() => {
    const pinnedPaths = new Set(pinned.map((f) => f.path));
    return sortFilesForDisplay(files)
      .filter((f) => !pinnedPaths.has(f.path))
      .slice(0, RECENT_COUNT);
  }, [files, pinned]);

  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-surface-1">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">Memory</span>
          {files.length > 0 && (
            <span className="flex items-center gap-2 text-2xs text-neutral-400 dark:text-neutral-500">
              <span className="font-mono tabular-nums">{files.length} files</span>
              <span className="text-neutral-300 dark:text-neutral-700">/</span>
              <span className="font-mono tabular-nums">{formatSize(totalSize)}</span>
            </span>
          )}
        </div>
        <Link
          to="/orchestrator/memory"
          className="rounded-md px-2 py-1 text-2xs font-medium text-accent transition-colors hover:bg-accent/10"
        >
          Open memory &rarr;
        </Link>
      </div>

      {/* Body */}
      {files.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-neutral-400 dark:text-neutral-600">
          No memory files yet — your orchestrator fills this in as it learns.
        </p>
      ) : (
        <div className="grid gap-x-6 px-4 py-3 sm:grid-cols-2">
          {pinned.length > 0 && (
            <ShortcutList title="Pinned" files={pinned} />
          )}
          <ShortcutList title="Recently updated" files={recent} />
        </div>
      )}
    </div>
  );
}

function ShortcutList({ title, files }: { title: string; files: MemoryFileListing[] }) {
  if (files.length === 0) return null;
  return (
    <div className="min-w-0">
      <p className="mb-1 text-2xs font-medium uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
        {title}
      </p>
      <ul>
        {files.map((file) => {
          const colors = getDirColor(file.path.split('/')[0]);
          return (
            <li key={file.path}>
              <Link
                to="/orchestrator/memory"
                search={{ file: file.path }}
                title={file.description || file.path}
                className="group flex w-full items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-800/40"
              >
                <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', colors.dot)} />
                <span className="min-w-0 truncate font-mono text-xs text-neutral-600 group-hover:text-neutral-900 dark:text-neutral-400 dark:group-hover:text-neutral-100">
                  {fileName(file.path)}
                </span>
                <span className="ml-auto shrink-0 text-2xs tabular-nums text-neutral-300 dark:text-neutral-600">
                  {formatRelativeTime(file.updatedAt)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
