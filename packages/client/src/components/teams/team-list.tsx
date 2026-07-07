import * as React from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import type { Team } from '@valet/shared';
import { useCreateTeam, useTeams } from '@/api/teams';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toastError } from '@/hooks/use-toast';
import { formatRelativeTime } from '@/lib/format';

export function TeamList() {
  const { data: teams, isLoading, error } = useTeams();

  return (
    <PageContainer>
      <PageHeader
        title="Teams"
        description="Shared groups with their own orchestrator, memory, and resources."
        actions={<CreateTeamDialog />}
      />
      {isLoading ? (
        <TeamListSkeleton />
      ) : error ? (
        <div className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          Failed to load teams: {error instanceof Error ? error.message : 'unknown error'}
        </div>
      ) : !teams || teams.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {teams.map((team) => (
            <TeamRow key={team.id} team={team} />
          ))}
        </ul>
      )}
    </PageContainer>
  );
}

function TeamRow({ team }: { team: Team }) {
  return (
    <li>
      <Link
        to="/teams/$teamId"
        params={{ teamId: team.id }}
        className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-900"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{team.name}</span>
            {team.myRole ? (
              <span className="rounded-full border border-neutral-300 px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
                {team.myRole}
              </span>
            ) : null}
          </div>
          {team.description ? (
            <p className="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-400">{team.description}</p>
          ) : null}
        </div>
        <div className="shrink-0 text-right text-xs text-neutral-500 dark:text-neutral-400">
          <div>
            {team.memberCount ?? 0} {(team.memberCount ?? 0) === 1 ? 'member' : 'members'}
          </div>
          <div>created {formatRelativeTime(team.createdAt)}</div>
        </div>
      </Link>
    </li>
  );
}

function TeamListSkeleton() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-14 w-full rounded-md" />
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-neutral-300 p-10 text-center dark:border-neutral-700">
      <h3 className="text-sm font-medium">No teams yet</h3>
      <p className="max-w-sm text-xs text-neutral-500 dark:text-neutral-400">
        Create a team to give a group of people a shared orchestrator and shared resources.
      </p>
      <CreateTeamDialog />
    </div>
  );
}

export function CreateTeamDialog() {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const createTeam = useCreateTeam();
  const navigate = useNavigate();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createTeam.mutate(
      { name: name.trim(), description: description.trim() || undefined },
      {
        onSuccess: (response) => {
          setOpen(false);
          setName('');
          setDescription('');
          void navigate({ to: '/teams/$teamId', params: { teamId: response.team.id } });
        },
        onError: (err) => {
          toastError(err instanceof Error ? err.message : 'Failed to create team');
        },
      }
    );
  };

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        New team
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Create team</DialogTitle>
              <DialogDescription>You'll be the team's first admin.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <label className="block space-y-1">
                <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">Name</span>
                <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={100} />
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                  Description <span className="font-normal text-neutral-400">(optional)</span>
                </span>
                <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
              </label>
            </div>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim() || createTeam.isPending}>
                {createTeam.isPending ? 'Creating...' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
