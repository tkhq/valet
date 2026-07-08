import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/cn';
import { formatRelativeTime } from '@/lib/format';
import { useMemoryFile, useWriteMemoryFile, useDeleteMemoryFile } from '@/api/orchestrator';
import { toastSuccess, toastError } from '@/hooks/use-toast';
import {
  displayTags,
  formatSize,
  getDirColor,
  isExpired,
  resolveMemoryLinkTarget,
  resourceHostname,
} from '@/components/orchestrator/memory-explorer-utils';
import { MarkdownContent } from '@/components/chat/markdown';
import { MarkdownEditor } from '@/components/content/markdown-editor';
import { Button } from '@/components/ui/button';
import { BrokenLinkIcon, EditIcon, FileIcon, LinkIcon, PinIcon, TrashIcon, XIcon } from './icons';

/**
 * Right-hand detail pane of the memory page: rendered markdown viewer with an
 * edit toggle (side-by-side markdown editor + preview, saved via the memory
 * write API), metadata badges, and clickable backlinks.
 */
export function MemoryDetail({
  path,
  onOpenFile,
  onTagClick,
  onDeleted,
  onClose,
}: {
  path: string;
  onOpenFile: (path: string) => void;
  onTagClick: (tag: string) => void;
  onDeleted: () => void;
  onClose?: () => void;
}) {
  const { data, isLoading, isError } = useMemoryFile(path);
  const writeFile = useWriteMemoryFile();
  const deleteFile = useDeleteMemoryFile();

  const file = data?.file ?? null;
  const backlinks = data?.backlinks ?? [];
  const notices = data?.notices ?? [];
  const sourceThread = data?.sourceThread ?? null;

  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');

  // Leaving edit mode when navigating to a different file.
  React.useEffect(() => {
    setEditing(false);
  }, [path]);

  const startEdit = () => {
    if (!file) return;
    setDraft(file.content);
    setEditing(true);
  };

  const saveEdit = async () => {
    try {
      await writeFile.mutateAsync({ path, content: draft });
      setEditing(false);
      toastSuccess('Memory saved', path);
    } catch {
      toastError('Save failed', 'Could not write the memory file.');
    }
  };

  const handleDelete = () => {
    if (!confirm(`Delete ${path}?`)) return;
    deleteFile.mutate(path, {
      onSuccess: () => {
        toastSuccess('Memory deleted', path);
        onDeleted();
      },
      onError: () => toastError('Delete failed', 'Could not delete the memory file.'),
    });
  };

  if (isLoading) {
    return (
      <div className="space-y-2 p-5">
        <div className="h-5 w-1/2 animate-pulse rounded bg-neutral-200 dark:bg-neutral-700" />
        <div className="h-3 w-1/3 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
        <div className="mt-4 space-y-1.5">
          <div className="h-3 w-full animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
          <div className="h-3 w-5/6 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
        </div>
      </div>
    );
  }

  if (isError || !file) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
        <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
          {isError ? 'Failed to load file' : 'File not found'}
        </p>
        <p className="font-mono text-xs text-neutral-400 dark:text-neutral-600">{path}</p>
      </div>
    );
  }

  const dirColors = getDirColor(path.split('/')[0]);
  const expired = isExpired(file.expires);
  const hostname = resourceHostname(file.resource);
  const { shown: tags, overflow: tagOverflow } = displayTags(file.tags, file.type, 8);
  const title = file.title || path.split('/').pop() || path;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="border-b border-neutral-100 px-5 pb-3 pt-4 dark:border-neutral-800">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={cn('h-2 w-2 shrink-0 rounded-full', dirColors.dot)} />
              <h2 className="min-w-0 truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                {title}
              </h2>
              {file.pinned && (
                <PinIcon className="h-3.5 w-3.5 shrink-0 text-violet-500 dark:text-violet-400" />
              )}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-2xs text-neutral-400 dark:text-neutral-500">
              <span className="truncate">{path}</span>
              <span>v{file.version}</span>
              <span>{formatSize(file.content.length)}</span>
              <span>updated {formatRelativeTime(file.updatedAt)}</span>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {editing && (
              <>
                <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button type="button" size="sm" onClick={saveEdit} disabled={writeFile.isPending}>
                  {writeFile.isPending ? 'Saving…' : 'Save'}
                </Button>
              </>
            )}
            {!editing && (
              <>
                <button
                  type="button"
                  onClick={startEdit}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                  title="Edit this memory file"
                >
                  <EditIcon className="h-3.5 w-3.5" />
                  Edit
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={deleteFile.isPending}
                  className="rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-500 disabled:opacity-50 dark:text-neutral-500 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                  title={`Delete ${path}`}
                  aria-label={`Delete ${path}`}
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                </button>
              </>
            )}
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
                aria-label="Close preview"
              >
                <XIcon className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Metadata badges */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {file.type && <Badge>{file.type}</Badge>}
          {file.sensitivity === 'shareable' && <Badge tone="shareable">shareable</Badge>}
          {file.origin && <Badge>{file.origin}</Badge>}
          {file.expires && (
            <Badge tone={expired ? 'expired' : 'default'}>
              {expired ? 'expired' : `expires ${formatRelativeTime(file.expires)}`}
            </Badge>
          )}
          {hostname && (
            <a
              href={file.resource}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 px-1.5 py-0.5 text-2xs text-sky-700 hover:bg-sky-500/20 dark:text-sky-400"
            >
              <LinkIcon className="h-2.5 w-2.5" />
              {hostname}
            </a>
          )}
          {tags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => onTagClick(tag)}
              title={`Search for “${tag}”`}
              className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-2xs text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-700 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
            >
              {tag}
            </button>
          ))}
          {tagOverflow > 0 && (
            <span className="text-2xs text-neutral-300 dark:text-neutral-600">+{tagOverflow}</span>
          )}
          {/* sourceSessionId is an OpenCode thread id, not a session URL —
              only link when the worker resolved it to a real session+thread. */}
          {sourceThread && (
            <Link
              to="/sessions/$sessionId/threads/$threadId"
              params={{ sessionId: sourceThread.sessionId, threadId: sourceThread.threadId }}
              className="text-2xs text-sky-600 hover:underline dark:text-sky-400"
            >
              learned in session
            </Link>
          )}
        </div>

        {file.description && (
          <p className="mt-1.5 text-xs italic text-neutral-400 dark:text-neutral-500">
            {file.description}
          </p>
        )}
      </div>

      {/* Notices */}
      {notices.length > 0 && (
        <div className="space-y-1 border-b border-amber-200/60 bg-amber-50 px-5 py-2 dark:border-amber-900/40 dark:bg-amber-950/20">
          {notices.map((notice, i) => (
            <p key={i} className="text-2xs text-amber-700 dark:text-amber-400">
              {notice}
            </p>
          ))}
        </div>
      )}

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {editing ? (
          <div className="p-4">
            <MarkdownEditor value={draft} onChange={setDraft} minHeightClassName="min-h-[20rem]" />
          </div>
        ) : (
          <>
            {/* Cross-memory links (relative / memory-root hrefs) open in this
                pane; without interception the browser would treat them as SPA
                routes and 404. External links keep their default behavior. */}
            <div
              className="px-5 py-4"
              onClickCapture={(e) => {
                const anchor = (e.target as HTMLElement).closest('a');
                if (!anchor) return;
                const href = anchor.getAttribute('href');
                if (!href) return;
                const target = resolveMemoryLinkTarget(path, href);
                if (!target) return;
                e.preventDefault();
                e.stopPropagation();
                onOpenFile(target);
              }}
            >
              {file.content.trim() ? (
                <MarkdownContent content={file.content} />
              ) : (
                <p className="text-sm italic text-neutral-400 dark:text-neutral-600">(empty)</p>
              )}
            </div>

            {/* Backlinks. queryLinks' first ring mixes true inbound links
                (relation 'in') with session siblings (relation 'session' —
                files that merely share a source_session_id); labeling siblings
                "Linked from" reads as phantom links, so split them. */}
            <BacklinkSections backlinks={backlinks} onOpenFile={onOpenFile} />
          </>
        )}
      </div>
    </div>
  );
}

function BacklinkSections({
  backlinks,
  onOpenFile,
}: {
  backlinks: Array<{ path: string; phantom: boolean; relation: 'out' | 'in' | 'session' }>;
  onOpenFile: (path: string) => void;
}) {
  // Collapsed by default: session co-authorship is a weak association (a big
  // reorganization session welds unrelated files together), so it's shown as
  // an expandable count rather than an ambient list.
  const [siblingsOpen, setSiblingsOpen] = React.useState(false);

  React.useEffect(() => {
    setSiblingsOpen(false);
  }, [backlinks]);

  const linkedFrom = backlinks.filter((l) => l.relation !== 'session');
  const siblings = backlinks.filter((l) => l.relation === 'session');
  if (linkedFrom.length === 0 && siblings.length === 0) return null;

  const renderRow = (link: { path: string; phantom: boolean }) => (
    <li key={link.path} className="flex items-center gap-1.5 text-xs">
      {link.phantom ? (
        <span
          className="flex items-center gap-1 text-red-500 dark:text-red-400"
          title="Broken link — target file does not exist"
        >
          <BrokenLinkIcon className="h-2.5 w-2.5" />
          {link.path}
        </span>
      ) : (
        <button
          type="button"
          onClick={() => onOpenFile(link.path)}
          title={`Open ${link.path}`}
          className="flex min-w-0 items-center gap-1.5 font-mono text-neutral-500 hover:text-sky-600 hover:underline dark:text-neutral-400 dark:hover:text-sky-400"
        >
          <FileIcon className="h-3 w-3 shrink-0 text-neutral-300 dark:text-neutral-600" />
          <span className="truncate">{link.path}</span>
        </button>
      )}
    </li>
  );

  return (
    <div className="space-y-3 border-t border-neutral-100 px-5 py-3 dark:border-neutral-800">
      {linkedFrom.length > 0 && (
        <div>
          <p className="mb-1.5 text-2xs font-medium uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
            Linked from
          </p>
          <ul className="space-y-1">{linkedFrom.map(renderRow)}</ul>
        </div>
      )}
      {siblings.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setSiblingsOpen((v) => !v)}
            aria-expanded={siblingsOpen}
            title="Files created or updated in the same conversation — a weak association, not inline links"
            className="flex items-center gap-1 text-2xs font-medium uppercase tracking-wider text-neutral-400 transition-colors hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300"
          >
            <span className={cn('inline-block transition-transform', siblingsOpen && 'rotate-90')}>›</span>
            Written in the same session ({siblings.length})
          </button>
          {siblingsOpen && <ul className="mt-1.5 space-y-1">{siblings.map(renderRow)}</ul>}
        </div>
      )}
    </div>
  );
}

/** Placeholder shown when no file is selected yet. */
export function MemoryDetailEmpty() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <FileIcon className="h-8 w-8 text-neutral-200 dark:text-neutral-700" />
      <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
        Select a memory file
      </p>
      <p className="max-w-xs text-xs text-neutral-400 dark:text-neutral-600">
        Pick a file from the list to read it, or switch to the graph to explore how memories link
        together.
      </p>
    </div>
  );
}

function Badge({
  children,
  tone = 'default',
}: {
  children: React.ReactNode;
  tone?: 'default' | 'shareable' | 'expired';
}) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-1.5 py-0.5 text-2xs font-medium',
        tone === 'shareable' && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
        tone === 'expired' && 'bg-red-500/10 text-red-600 dark:text-red-400',
        tone === 'default' && 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400',
      )}
    >
      {children}
    </span>
  );
}
