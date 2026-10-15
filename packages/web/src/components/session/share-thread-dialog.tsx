import type { ThreadShareMode } from "@valet/api/wire";
import { Check, Link2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useShareThread } from "~/api/queries";
import { Button, Dialog, DialogContent, DialogFooter, FilterChips } from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { useCopyToClipboard } from "~/lib/use-copy";

type ShareChoice = ThreadShareMode | "off";

const OPTIONS: ReadonlyArray<{ value: ShareChoice; label: string }> = [
  { value: "off", label: "Off" },
  { value: "view", label: "View" },
  { value: "reply", label: "View + reply" },
];

const HINT: Record<ShareChoice, string> = {
  off: "Only you can open this thread.",
  view: "Members of your organization who have the link can watch this thread. They cannot send messages or answer approvals.",
  reply: "Members of your organization who have the link can watch this thread and send messages. People who reply can use your connected accounts and tools, with your permission settings. Approvals still come to you.",
};

/** The link a guest opens. `/threads/$threadId` shows a shared thread to a
 * guest and the full thread to its owner. */
export function sharedThreadUrl(threadId: string): string {
  return `${window.location.origin}/threads/${encodeURIComponent(threadId)}`;
}

/**
 * Share a personal thread with the organization (`PATCH /threads/:id` with
 * `share`). A choice saves at once, so "Off" stops sharing on the next
 * request any guest makes.
 */
export function ShareThreadDialog({ sessionId, threadId, share, open, onOpenChange }: {
  sessionId: string;
  threadId: string;
  /** The thread's saved share, from the thread list. */
  share: ThreadShareMode | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const save = useShareThread(sessionId);
  const { copied, copy } = useCopyToClipboard();
  // The saved share seeds the choice and wins when it changes. A failed save
  // puts the saved share back.
  const [current, setCurrent] = useState<ShareChoice>(share ?? "off");
  useEffect(() => setCurrent(share ?? "off"), [share]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Share thread" description="The thread stays in your workspace and runs as you.">
        <FilterChips label="Who can open this thread" options={OPTIONS} value={current}
          onChange={(next) => {
            if (next === current) return;
            setCurrent(next);
            save.mutate({ threadId, share: next }, { onError: () => setCurrent(share ?? "off") });
          }} />
        <p className="text-sm text-muted" role="status">{HINT[current]}</p>
        {save.error != null && <p role="alert" className="text-xs text-danger-500">{errorText(save.error)}</p>}
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={current === "off"} onClick={() => void copy(sharedThreadUrl(threadId))}>
            {copied ? <Check className="h-4 w-4" aria-hidden /> : <Link2 className="h-4 w-4" aria-hidden />}
            {copied ? "Link copied" : "Copy link"}
          </Button>
          <Button type="button" onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
