import { useEffect } from 'react';
import { useTerminateSession } from '@/api/sessions';
import { useOrchestratorInfo, useCreateOrchestrator } from '@/api/orchestrator';
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
  const error = (terminateSession.error ?? createOrchestrator.error) as Error | null;

  // A closed dialog keeps this component mounted, so mutation state (a
  // done terminate, a stale error) would leak into the next open and make
  // the flow skip the terminate step. Reset on close so every open starts
  // the flow fresh.
  useEffect(() => {
    if (!open) {
      terminateSession.reset();
      createOrchestrator.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset fns are stable
  }, [open]);

  const handleRefresh = async () => {
    if (!orchInfo?.identity) return;

    try {
      // Terminate the current session. Skipped on retry when it already
      // succeeded — the session is gone, and terminating it again fails
      // and blocks the restart (TKAI-295).
      if (!terminateSession.isSuccess) {
        await terminateSession.mutateAsync(sessionId);
      }

      // Re-create with the same identity
      await createOrchestrator.mutateAsync({
        name: orchInfo.identity.name,
        handle: orchInfo.identity.handle,
        customInstructions: orchInfo.identity.customInstructions ?? undefined,
      });

      // Navigate to the new session (full reload to clear stale WS connections & chat state)
      window.location.href = '/sessions/orchestrator';
    } catch {
      // The failed mutation's error renders inside the dialog, which stays
      // open so the failure is visible and Retry is available (TKAI-295).
      // Swallowing it here used to close the dialog with the session
      // already terminated and no restart — the "mega stuck" state.
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
          <AlertDialogCancel>Cancel</AlertDialogCancel>
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
