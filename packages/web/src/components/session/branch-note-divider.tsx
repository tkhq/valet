import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, GitBranch } from "lucide-react";
import type { MessageBranchNote } from "@valet/api/wire";
import type { StreamMessage } from "~/stores/stream";
import { Button, Dialog, DialogContent, DialogTrigger, ScrollArea, Time, LoadingRow, ErrorRow, EmptyRow, textLinkClass } from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { useBranchPreview } from "~/api/branch-preview";
import { MessageItem } from "./message-item";
import { FileChangeChoice } from "./file-change-choice";

/**
 * Divider row for branch notes (wire messages with `branch`): where an edit,
 * a return to an earlier version, or a fork changed this thread's history
 * (docs/specs/2026-10-22-thread-edit-fork-design.md). Consecutive notes, as
 * repeated edits of one message leave, share one row. It expands to what
 * still stands from the selected version in a separate history panel.
 */
export function BranchNoteDivider({
  notes,
  onReturn,
  onOpenThread,
}: {
  /** One fork note, or a run of edit and return notes, in thread order. */
  notes: StreamMessage[];
  /** Goes back to the version a note left. Omitted where the viewer cannot. */
  onReturn?: (noteEntryId: string, opts: { restoreFiles: boolean }) => Promise<void>;
  /** Opens another thread of this workspace, for a fork note's source. */
  onOpenThread?: (threadId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [visibleCount, setVisibleCount] = useState(20);
  const branches = notes.flatMap((note) => (note.branch ? [{ id: note.id, branch: note.branch, createdAt: note.createdAt, threadId: note.threadId }] : []));
  const first = branches[0];
  const threadId = first?.threadId;
  useEffect(() => {
    setSelectedId(undefined);
    setVisibleCount(20);
  }, [threadId]);
  function changeOpen(next: boolean) {
    setOpen(next);
    if (!next) {
      setSelectedId(undefined);
      setVisibleCount(20);
    }
  }
  if (!first) return null;
  const calls = branches.reduce((total, { branch }) => total + callCount(branch), 0);
  const fork = branches.length === 1 && first.branch.kind === "fork" ? first.branch : undefined;
  const label = fork ? "Branched from another thread"
    : branches.length > 1
      ? `${branches.length} earlier versions kept${calls > 0 ? ` · ${calls} ${calls === 1 ? "action still stands" : "actions still stand"}` : ""}`
      : singleLabel(first.branch, calls);

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <div className="px-4 py-2" data-testid="branch-note">
        <DialogTrigger asChild>
          <button
            type="button"
            aria-expanded={open}
            className="group flex w-full items-center gap-2 rounded text-[11px] text-muted hover:text-[--fg] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss/40 max-sm:min-h-11"
          >
            <span className="h-px flex-1 bg-[--border]" aria-hidden />
            <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">{label}</span>
            {open ? <ChevronDown className="h-3 w-3 shrink-0" aria-hidden /> : <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />}
            <span className="h-px flex-1 bg-[--border]" aria-hidden />
          </button>
        </DialogTrigger>
      </div>
      <DialogContent
        title={fork ? "Branch source" : "Version history"}
        description={fork ? "Where this thread started." : "Select View to inspect an earlier version before restoring it."}
        className="left-auto right-0 top-0 flex h-dvh max-h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-3 overflow-hidden rounded-none p-4 text-xs sm:w-[min(44rem,85vw)]"
      >
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
          {fork ? (
            <div className="min-h-0 overflow-y-auto"><ForkDetails branch={fork} onOpenThread={onOpenThread} /></div>
          ) : (
            <>
              <ScrollArea className="max-h-[25dvh] shrink-0 rounded border border-[--border]" style={{ height: Math.min(branches.length * 64, 192) }} aria-label="Earlier versions">
                <ul className="divide-y divide-[--border]">
                  {branches.slice(-visibleCount).reverse().map(({ id, branch, createdAt }, index) => (
                    <li key={id} className="flex items-center gap-3 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate" title={branch.version?.excerpt}>
                          {branch.version?.excerpt || (index === 0 ? "Latest version left" : "Earlier version left")}
                        </p>
                        <Time ts={branch.version?.createdAt ?? createdAt} format="absolute" className="text-muted" />
                      </div>
                      <Button variant="ghost" size="sm" aria-pressed={selectedId === id} onClick={() => setSelectedId(id)}>View</Button>
                    </li>
                  ))}
                </ul>
                {visibleCount < branches.length && <Button variant="ghost" size="sm" className="m-2" onClick={() => setVisibleCount((count) => count + 20)}>Show older versions</Button>}
              </ScrollArea>
              <div key={selectedId} className="min-h-0 flex-1 overflow-y-auto">
                {branches.filter(({ id }) => id === selectedId).map(({ id, branch, threadId }) => (
                  <div key={id} className="min-w-0">
                    <BranchPreview threadId={threadId ?? undefined} noteEntryId={id} />
                    <VersionDetails noteEntryId={id} branch={branch} onReturn={onReturn ? async (noteEntryId, opts) => {
                      await onReturn(noteEntryId, opts);
                      changeOpen(false);
                    } : undefined} />
                  </div>
                ))}
                {!selectedId && <EmptyRow>Select a version to view its messages and file changes.</EmptyRow>}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function BranchPreview({ threadId, noteEntryId }: { threadId: string | undefined; noteEntryId: string }) {
  const preview = useBranchPreview(threadId, noteEntryId);
  const messages = preview.data?.pages.slice().reverse().flatMap((page) => page.messages) ?? [];
  return (
    <section aria-label="Selected version transcript" className="min-w-0 py-2">
      {preview.isPending ? <LoadingRow label="Loading version…" />
        : !preview.data && preview.isError ? <ErrorRow>{errorText(preview.error, "Could not load this version. Try again.")} <Button variant="ghost" size="sm" onClick={() => void preview.refetch()}>Try again</Button></ErrorRow>
        : <>
            {preview.hasNextPage && <Button variant="secondary" size="sm" disabled={preview.isFetchingNextPage} onClick={() => void preview.fetchNextPage()}>
              {preview.isFetchingNextPage ? "Loading older messages…" : "Load older messages"}
            </Button>}
            {preview.isFetchNextPageError && <ErrorRow>{errorText(preview.error, "Could not load older messages. Try again.")}</ErrorRow>}
            {messages.length === 0 ? <EmptyRow>No messages in this version.</EmptyRow>
              : messages.map((message) => message.branch ? (
                  <p key={message.id} className="flex items-center gap-2 border-y border-[--border] px-3 py-2 text-xs text-muted">
                    <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
                    {message.branch.kind === "edit" ? "Earlier edit"
                      : message.branch.kind === "return" ? "Returned to an earlier version"
                        : "Branched from another thread"}
                  </p>
                ) : <MessageItem key={message.id} message={message} readOnly />)}
          </>}
    </section>
  );
}

function callCount(branch: MessageBranchNote): number {
  return branch.actions.reduce((total, action) => total + action.count, 0) + branch.moreActions;
}

function singleLabel(branch: MessageBranchNote, calls: number): string {
  if (branch.kind === "return") return "Went back to an earlier version";
  if (calls === 0) return "Edited · earlier version kept";
  return calls === 1
    ? "Edited · 1 action from the earlier version still stands"
    : `Edited · ${calls} actions from the earlier version still stand`;
}

function ForkDetails({ branch, onOpenThread }: { branch: MessageBranchNote; onOpenThread?: (threadId: string) => void }) {
  const source = branch.source;
  const seed = branch.seed;
  return (
    <div className="space-y-2 px-3 py-2">
      <p>The messages above are a copy. Everything in them already ran, and the original thread continues on its own.</p>
      <p className="text-muted">
        {source?.sameWorkingDirectory
          ? "This thread shares its working directory with the original thread, including changes made there later."
          : seed?.pending
            ? `This thread has its own working directory. Files from the branch point come to ${seed.repos.join(", ")} when its first turn starts.`
            : seed && seed.repos.length > 0
              ? `This thread has its own working directory. Files from the branch point came along to ${seed.repos.join(", ")}.`
              : `This thread has its own working directory, so files from the original thread are not here${seed?.skipped ? ` (${seed.skipped})` : ""}.`}
      </p>
      {seed && seed.failed.length > 0 && (
        <p className="text-danger-500">Files for {seed.failed.join(", ")} could not come along.</p>
      )}
      {source && onOpenThread && (
        <button type="button" className={textLinkClass} onClick={() => onOpenThread(source.threadId)}>
          Open the original thread
        </button>
      )}
    </div>
  );
}

function VersionDetails({ noteEntryId, branch, onReturn }: {
  noteEntryId: string;
  branch: MessageBranchNote;
  onReturn?: (noteEntryId: string, opts: { restoreFiles: boolean }) => Promise<void>;
}) {
  const [returning, setReturning] = useState(false);
  const [error, setError] = useState<string>();
  const [bringBack, setBringBack] = useState(true);
  const version = branch.kind === "edit" ? "earlier version" : "version you left";
  const files = branch.files;
  async function goBack() {
    if (!onReturn) return;
    setError(undefined);
    setReturning(true);
    try {
      await onReturn(noteEntryId, { restoreFiles: Boolean(files?.canBringBack) && bringBack });
    } catch (err) {
      setError(errorText(err, "Could not restore this version. Try again."));
    } finally {
      setReturning(false);
    }
  }
  return (
    <div className="space-y-2 px-3 py-2">
      {callCount(branch) === 0 ? (
        <p>Nothing in the {version} ran outside the chat.</p>
      ) : (
        <>
          <p>Nothing outside {files ? "the working directory" : "the chat"} was undone. These actions from the {version} still stand:</p>
          <ul className="list-disc space-y-0.5 pl-4">
            {branch.actions.map((action, index) => (
              <li key={`${action.label}-${index}`} className="[overflow-wrap:anywhere]">
                {action.label}
                {action.count > 1 && <span className="text-muted"> · {action.count} calls</span>}
                {action.urls.map((url) => (
                  <a key={url} href={url} target="_blank" rel="noreferrer" className={`${textLinkClass} ml-1`}>{url}</a>
                ))}
              </li>
            ))}
            {branch.moreActions > 0 && <li className="text-muted">{branch.moreActions} more calls</li>}
          </ul>
        </>
      )}
      {branch.grants.length > 0 && (
        <p className="[overflow-wrap:anywhere]">Approval choices from that version still apply: {branch.grants.join("; ")}.</p>
      )}
      {files ? (
        <>
          {files.changed.length > 0 && (
            <p className="text-muted [overflow-wrap:anywhere]">
              {branch.kind === "edit" ? "Undid file changes" : "Restored these files to that version"}: {files.changed.join(", ")}.
            </p>
          )}
          {files.skipped.length > 0 && (
            <p className="text-muted [overflow-wrap:anywhere]">Left as they are, because they changed later: {files.skipped.join(", ")}.</p>
          )}
          {files.failed.length > 0 && (
            <p className="text-danger-500">The file change failed in {files.failed.join(", ")}, so those files are as that version left them.</p>
          )}
        </>
      ) : branch.filesChanged && <p className="text-muted">The working directory keeps any file changes from that version.</p>}
      {branch.canReturn && onReturn && files?.canBringBack && (
        <FileChangeChoice
          label={`Also bring back the file changes (${files.changed.length} ${files.changed.length === 1 ? "file" : "files"})`}
          files={files.changed}
          checked={bringBack}
          onCheckedChange={setBringBack}
        />
      )}
      {branch.canReturn && onReturn && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button variant="secondary" size="sm" disabled={returning} onClick={() => void goBack()}>
            Restore this version
          </Button>
          {error && <span role="alert" className="text-danger-500">{error}</span>}
        </div>
      )}
    </div>
  );
}
