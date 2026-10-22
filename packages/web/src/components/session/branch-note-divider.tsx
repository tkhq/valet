import { useState } from "react";
import { ChevronDown, ChevronRight, GitBranch } from "lucide-react";
import type { MessageBranchNote } from "@valet/api/wire";
import type { StreamMessage } from "~/stores/stream";
import { Button, textLinkClass } from "~/components/primitives";
import { errorText } from "~/lib/error-text";

/**
 * Divider row for branch notes (wire messages with `branch`): where an edit,
 * a return to an earlier version, or a fork changed this thread's history
 * (docs/specs/2026-10-22-thread-edit-fork-design.md). Consecutive notes, as
 * repeated edits of one message leave, share one row. It expands to what
 * still stands from each version the thread left, and offers the way back.
 */
export function BranchNoteDivider({
  notes,
  onReturn,
  onOpenThread,
}: {
  /** One fork note, or a run of edit and return notes, in thread order. */
  notes: StreamMessage[];
  /** Goes back to the version a note left. Omitted where the viewer cannot. */
  onReturn?: (noteEntryId: string) => Promise<void>;
  /** Opens another thread of this workspace, for a fork note's source. */
  onOpenThread?: (threadId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const branches = notes.flatMap((note) => (note.branch ? [{ id: note.id, branch: note.branch }] : []));
  const first = branches[0];
  if (!first) return null;
  const calls = branches.reduce((total, { branch }) => total + callCount(branch), 0);
  const fork = branches.length === 1 && first.branch.kind === "fork" ? first.branch : undefined;
  const label = fork ? "Branched from another thread"
    : branches.length > 1
      ? `${branches.length} earlier versions kept${calls > 0 ? ` · ${calls} ${calls === 1 ? "action still stands" : "actions still stand"}` : ""}`
      : singleLabel(first.branch, calls);

  return (
    <div className="px-4 py-2" data-testid="branch-note">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group flex w-full items-center gap-2 rounded text-[11px] text-muted hover:text-[--fg] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss/40 max-sm:min-h-11"
      >
        <span className="h-px flex-1 bg-[--border]" aria-hidden />
        <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{label}</span>
        {open ? <ChevronDown className="h-3 w-3 shrink-0" aria-hidden /> : <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />}
        <span className="h-px flex-1 bg-[--border]" aria-hidden />
      </button>
      {open && (
        <div className="mx-auto mt-2 max-w-3xl divide-y divide-[--border] rounded-md border border-[--border] bg-[--bg-secondary] text-xs">
          {fork ? (
            <ForkDetails branch={fork} onOpenThread={onOpenThread} />
          ) : (
            // Newest first: the version the person most likely wants back.
            [...branches].reverse().map(({ id, branch }, index) => (
              <VersionDetails
                key={id}
                noteEntryId={id}
                branch={branch}
                heading={branches.length > 1 ? (index === 0 ? "Latest version left" : "Earlier version left") : undefined}
                onReturn={onReturn}
              />
            ))
          )}
        </div>
      )}
    </div>
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
  return (
    <div className="space-y-2 px-3 py-2">
      <p>The messages above are a copy. Everything in them already ran, and the original thread continues on its own.</p>
      <p className="text-muted">
        {source?.sameWorkingDirectory
          ? "This thread shares its working directory with the original thread."
          : "This thread has its own working directory, so files from the original thread are not here."}
      </p>
      {source && onOpenThread && (
        <button type="button" className={textLinkClass} onClick={() => onOpenThread(source.threadId)}>
          Open the original thread
        </button>
      )}
    </div>
  );
}

function VersionDetails({ noteEntryId, branch, heading, onReturn }: {
  noteEntryId: string;
  branch: MessageBranchNote;
  heading?: string;
  onReturn?: (noteEntryId: string) => Promise<void>;
}) {
  const [returning, setReturning] = useState(false);
  const [error, setError] = useState<string>();
  const version = branch.kind === "edit" ? "earlier version" : "version you left";
  async function goBack() {
    if (!onReturn) return;
    setError(undefined);
    setReturning(true);
    try {
      await onReturn(noteEntryId);
    } catch (err) {
      setError(errorText(err, "Could not go back. Try again."));
    } finally {
      setReturning(false);
    }
  }
  return (
    <div className="space-y-2 px-3 py-2">
      {heading && <p className="font-medium text-ink">{heading}</p>}
      {callCount(branch) === 0 ? (
        <p>Nothing in the {version} ran outside the chat.</p>
      ) : (
        <>
          <p>Nothing outside the chat was undone. These actions from the {version} still stand:</p>
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
      {branch.filesChanged && <p className="text-muted">The working directory keeps any file changes from that version.</p>}
      {branch.canReturn && onReturn && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button variant="secondary" size="sm" disabled={returning} onClick={() => void goBack()}>
            Go back to this version
          </Button>
          {error && <span role="alert" className="text-danger-500">{error}</span>}
        </div>
      )}
    </div>
  );
}
