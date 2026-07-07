import * as React from 'react';
import { cn } from '@/lib/cn';
import { useMemoryFiles } from '@/api/orchestrator';
import {
  formatSize,
} from '@/components/orchestrator/memory-explorer-utils';
import { MemoryGraphFlowView } from './memory-graph-flow';
import { PageContainer } from '@/components/layout/page-container';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MemoryFileList } from './memory-file-list';
import { MemoryDetail, MemoryDetailEmpty } from './memory-detail';
import { MemoryImportExportActions } from './memory-import-export';
import { FolderIcon, PinIcon } from './icons';

// Shared card chrome for the split-view panels. Heights come from the page
// filling the app shell's <main> (see PageContainer className below) rather
// than dvh math, so nothing overshoots the viewport.
const PANEL_CLASS =
  'overflow-hidden rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-surface-1';

/**
 * Full-page memory workspace: Files mode is a split view (tree + search on
 * the left, rendered markdown / editor on the right); Graph mode fills the
 * canvas and opens the same detail pane inline when a node is clicked.
 */
export function MemoryPage({
  selectedPath,
  onSelectPath,
}: {
  selectedPath: string | null;
  onSelectPath: (path: string | null) => void;
}) {
  const { data: files, isLoading } = useMemoryFiles('');
  const [view, setView] = React.useState<'files' | 'graph'>('files');
  const [search, setSearch] = React.useState('');
  const [pinnedOnly, setPinnedOnly] = React.useState(false);

  const allFiles = React.useMemo(() => files ?? [], [files]);
  const visibleFiles = React.useMemo(
    () => (pinnedOnly ? allFiles.filter((f) => f.pinned) : allFiles),
    [allFiles, pinnedOnly],
  );
  const totalSize = React.useMemo(() => allFiles.reduce((s, f) => s + f.size, 0), [allFiles]);
  const pinnedCount = React.useMemo(() => allFiles.filter((f) => f.pinned).length, [allFiles]);
  const isEmpty = !isLoading && allFiles.length === 0;

  // Selecting from anywhere (tree, search, graph, backlinks) lands here.
  const handleSelect = (path: string) => {
    setPinnedOnly(false);
    onSelectPath(path);
  };

  const handleTagClick = (tag: string) => {
    setView('files');
    setSearch(tag);
  };

  return (
    <PageContainer className="flex flex-col lg:h-full">
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">Memory</h1>
          <Tabs value={view} onValueChange={(v) => setView(v === 'graph' ? 'graph' : 'files')}>
            <TabsList className="bg-neutral-100/80 p-0.5 dark:bg-neutral-800/60">
              <TabsTrigger value="files" className="px-2.5 py-1 text-xs">
                Files
              </TabsTrigger>
              <TabsTrigger value="graph" className="px-2.5 py-1 text-xs">
                Graph
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {!isEmpty && (
            <div className="flex items-center gap-2 text-xs text-neutral-400 dark:text-neutral-500">
              <span className="font-mono tabular-nums">{allFiles.length} files</span>
              <span className="text-neutral-300 dark:text-neutral-700">/</span>
              <span className="font-mono tabular-nums">{formatSize(totalSize)}</span>
              {pinnedCount > 0 && (
                <>
                  <span className="text-neutral-300 dark:text-neutral-700">/</span>
                  <button
                    type="button"
                    onClick={() => setPinnedOnly((v) => !v)}
                    aria-pressed={pinnedOnly}
                    title={pinnedOnly ? 'Show all files' : 'Show pinned files only'}
                    className={cn(
                      'flex items-center gap-1 rounded-full px-1.5 py-0.5 transition-colors',
                      pinnedOnly
                        ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
                        : 'hover:bg-neutral-100 dark:hover:bg-neutral-800',
                    )}
                  >
                    <PinIcon className="h-2.5 w-2.5 text-violet-500 dark:text-violet-400" />
                    <span className="font-mono tabular-nums">{pinnedCount}</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <MemoryImportExportActions isEmpty={isEmpty} />
      </div>

      {/* Content */}
      {isEmpty ? (
        <EmptyState />
      ) : view === 'files' ? (
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(260px,340px)_minmax(0,1fr)]">
          <aside className={cn(PANEL_CLASS, 'max-h-[50dvh] min-h-0 lg:max-h-none')}>
            <MemoryFileList
              files={visibleFiles}
              selectedPath={selectedPath}
              onSelect={handleSelect}
              search={search}
              onSearchChange={setSearch}
            />
          </aside>
          <main className={cn(PANEL_CLASS, 'min-h-[24rem] lg:min-h-0')}>
            {selectedPath ? (
              <MemoryDetail
                path={selectedPath}
                onOpenFile={handleSelect}
                onTagClick={handleTagClick}
                onDeleted={() => onSelectPath(null)}
              />
            ) : (
              <MemoryDetailEmpty />
            )}
          </main>
        </div>
      ) : (
        <div
          className={cn(
            'grid min-h-0 flex-1 gap-4',
            selectedPath ? 'lg:grid-cols-[minmax(0,1fr)_420px]' : 'lg:grid-cols-1',
          )}
        >
          <main className={cn(PANEL_CLASS, 'min-h-0')}>
            <MemoryGraphFlowView
              onOpenFile={handleSelect}
              selectedPath={selectedPath}
              heightClassName="h-full min-h-[24rem]"
            />
          </main>
          {selectedPath && (
            <aside className={cn(PANEL_CLASS, 'min-h-[24rem] lg:min-h-0')}>
              <MemoryDetail
                path={selectedPath}
                onOpenFile={handleSelect}
                onTagClick={handleTagClick}
                onDeleted={() => onSelectPath(null)}
                onClose={() => onSelectPath(null)}
              />
            </aside>
          )}
        </div>
      )}
    </PageContainer>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-neutral-200 px-6 py-16 dark:border-neutral-800">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800">
        <FolderIcon className="h-5 w-5 text-neutral-400 dark:text-neutral-500" />
      </div>
      <p className="mt-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">
        No memory files
      </p>
      <p className="mt-1 max-w-xs text-center text-xs text-neutral-400 dark:text-neutral-600">
        Your orchestrator will create memory files as it learns your preferences, tracks projects,
        and stores context.
      </p>
    </div>
  );
}
