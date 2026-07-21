import * as React from 'react';
import { useExportMemory, useImportMemory } from '@/api/orchestrator';
import { toastSuccess, toastError, toastWarning } from '@/hooks/use-toast';
import { extractImportFiles } from '@/components/orchestrator/memory-explorer-utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DownloadIcon, UploadIcon } from './icons';

/** Import + Export header actions for the memory page (moved from the old inline explorer). */
export function MemoryImportExportActions({ isEmpty }: { isEmpty: boolean }) {
  const exportMemory = useExportMemory();
  const [exportMenuOpen, setExportMenuOpen] = React.useState(false);
  const [importDialogOpen, setImportDialogOpen] = React.useState(false);
  const exportMenuRef = React.useRef<HTMLDivElement>(null);

  // Close the export menu on outside click.
  React.useEffect(() => {
    if (!exportMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [exportMenuOpen]);

  const handleExport = async (include: 'all' | 'shareable') => {
    setExportMenuOpen(false);
    try {
      const manifest = await exportMemory.mutateAsync(include);
      const count = Object.keys(manifest.files).length;
      if (count === 0) {
        toastWarning('Nothing to export', 'No memory files yet.');
        return;
      }
      const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `valet-memory-${include}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toastSuccess('Memory exported', `${count} ${count === 1 ? 'file' : 'files'} downloaded.`);
    } catch {
      toastError('Export failed', 'Could not export memory files.');
    }
  };

  return (
    <div className="flex items-center gap-1">
      <ImportMemoryDialog open={importDialogOpen} onOpenChange={setImportDialogOpen} />
      <button
        type="button"
        onClick={() => setImportDialogOpen(true)}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        title="Import memory from a JSON bundle"
      >
        <UploadIcon className="h-3.5 w-3.5" />
        Import
      </button>
      <div className="relative" ref={exportMenuRef}>
        <button
          type="button"
          onClick={() => setExportMenuOpen((v) => !v)}
          disabled={isEmpty || exportMemory.isPending}
          aria-haspopup="menu"
          aria-expanded={exportMenuOpen}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          title={isEmpty ? 'No memory files to export' : 'Export memory as a JSON bundle'}
        >
          <DownloadIcon className="h-3.5 w-3.5" />
          {exportMemory.isPending ? 'Exporting…' : 'Export'}
        </button>
        {exportMenuOpen && (
          <div
            role="menu"
            className="absolute right-0 z-10 mt-1 w-48 overflow-hidden rounded-md border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => handleExport('all')}
              className="block w-full px-3 py-1.5 text-left text-xs text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              Export all
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => handleExport('shareable')}
              className="block w-full px-3 py-1.5 text-left text-xs text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              Export shareable only
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ImportMemoryDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const importMemory = useImportMemory();
  const [file, setFile] = React.useState<File | null>(null);
  // Default ON: the dialog's primary use case is restoring your own export,
  // where `trusted` preserves sensitivity/pinned/version state instead of
  // downgrading everything to private "foreign import" semantics.
  const [trusted, setTrusted] = React.useState(true);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const reset = () => {
    setFile(null);
    setTrusted(true);
    if (inputRef.current) inputRef.current.value = '';
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const handleImport = async () => {
    if (!file) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      toastError('Invalid file', 'Could not parse the selected JSON file.');
      return;
    }

    const toImport = extractImportFiles(parsed);
    if (toImport.length === 0) {
      toastError('Invalid file', 'No valid memory files found in the bundle.');
      return;
    }

    try {
      const result = await importMemory.mutateAsync({ files: toImport, trusted });
      const skippedNote = result.skipped.length > 0 ? `, ${result.skipped.length} skipped` : '';
      const prunedNote = result.pruned > 0 ? `, ${result.pruned} pruned by memory cap` : '';
      toastSuccess(
        'Memory imported',
        `${result.imported} ${result.imported === 1 ? 'file' : 'files'} imported${skippedNote}${prunedNote}.`,
      );
      handleOpenChange(false);
    } catch {
      toastError('Import failed', 'Could not import the memory bundle.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Import memory</DialogTitle>
          <DialogDescription>
            Restore or merge a memory export bundle (JSON) into your orchestrator&rsquo;s memory.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 space-y-4">
          <div>
            <input
              ref={inputRef}
              type="file"
              accept="application/json,.json"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-xs text-neutral-600 file:mr-3 file:rounded-md file:border-0 file:bg-neutral-100 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-neutral-700 hover:file:bg-neutral-200 dark:text-neutral-400 dark:file:bg-neutral-800 dark:file:text-neutral-300 dark:hover:file:bg-neutral-700"
            />
            {file && (
              <p className="mt-1.5 text-2xs text-neutral-400 dark:text-neutral-500">{file.name}</p>
            )}
          </div>

          <label className="flex items-start gap-2 text-xs text-neutral-700 dark:text-neutral-300">
            <Checkbox
              checked={trusted}
              onChange={(e) => setTrusted(e.target.checked)}
              className="mt-0.5 shrink-0"
            />
            <span>
              <span className="font-medium">Trusted (same-instance) import</span>
              <br />
              <span className="text-neutral-400 dark:text-neutral-500">
                Importing your own Valet export? Keep this checked. Importing from another source? Uncheck it.
              </span>
            </span>
          </label>
        </div>

        <DialogFooter className="mt-5">
          <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={handleImport} disabled={!file || importMemory.isPending}>
            {importMemory.isPending ? 'Importing…' : 'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
