import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { Team, TeamMember, TeamRole } from '@valet/shared';
import {
  useAddTeamMember,
  useDeleteTeam,
  useRemoveTeamMember,
  useTeam,
  useTeamDirectory,
  useTeamMembers,
  useUpdateTeam,
  useUpdateTeamMemberRole,
} from '@/api/teams';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toastError, toastSuccess } from '@/hooks/use-toast';
import { useAuthStore } from '@/stores/auth';
import { TeamOrchestratorChat } from './team-orchestrator-chat';
import { TeamMemory } from './team-memory';
import { TeamChannels } from './team-channels';
import { TeamIntegrations } from './team-integrations';

type TeamTab = 'members' | 'settings' | 'chat' | 'board' | 'memory' | 'channels' | 'integrations';

const STUB_TABS: Array<{ value: TeamTab; label: string; blurb: string }> = [
  { value: 'board', label: 'Board', blurb: 'The shared task board arrives in a later phase.' },
];

export function TeamDetail({ teamId }: { teamId: string }) {
  const { data: team, isLoading, error } = useTeam(teamId);
  const [activeTab, setActiveTab] = React.useState<TeamTab>('chat');
  const currentUser = useAuthStore((s) => s.user);

  if (isLoading) {
    return (
      <PageContainer>
        <Skeleton className="mb-6 h-9 w-64" />
        <Skeleton className="h-40 w-full rounded-md" />
      </PageContainer>
    );
  }

  if (error || !team) {
    return (
      <PageContainer>
        <div className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          Team not found or you don't have access.
        </div>
      </PageContainer>
    );
  }

  const canManage = team.myRole === 'admin' || currentUser?.role === 'admin';

  return (
    <PageContainer>
      <PageHeader title={team.name} description={team.description} />
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TeamTab)}>
        <TabsList>
          <TabsTrigger value="chat">Chat</TabsTrigger>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="memory">Memory</TabsTrigger>
          <TabsTrigger value="channels">Channels</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          {STUB_TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="chat">
          <TeamOrchestratorChat teamId={team.id} canManage={canManage} />
        </TabsContent>

        <TabsContent value="members">
          <MembersTab team={team} canManage={canManage} currentUserId={currentUser?.id} />
        </TabsContent>

        <TabsContent value="memory">
          <TeamMemory teamId={team.id} canManage={canManage} />
        </TabsContent>

        <TabsContent value="channels">
          <TeamChannels teamId={team.id} canManage={canManage} />
        </TabsContent>

        <TabsContent value="integrations">
          <TeamIntegrations teamId={team.id} canManage={canManage} />
        </TabsContent>

        {STUB_TABS.map((t) => (
          <TabsContent key={t.value} value={t.value}>
            <div className="rounded-md border border-dashed border-neutral-300 p-10 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
              {t.blurb}
            </div>
          </TabsContent>
        ))}

        <TabsContent value="settings">
          <SettingsTab team={team} canManage={canManage} />
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}

// ─── Members ─────────────────────────────────────────────────────────────────

function initials(member: TeamMember): string {
  const source = member.name || member.email || member.userId;
  return source
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
}

function MembersTab({
  team,
  canManage,
  currentUserId,
}: {
  team: Team;
  canManage: boolean;
  currentUserId?: string;
}) {
  const { data: members, isLoading } = useTeamMembers(team.id);
  const updateRole = useUpdateTeamMemberRole();
  const removeMember = useRemoveTeamMember();

  if (isLoading) return <Skeleton className="h-32 w-full rounded-md" />;

  return (
    <div className="space-y-4">
      {canManage ? (
        <div className="flex justify-end">
          <AddMemberDialog teamId={team.id} existing={members ?? []} />
        </div>
      ) : null}
      <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {(members ?? []).map((member) => {
          const isSelf = member.userId === currentUserId;
          return (
            <li key={member.userId} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <Avatar>
                  <AvatarImage src={member.avatarUrl ?? undefined} />
                  <AvatarFallback>{initials(member)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {member.name || member.email}
                    {isSelf ? <span className="ml-1 text-xs text-neutral-400">(you)</span> : null}
                  </div>
                  <div className="truncate text-xs text-neutral-500 dark:text-neutral-400">{member.email}</div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {canManage ? (
                  <select
                    className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-xs dark:border-neutral-700"
                    value={member.role}
                    onChange={(e) =>
                      updateRole.mutate(
                        { teamId: team.id, userId: member.userId, role: e.target.value as TeamRole },
                        { onError: (err) => toastError(err instanceof Error ? err.message : 'Failed to update role') }
                      )
                    }
                  >
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                  </select>
                ) : (
                  <span className="rounded-full border border-neutral-300 px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
                    {member.role}
                  </span>
                )}
                {canManage || isSelf ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      removeMember.mutate(
                        { teamId: team.id, userId: member.userId },
                        { onError: (err) => toastError(err instanceof Error ? err.message : 'Failed to remove member') }
                      )
                    }
                  >
                    {isSelf ? 'Leave' : 'Remove'}
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AddMemberDialog({ teamId, existing }: { teamId: string; existing: TeamMember[] }) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const { data: directory } = useTeamDirectory();
  const addMember = useAddTeamMember();

  const existingIds = new Set(existing.map((m) => m.userId));
  const candidates = (directory ?? [])
    .filter((u) => !existingIds.has(u.id))
    .filter((u) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return (u.name ?? '').toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
    })
    .slice(0, 8);

  const add = (userId: string) => {
    addMember.mutate(
      { teamId, userId },
      {
        onSuccess: () => toastSuccess('Member added'),
        onError: (err) => toastError(err instanceof Error ? err.message : 'Failed to add member'),
      }
    );
  };

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        Add member
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add member</DialogTitle>
            <DialogDescription>Anyone in your organization can be added.</DialogDescription>
          </DialogHeader>
          <Input
            placeholder="Search by name or email"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <ul className="max-h-64 divide-y divide-neutral-200 overflow-y-auto dark:divide-neutral-800">
            {candidates.map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm">{u.name || u.email}</div>
                  <div className="truncate text-xs text-neutral-500 dark:text-neutral-400">{u.email}</div>
                </div>
                <Button type="button" size="sm" variant="secondary" disabled={addMember.isPending} onClick={() => add(u.id)}>
                  Add
                </Button>
              </li>
            ))}
            {candidates.length === 0 ? (
              <li className="py-4 text-center text-xs text-neutral-500 dark:text-neutral-400">No matching users.</li>
            ) : null}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Settings ────────────────────────────────────────────────────────────────

function SettingsTab({ team, canManage }: { team: Team; canManage: boolean }) {
  const [name, setName] = React.useState(team.name);
  const [description, setDescription] = React.useState(team.description ?? '');
  const updateTeam = useUpdateTeam();

  const dirty = name.trim() !== team.name || description.trim() !== (team.description ?? '');

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    updateTeam.mutate(
      { teamId: team.id, name: name.trim(), description: description.trim() },
      {
        onSuccess: () => toastSuccess('Team updated'),
        onError: (err) => toastError(err instanceof Error ? err.message : 'Failed to update team'),
      }
    );
  };

  return (
    <div className="max-w-lg space-y-8">
      <form onSubmit={save} className="space-y-3">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!canManage} maxLength={100} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">Description</span>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={!canManage}
            maxLength={2000}
          />
        </label>
        {canManage ? (
          <Button type="submit" disabled={!dirty || !name.trim() || updateTeam.isPending}>
            {updateTeam.isPending ? 'Saving...' : 'Save'}
          </Button>
        ) : null}
      </form>
      {canManage ? <DangerZone team={team} /> : null}
    </div>
  );
}

function DangerZone({ team }: { team: Team }) {
  const [confirmText, setConfirmText] = React.useState('');
  const deleteTeam = useDeleteTeam();
  const navigate = useNavigate();

  const handleDelete = () => {
    deleteTeam.mutate(team.id, {
      onSuccess: () => {
        toastSuccess('Team deleted');
        void navigate({ to: '/teams' });
      },
      onError: (err) => toastError(err instanceof Error ? err.message : 'Failed to delete team'),
    });
  };

  return (
    <div className="space-y-3 rounded-md border border-red-300 p-4 dark:border-red-900">
      <h3 className="text-sm font-medium text-red-700 dark:text-red-400">Danger zone</h3>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Deleting a team removes its membership. Type <span className="font-mono">{team.name}</span> to confirm.
      </p>
      <div className="flex items-center gap-2">
        <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={team.name} />
        <Button
          type="button"
          variant="destructive"
          disabled={confirmText !== team.name || deleteTeam.isPending}
          onClick={handleDelete}
        >
          {deleteTeam.isPending ? 'Deleting...' : 'Delete team'}
        </Button>
      </div>
    </div>
  );
}
