import { useCallback, useState, type ReactNode } from "react";
import type { BackgroundWorkConflict, BackgroundWorkItem } from "@valet/api/wire";
import { ApiError, backgroundWorkConflict } from "~/api/client";
import { Button, Dialog, DialogContent, DialogFooter } from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { itemDetail } from "./background-work-badge";

/** The words of one guarded action. */
export interface GuardedAction {
  /** Dialog title, such as "Stop background work and pause?". */
  title: string;
  /** Confirm button, such as "Stop background work and pause". */
  confirmLabel: string;
}

/** Pure: one line of detail under a refused action's work item. Work still starting reads "starting". */
export function workItemDetail(item: BackgroundWorkItem, now: number = Date.now()): string {
  return itemDetail(item, now);
}

/** The work rows a confirm shows. `stopped` marks every row as stopped. */
export function BackgroundWorkList({ items, stopped = false }: { items: BackgroundWorkItem[]; stopped?: boolean }) {
  return (
    <ul className="space-y-2" aria-label="Background work">
      {items.map((item) => (
        <li key={item.id} className="text-xs">
          <p className="break-words text-ink">{item.reason}</p>
          <p className="text-muted">{stopped ? "Stopped" : workItemDetail(item)}</p>
        </li>
      ))}
    </ul>
  );
}

/**
 * Pure: true when a forced retry stopped the work but did not finish the
 * action (409 "... The background work already stopped. ..."), because a
 * turn or new work started in between.
 */
export function workAlreadyStopped(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 409 || backgroundWorkConflict(err) !== null) return false;
  return errorText(err).includes("The background work already stopped.");
}

/** Pure: the dialog title and description for a refusal. */
export function confirmCopy(
  conflict: BackgroundWorkConflict,
  action: GuardedAction,
  stopped: boolean,
): { title: string; description: string } {
  if (stopped) return { title: "Background work stopped", description: "The work below stopped, but the action did not finish." };
  if (conflict.forceAllowed) {
    return { title: action.title, description: "This stops the background work below. The agent gets a message that you stopped it." };
  }
  if (conflict.hiddenCount > 0) {
    return {
      title: "Background work is running",
      description: "Some of this work runs on threads you cannot see. Ask the people in those threads to cancel it, then try again.",
    };
  }
  return {
    title: "Background work is running",
    description: "You cannot stop this work. Ask the agent in its thread to cancel it (wakeup_cancel), or ask a team admin.",
  };
}

interface Prompt {
  conflict: BackgroundWorkConflict;
  action: GuardedAction;
  retry: () => Promise<void>;
  /** The forced retry stopped the work, but the action did not finish. */
  stopped?: boolean;
}

/**
 * The confirm step for an action the server refused because background
 * work would stop (409 `background_work`, fix wave 3 H1 to H3). It lists
 * the work the caller can see and resends with `force` on confirm. When
 * force cannot help (hidden work, or no right to stop it), it shows the
 * server's text and offers no confirm.
 */
export function BackgroundWorkConfirmDialog({
  prompt,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  prompt: Prompt | null;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const conflict = prompt?.conflict;
  const stopped = prompt?.stopped === true;
  const copy = prompt ? confirmCopy(prompt.conflict, prompt.action, stopped) : { title: "", description: "" };
  const canConfirm = conflict?.forceAllowed === true && !stopped;
  return (
    <Dialog open={prompt !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent title={copy.title} description={copy.description}>
        {conflict && conflict.work.length > 0 && <BackgroundWorkList items={conflict.work} stopped={stopped} />}
        {conflict && !stopped && conflict.hiddenCount > 0 && (
          <p className="text-xs text-muted">
            {conflict.hiddenCount === 1
              ? "1 more item runs on a thread you cannot see."
              : `${conflict.hiddenCount} more items run on threads you cannot see.`}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            {canConfirm ? "Cancel" : "Close"}
          </Button>
          {canConfirm && (
            <Button type="button" variant="danger" disabled={pending} onClick={onConfirm}>
              {pending ? "Stopping…" : prompt?.action.confirmLabel}
            </Button>
          )}
        </DialogFooter>
        {error != null && <p role="alert" className="text-xs text-danger-500">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Runs an action that background work may block. `attempt(action, run)`
 * calls `run(false)`. On a 409 `background_work` it opens the confirm
 * dialog, which calls `run(true)` when the person confirms. `onDone` runs
 * after either call succeeds. `attempt` resolves `"done"` when the first
 * call succeeded and `"confirming"` when the dialog opened. Any other error
 * rejects it, so the caller reports it as before. Render `dialog` once in
 * the caller.
 */
export function useBackgroundWorkGuard(): {
  attempt: (
    action: GuardedAction,
    run: (force: boolean) => Promise<unknown>,
    onDone?: () => void,
  ) => Promise<"done" | "confirming">;
  dialog: ReactNode;
} {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const attempt = useCallback(
    async (
      action: GuardedAction,
      run: (force: boolean) => Promise<unknown>,
      onDone?: () => void,
    ): Promise<"done" | "confirming"> => {
      try {
        await run(false);
        onDone?.();
        return "done";
      } catch (err) {
        const conflict = backgroundWorkConflict(err);
        if (!conflict) throw err;
        setError(null);
        setPrompt({
          conflict,
          action,
          retry: async () => {
            await run(true);
            onDone?.();
          },
        });
        return "confirming";
      }
    },
    [],
  );

  async function confirmStop() {
    if (!prompt) return;
    setPending(true);
    setError(null);
    try {
      await prompt.retry();
      setPrompt(null);
    } catch (err) {
      // A newer refusal (more work started) replaces the list. A 409 after
      // the work already stopped marks the list stopped and ends the confirm.
      const conflict = backgroundWorkConflict(err);
      if (conflict) setPrompt({ ...prompt, conflict });
      else if (workAlreadyStopped(err)) setPrompt({ ...prompt, stopped: true });
      setError(conflict ? conflict.error : errorText(err));
    } finally {
      setPending(false);
    }
  }

  const dialog = (
    <BackgroundWorkConfirmDialog
      prompt={prompt}
      pending={pending}
      error={error}
      onConfirm={() => void confirmStop()}
      onClose={() => {
        if (pending) return;
        setPrompt(null);
        setError(null);
      }}
    />
  );
  return { attempt, dialog };
}
