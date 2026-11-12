import { useState } from "react";
import { useRunCodeReview } from "~/api/code-review";
import { Button, Checkbox, Dialog, DialogContent, Input } from "~/components/primitives";
import { errorText } from "~/lib/error-text";

interface RunReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamId?: string;
}

/**
 * Review one pull request now, through the workspace's line for its
 * repository. Shadow mode records the review in the plugin thread only, and
 * a commit reviews a merged or closed pull request at that commit.
 */
export function RunReviewDialog({ open, onOpenChange, teamId }: RunReviewDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Review a pull request"
        description="Valet reviews it now with the settings of the repository's code review line."
        className="max-w-md gap-3"
      >
        {open && <RunReviewForm teamId={teamId} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function RunReviewForm({ teamId, onDone }: { teamId?: string; onDone: () => void }) {
  const run = useRunCodeReview();
  const [url, setUrl] = useState("");
  const [shadow, setShadow] = useState(false);
  const [commit, setCommit] = useState("");
  const submit = () => run.mutate(
    { url: url.trim(), ...(teamId !== undefined ? { teamId } : {}), ...(shadow ? { shadow: true } : {}), ...(shadow && commit.trim() ? { commit: commit.trim() } : {}) },
    { onSuccess: onDone },
  );

  return (
    <form className="grid min-w-0 gap-3" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <Input aria-label="Pull request URL" placeholder="https://github.com/owner/repo/pull/12" value={url} onChange={(event) => setUrl(event.target.value)} disabled={run.isPending} />
      <label className="flex items-start gap-2 text-sm">
        <Checkbox checked={shadow} onCheckedChange={setShadow} disabled={run.isPending} aria-label="Shadow mode" className="mt-0.5" />
        <span>
          Shadow mode
          <span className="block text-xs text-muted">Record the review in Valet only. Nothing is posted on GitHub.</span>
        </span>
      </label>
      {shadow && (
        <Input aria-label="Commit" placeholder="Commit sha (optional, for a merged or closed pull request)" value={commit} onChange={(event) => setCommit(event.target.value)} disabled={run.isPending} />
      )}
      {run.error && <p role="alert" className="text-sm text-danger-500">{errorText(run.error)}</p>}
      <div className="flex justify-end">
        <Button type="submit" disabled={run.isPending || url.trim() === ""}>{run.isPending ? "Starting…" : "Review"}</Button>
      </div>
    </form>
  );
}
