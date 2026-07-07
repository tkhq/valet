import * as React from 'react';
import type { ChannelTriggerMode } from '@valet/shared';
import { useCreateTeamChannel, useDeleteTeamChannel, useTeamChannels, useUpdateTeamChannel } from '@/api/teams';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toastError, toastSuccess } from '@/hooks/use-toast';

export function TeamChannels({ teamId, canManage }: { teamId: string; canManage: boolean }) {
  const { data: bindings, isLoading } = useTeamChannels(teamId);
  const updateChannel = useUpdateTeamChannel();
  const deleteChannel = useDeleteTeamChannel();

  if (isLoading) return <Skeleton className="h-40 w-full rounded-md" />;

  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Bind a Slack channel to route its messages to this team's orchestrator. Only team members'
        messages are handled; the bot must be invited to the channel (<span className="font-mono">/invite</span>).
        "Mention" responds only when the bot is @mentioned (or in threads it's active in); "All messages"
        listens passively — every message becomes an orchestrator evaluation, batched, so expect higher usage
        in busy channels.
      </p>

      {(bindings ?? []).length > 0 ? (
        <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {(bindings ?? []).map((b) => (
            <li key={b.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate font-mono text-xs">{b.slackChannelId || b.channelId}</div>
                <div className="text-[10px] text-neutral-400">slack</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {canManage ? (
                  <select
                    className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-xs dark:border-neutral-700"
                    value={b.triggerMode ?? 'mention'}
                    onChange={(e) =>
                      updateChannel.mutate(
                        { teamId, bindingId: b.id, triggerMode: e.target.value as ChannelTriggerMode },
                        { onError: (err) => toastError(err instanceof Error ? err.message : 'Update failed') }
                      )
                    }
                  >
                    <option value="mention">Mention only</option>
                    <option value="all">All messages</option>
                  </select>
                ) : (
                  <span className="rounded-full border border-neutral-300 px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
                    {b.triggerMode ?? 'mention'}
                  </span>
                )}
                {canManage ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      deleteChannel.mutate(
                        { teamId, bindingId: b.id },
                        {
                          onSuccess: () => toastSuccess('Channel unbound'),
                          onError: (err) => toastError(err instanceof Error ? err.message : 'Unbind failed'),
                        }
                      )
                    }
                  >
                    Unbind
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-md border border-dashed border-neutral-300 p-6 text-center text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          No channels bound yet.
        </div>
      )}

      {canManage ? <AddChannelForm teamId={teamId} /> : null}
    </div>
  );
}

function AddChannelForm({ teamId }: { teamId: string }) {
  const [channelId, setChannelId] = React.useState('');
  const [triggerMode, setTriggerMode] = React.useState<ChannelTriggerMode>('mention');
  const createChannel = useCreateTeamChannel();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    createChannel.mutate(
      { teamId, slackChannelId: channelId.trim(), triggerMode },
      {
        onSuccess: () => {
          toastSuccess('Channel bound');
          setChannelId('');
        },
        onError: (err) => toastError(err instanceof Error ? err.message : 'Failed to bind channel'),
      }
    );
  };

  return (
    <form onSubmit={submit} className="flex items-end gap-2">
      <label className="block flex-1 space-y-1">
        <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
          Slack channel ID <span className="font-normal text-neutral-400">(e.g. C0123ABCDEF — channel details → About)</span>
        </span>
        <Input value={channelId} onChange={(e) => setChannelId(e.target.value)} placeholder="C0123ABCDEF" className="font-mono" />
      </label>
      <select
        className="rounded-md border border-neutral-300 bg-transparent px-2 py-2 text-xs dark:border-neutral-700"
        value={triggerMode}
        onChange={(e) => setTriggerMode(e.target.value as ChannelTriggerMode)}
      >
        <option value="mention">Mention only</option>
        <option value="all">All messages</option>
      </select>
      <Button type="submit" disabled={!channelId.trim() || createChannel.isPending}>
        {createChannel.isPending ? 'Binding…' : 'Bind'}
      </Button>
    </form>
  );
}
