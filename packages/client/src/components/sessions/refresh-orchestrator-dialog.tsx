import { useEffect, useRef } from 'react';
import { useTerminateSession } from '@/api/sessions';
import { useOrchestratorInfo, useCreateOrchestrator } from '@/api/orchestrator';
import { ApiError } from '@/api/client';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface RefreshOrchestratorDialogProps {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RefreshOrchestratorDialog({
  sessionId,
  open,
  onOpenChange,
}: RefreshOrchestratorDialogProps) {
  const terminateSession = useTerminateSession();
  const createOrchestrator = useCreateOrchestrator();
  const { data: orchInfo } = useOrchestratorInfo();

  const isPending = terminateSession.isPending || createOrchestrator.isPending;
  const error = terminateSession.error ?? createOrchestrator.error;

  // A closed dialog keeps this component mounted, so mutation state (a
  // stale error from a previous attempt) would leak into the next open.
  // Reset on close so every open starts the flow fresh.
  useEffect(() => {
    if (!open) {
      terminateSession.reset();
      createOrchestrator.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset fns are stable
  }, [open]);

  // The awaited flow can outlive a close (Escape mid-flight). Navigating
  // after the user cancelled would yank the page away, so the success
  // navigation checks this ref first.
  const openRef = useRef(open);
  openRef.current = open;

  const handleRefresh = async () => {
    if (!orchInfo?.identity) return;

    try {
      // Terminate is idempotent (the DO reports alreadyTerminated and the
      // route succeeds), so a retry after a failed re-create just runs it
      // again.
      await terminateSession.mutateAsync(sessionId);

      // Re-create with the same identity
      await createOrchestrator.mutateAsync({
        name: orchInfo.identity.name,
        handle: orchInfo.identity.handle,
        customInstructions: orchInfo.identity.customInstructions ?? undefined,
      });
    } catch (err) {
      // "Already exists" means the auto-restart hook or the recovery cron
      // re-created the orchestrator while this dialog sat on an error —
      // the goal state is reached, so navigate instead of showing a
      // dead-end 409 (TKAI-295).
      const alreadyExists = err instanceof ApiError && err.status === 409 && /already exists/i.test(err.message);
      if (!alreadyExists) {
        // The failed mutation's error renders inside the dialog, which
        // stays open so the failure is visible and Retry is available
        // (TKAI-295). Swallowing it silently used to close the dialog with
        // the session already terminated and no restart — the "mega stuck"
        // state.
        return;
      }
    }

    // Navigate to the new session (full reload to clear stale WS connections
    // & chat state) — unless the user closed the dialog mid-flight.
    if (openRef.current) {
      window.location.href = '/sessions/orchestrator';
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Refresh Orchestrator</AlertDialogTitle>
          <AlertDialogDescription>
            This will restart {orchInfo?.identity?.name ?? 'your orchestrator'} with a fresh sandbox.
            Your identity and memories will be preserved, but the current
            session history will be cleared.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">
            Restart failed: {error.message}. Retry, or check Settings if the name or handle is
            already taken.
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              // AlertDialogAction closes the dialog on click by default;
              // keep it open so a failure has somewhere to render.
              e.preventDefault();
              void handleRefresh();
            }}
            disabled={isPending}
          >
            {terminateSession.isPending
              ? 'Stopping...'
              : createOrchestrator.isPending
                ? 'Restarting...'
                : error
                  ? 'Retry'
                  : 'Refresh'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
