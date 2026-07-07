import * as React from 'react';
import { teamOrchestratorAlias } from '@valet/shared';
import { useCreateTeamOrchestrator, useRestartTeamOrchestrator, useTeamOrchestrator } from '@/api/teams';
import { ChatContainer } from '@/components/chat/chat-container';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toastError } from '@/hooks/use-toast';
import { ApiError } from '@/api/client';

export function TeamOrchestratorChat({ teamId, canManage }: { teamId: string; canManage: boolean }) {
  const { data: info, isLoading } = useTeamOrchestrator(teamId);
  const restart = useRestartTeamOrchestrator();
  const restartAttempted = React.useRef(false);

  // Auto-restart: recovery, not configuration — any member may trigger it,
  // mirroring what the reconcile cron does with no user at all.
  React.useEffect(() => {
    if (info?.needsRestart && !restartAttempted.current && !restart.isPending) {
      restartAttempted.current = true;
      restart.mutate(
        { teamId },
        { onError: (err) => toastError(err instanceof Error ? err.message : 'Failed to restart team orchestrator') }
      );
    }
  }, [info?.needsRestart, restart, teamId]);

  if (isLoading) {
    return <Skeleton className="h-[60vh] w-full rounded-md" />;
  }

  if (!info?.exists) {
    return canManage ? (
      <TeamOrchestratorSetup teamId={teamId} />
    ) : (
      <div className="rounded-md border border-dashed border-neutral-300 p-10 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
        This team's orchestrator hasn't been set up yet — ask a team admin to create it.
      </div>
    );
  }

  if (info.needsRestart) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-neutral-300 p-10 text-center dark:border-neutral-700">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {restart.isPending ? 'Starting the team orchestrator…' : 'The team orchestrator is not running.'}
        </p>
        {!restart.isPending ? (
          <Button
            type="button"
            onClick={() => restart.mutate({ teamId }, { onError: (err) => toastError(err instanceof Error ? err.message : 'Restart failed') })}
          >
            Start it
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-16rem)] min-h-[24rem] overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-800">
      <ChatContainer
        key={info.sessionId}
        sessionId={info.sessionId}
        routeSessionId={teamOrchestratorAlias(teamId)}
      />
    </div>
  );
}

function TeamOrchestratorSetup({ teamId }: { teamId: string }) {
  const [name, setName] = React.useState('');
  const [handle, setHandle] = React.useState('');
  const [customInstructions, setCustomInstructions] = React.useState('');
  const create = useCreateTeamOrchestrator();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    create.mutate(
      {
        teamId,
        name: name.trim(),
        handle: handle.trim(),
        customInstructions: customInstructions.trim() || undefined,
      },
      {
        onError: (err) => {
          const message =
            err instanceof ApiError && err.status === 409
              ? 'That name or handle is already taken in this organization.'
              : err instanceof Error
                ? err.message
                : 'Failed to create team orchestrator';
          toastError(message);
        },
      }
    );
  };

  const handleValid = /^[a-z0-9_-]*$/.test(handle);

  return (
    <form onSubmit={submit} className="max-w-lg space-y-3">
      <h3 className="text-sm font-medium">Set up the team orchestrator</h3>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Give your team's agent a name and a unique handle. Every team member will be able to chat with it here.
      </p>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">Name</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={100} placeholder="Platform Bot" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">Handle</span>
        <Input
          value={handle}
          onChange={(e) => setHandle(e.target.value.toLowerCase())}
          maxLength={50}
          placeholder="platform-bot"
        />
        {!handleValid ? (
          <span className="text-xs text-red-600 dark:text-red-400">Lowercase letters, numbers, dashes, underscores.</span>
        ) : null}
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
          Instructions <span className="font-normal text-neutral-400">(optional)</span>
        </span>
        <textarea
          className="w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700"
          rows={4}
          value={customInstructions}
          onChange={(e) => setCustomInstructions(e.target.value)}
          maxLength={10000}
          placeholder="What this team works on, conventions, repos it should know about…"
        />
      </label>
      <Button type="submit" disabled={!name.trim() || !handle.trim() || !handleValid || create.isPending}>
        {create.isPending ? 'Creating…' : 'Create team orchestrator'}
      </Button>
    </form>
  );
}
