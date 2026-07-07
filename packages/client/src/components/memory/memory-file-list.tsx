import * as React from 'react';
import { cn } from '@/lib/cn';
import { formatRelativeTime } from '@/lib/format';
import { useDebounced } from '@/hooks/use-debounced';
import { useSearchMemoryFiles } from '@/api/orchestrator';
import {
  buildMemoryTree,
  collectDirPaths,
  fileName,
  getDirColor,
  isExpired,
  type MemoryTreeNode,
} from '@/components/orchestrator/memory-explorer-utils';
import { ancestorDirPaths } from '@/components/orchestrator/memory-graph-utils';
import type { MemoryFileListing } from '@/api/types';
import { ChevronIcon, FileIcon, FolderIcon, PinIcon, SearchIcon, XIcon } from './icons';

// Top-level directories with at least this many files start collapsed, so a
// large append-only log (typically journal/) can't drown the overview.
const AUTO_COLLAPSE_FILE_COUNT = 20;

const INDENT_BASE = 12;
const INDENT_PER_LEVEL = 16;

/**
 * Selection-based memory file browser: search box + directory tree. Unlike
 * the old inline explorer, rows don't expand previews — selecting a file
 * hands it to the page's detail pane.
 */
export function MemoryFileList({
  files,
  selectedPath,
  onSelect,
  search,
  onSearchChange,
}: {
  files: MemoryFileListing[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
}) {
  const [expandedDirs, setExpandedDirs] = React.useState<Set<string> | null>(null);

  const debouncedSearch = useDebounced(search, 300);
  const searchQuery = useSearchMemoryFiles(debouncedSearch);
  const isSearching = debouncedSearch.length >= 2;

  const tree = React.useMemo(() => buildMemoryTree(files), [files]);

  // Initialize expansion on first render: everything open except oversized
  // top-level directories.
  React.useEffect(() => {
    if (expandedDirs === null && tree.length > 0) {
      const initial = new Set(collectDirPaths(tree));
      for (const node of tree) {
        if (node.totalFiles >= AUTO_COLLAPSE_FILE_COUNT) initial.delete(node.path);
      }
      setExpandedDirs(initial);
    }
  }, [tree, expandedDirs]);

  // Keep the selected file visible: expand its ancestors whenever selection
  // changes (e.g. via graph click, backlink, or deep link).
  React.useEffect(() => {
    if (!selectedPath) return;
    setExpandedDirs((prev) => {
      const next = new Set(prev ?? []);
      for (const dir of ancestorDirPaths(selectedPath)) next.add(dir);
      return next;
    });
  }, [selectedPath]);

  const toggleDir = (dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Search */}
      <div className="relative border-b border-neutral-100 p-2 dark:border-neutral-800">
        <SearchIcon className="pointer-events-none absolute left-[18px] top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-300 dark:text-neutral-600" />
        <input
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search memory..."
          className="w-full rounded-md border border-neutral-200 bg-neutral-50 py-1.5 pl-8 pr-7 text-xs text-neutral-900 placeholder:text-neutral-400 focus:border-accent focus:bg-white focus:outline-none focus:ring-1 focus:ring-accent/50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-600 dark:focus:bg-surface-0"
        />
        {search && (
          <button
            onClick={() => onSearchChange('')}
            className="absolute right-4 top-1/2 -translate-y-1/2 rounded p-0.5 text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300"
            aria-label="Clear search"
          >
            <XIcon className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* List */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isSearching ? (
          <SearchResultList
            results={searchQuery.data ?? []}
            isLoading={searchQuery.isLoading}
            query={debouncedSearch}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        ) : (
          <div className="divide-y divide-neutral-100 py-0.5 dark:divide-neutral-800/60">
            {tree.map((node) => (
              <DirSection
                key={node.path}
                node={node}
                depth={0}
                isTopLevel
                expandedDirs={expandedDirs ?? new Set()}
                onToggleDir={toggleDir}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Tree rendering ─────────────────────────────────────────────────────────

function DirSection({
  node,
  depth,
  isTopLevel,
  expandedDirs,
  onToggleDir,
  selectedPath,
  onSelect,
}: {
  node: MemoryTreeNode;
  depth: number;
  isTopLevel: boolean;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const expanded = expandedDirs.has(node.path);
  const colors = getDirColor(node.path.split('/')[0]);
  const paddingLeft = INDENT_BASE + depth * INDENT_PER_LEVEL;

  return (
    <div>
      <button
        onClick={() => onToggleDir(node.path)}
        style={{ paddingLeft }}
        className={cn(
          'group flex w-full items-center gap-2 py-1.5 pr-3 text-left transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-800/40',
          isTopLevel && expanded && colors.bg,
        )}
      >
        <ChevronIcon
          className={cn(
            'h-2.5 w-2.5 shrink-0 text-neutral-400 transition-transform duration-150 dark:text-neutral-500',
            expanded && 'rotate-90',
          )}
        />
        {isTopLevel ? (
          <span className={cn('h-2 w-2 shrink-0 rounded-full', colors.dot)} />
        ) : (
          <FolderIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400 dark:text-neutral-500" />
        )}
        <span
          className={cn(
            'min-w-0 truncate text-xs',
            isTopLevel ? cn('font-semibold', colors.text) : 'font-mono font-medium text-neutral-600 dark:text-neutral-400',
          )}
        >
          {node.name}
        </span>
        <span className="ml-auto shrink-0 text-2xs tabular-nums text-neutral-300 dark:text-neutral-600">
          {node.totalFiles}
        </span>
      </button>

      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="overflow-hidden">
          {node.children.map((child) => (
            <DirSection
              key={child.path}
              node={child}
              depth={depth + 1}
              isTopLevel={false}
              expandedDirs={expandedDirs}
              onToggleDir={onToggleDir}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
          {node.files.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              depth={depth + 1}
              selected={selectedPath === file.path}
              onSelect={() => onSelect(file.path)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function FileRow({
  file,
  depth,
  selected,
  onSelect,
}: {
  file: MemoryFileListing;
  depth: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const paddingLeft = INDENT_BASE + depth * INDENT_PER_LEVEL;
  const expired = isExpired(file.expires);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      style={{ paddingLeft }}
      className={cn(
        'group flex w-full items-center gap-2 py-1.5 pr-3 text-left transition-colors',
        selected
          ? 'bg-accent/8 dark:bg-accent/15'
          : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/40',
      )}
      title={file.description || file.path}
    >
      <span className="inline-block w-2.5 shrink-0" />
      <FileIcon
        className={cn(
          'h-3.5 w-3.5 shrink-0',
          selected ? 'text-accent' : 'text-neutral-300 dark:text-neutral-600',
        )}
      />
      <span
        className={cn(
          'min-w-0 truncate font-mono text-xs',
          selected
            ? 'font-medium text-neutral-900 dark:text-neutral-100'
            : 'text-neutral-700 dark:text-neutral-300',
          expired && 'line-through decoration-red-400/60',
        )}
      >
        {fileName(file.path)}
      </span>
      {file.pinned && <PinIcon className="h-3 w-3 shrink-0 text-violet-500 dark:text-violet-400" />}
      <span className="ml-auto shrink-0 text-2xs tabular-nums text-neutral-300 dark:text-neutral-600">
        {formatRelativeTime(file.updatedAt)}
      </span>
    </button>
  );
}

// ─── Search results ─────────────────────────────────────────────────────────

function SearchResultList({
  results,
  isLoading,
  query,
  selectedPath,
  onSelect,
}: {
  results: Array<{ path: string; snippet: string; type: string; expired: boolean }>;
  isLoading: boolean;
  query: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  if (isLoading) {
    return (
      <div className="space-y-2 px-3 py-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="space-y-1">
            <div className="h-3 w-40 animate-pulse rounded bg-neutral-200 dark:bg-neutral-700" />
            <div className="h-3 w-3/4 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
          </div>
        ))}
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="px-4 py-8 text-center">
        <SearchIcon className="mx-auto h-5 w-5 text-neutral-200 dark:text-neutral-700" />
        <p className="mt-2 text-xs text-neutral-400 dark:text-neutral-600">
          No results for &ldquo;{query}&rdquo;
        </p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-neutral-50 dark:divide-neutral-800/50">
      {results.map((result) => {
        const dir = result.path.split('/')[0] || '_root';
        const colors = getDirColor(dir);
        const selected = selectedPath === result.path;

        return (
          <button
            key={result.path}
            type="button"
            onClick={() => onSelect(result.path)}
            aria-current={selected ? 'true' : undefined}
            className={cn(
              'block w-full px-3 py-2 text-left transition-colors',
              selected ? 'bg-accent/8 dark:bg-accent/15' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/40',
            )}
          >
            <div className="flex items-center gap-2">
              <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', colors.dot)} />
              <span className="min-w-0 truncate font-mono text-xs text-neutral-700 dark:text-neutral-300">
                {result.path}
              </span>
              {result.expired && (
                <span className="shrink-0 rounded-full bg-red-500/10 px-1.5 py-0.5 text-2xs font-medium text-red-600 dark:text-red-400">
                  expired
                </span>
              )}
            </div>
            {result.snippet && (
              <p className="ml-3.5 mt-0.5 line-clamp-2 text-2xs leading-relaxed text-neutral-400 dark:text-neutral-500">
                {result.snippet}
              </p>
            )}
          </button>
        );
      })}
    </div>
  );
}
