import * as React from 'react';
import {
  useDeleteTeamMemoryFile,
  useTeamMemoryFile,
  useTeamMemoryFiles,
  useWriteTeamMemoryFile,
} from '@/api/teams';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toastError, toastSuccess } from '@/hooks/use-toast';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';

export function TeamMemory({ teamId, canManage }: { teamId: string; canManage: boolean }) {
  const { data: files, isLoading } = useTeamMemoryFiles(teamId);
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);

  if (isLoading) return <Skeleton className="h-64 w-full rounded-md" />;

  if ((!files || files.length === 0) && !creating) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-neutral-300 p-10 text-center dark:border-neutral-700">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          No team memory yet. The team orchestrator writes here as it learns; every member's personal
          orchestrator can read it.
        </p>
        {canManage ? (
          <Button type="button" onClick={() => setCreating(true)}>
            New file
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
      <div className="space-y-2">
        {canManage ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => { setCreating(true); setSelectedPath(null); }}>
            New file
          </Button>
        ) : null}
        <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {(files ?? []).map((f) => (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => { setSelectedPath(f.path); setCreating(false); }}
                className={cn(
                  'block w-full px-3 py-2 text-left text-xs hover:bg-neutral-50 dark:hover:bg-neutral-900',
                  selectedPath === f.path && 'bg-neutral-100 font-medium dark:bg-neutral-800'
                )}
              >
                <div className="truncate">{f.path}</div>
                <div className="text-[10px] text-neutral-400">{formatRelativeTime(f.updatedAt)}</div>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div>
        {creating ? (
          <FileEditor teamId={teamId} onDone={(path) => { setCreating(false); setSelectedPath(path); }} />
        ) : selectedPath ? (
          <FileViewer teamId={teamId} path={selectedPath} canManage={canManage} onDeleted={() => setSelectedPath(null)} />
        ) : (
          <div className="rounded-md border border-dashed border-neutral-300 p-10 text-center text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
            Select a file to view it.
          </div>
        )}
      </div>
    </div>
  );
}

function FileViewer({
  teamId,
  path,
  canManage,
  onDeleted,
}: {
  teamId: string;
  path: string;
  canManage: boolean;
  onDeleted: () => void;
}) {
  const { data: file, isLoading } = useTeamMemoryFile(teamId, path);
  const [editing, setEditing] = React.useState(false);
  const deleteFile = useDeleteTeamMemoryFile();

  if (isLoading) return <Skeleton className="h-64 w-full rounded-md" />;
  if (!file) return <div className="text-xs text-neutral-500">File not found.</div>;

  if (editing) {
    return (
      <FileEditor
        teamId={teamId}
        initialPath={file.path}
        initialContent={file.content}
        onDone={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate font-mono text-xs text-neutral-500 dark:text-neutral-400">{file.path}</h3>
        {canManage ? (
          <div className="flex shrink-0 gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() =>
                deleteFile.mutate(
                  { teamId, path: file.path },
                  {
                    onSuccess: () => { toastSuccess('File deleted'); onDeleted(); },
                    onError: (err) => toastError(err instanceof Error ? err.message : 'Delete failed'),
                  }
                )
              }
            >
              Delete
            </Button>
          </div>
        ) : null}
      </div>
      <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md border border-neutral-200 p-4 text-xs dark:border-neutral-800">
        {file.content}
      </pre>
    </div>
  );
}

function FileEditor({
  teamId,
  initialPath,
  initialContent,
  onDone,
}: {
  teamId: string;
  initialPath?: string;
  initialContent?: string;
  onDone: (path: string) => void;
}) {
  const [path, setPath] = React.useState(initialPath ?? '');
  const [content, setContent] = React.useState(initialContent ?? '');
  const write = useWriteTeamMemoryFile();

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    write.mutate(
      { teamId, path: path.trim(), content },
      {
        onSuccess: (r) => { toastSuccess('Saved'); onDone(r.file.path); },
        onError: (err) => toastError(err instanceof Error ? err.message : 'Save failed'),
      }
    );
  };

  return (
    <form onSubmit={save} className="space-y-3">
      <Input
        value={path}
        onChange={(e) => setPath(e.target.value)}
        placeholder="runbooks/deploys.md"
        disabled={!!initialPath}
        className="font-mono text-xs"
      />
      <textarea
        className="h-64 w-full rounded-md border border-neutral-300 bg-transparent p-3 font-mono text-xs dark:border-neutral-700"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        autoFocus={!!initialPath}
      />
      <div className="flex gap-2">
        <Button type="submit" disabled={!path.trim() || write.isPending}>
          {write.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => onDone(initialPath ?? '')}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
