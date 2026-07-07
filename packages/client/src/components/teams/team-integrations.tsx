import { useIntegrations } from '@/api/integrations';
import { useShareTeamConnection, useTeamConnections, useUnshareTeamConnection } from '@/api/teams';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toastError, toastSuccess } from '@/hooks/use-toast';
import { useAuthStore } from '@/stores/auth';

export function TeamIntegrations({ teamId, canManage }: { teamId: string; canManage: boolean }) {
  const { data: connections, isLoading } = useTeamConnections(teamId);
  const { data: myIntegrationsResponse } = useIntegrations();
  const myIntegrations = Array.isArray(myIntegrationsResponse)
    ? myIntegrationsResponse
    : myIntegrationsResponse?.integrations;
  const share = useShareTeamConnection();
  const unshare = useUnshareTeamConnection();
  const currentUser = useAuthStore((s) => s.user);

  if (isLoading) return <Skeleton className="h-40 w-full rounded-md" />;

  const sharedProviders = new Set((connections ?? []).map((c) => c.provider));
  const shareable = (myIntegrations ?? []).filter(
    (i) => i.scope === 'user' && i.status === 'active' && !sharedProviders.has(i.service)
  );

  const doShare = (provider: string) =>
    share.mutate(
      { teamId, provider },
      {
        onSuccess: () => toastSuccess('Connection shared with the team'),
        onError: (err) => toastError(err instanceof Error ? err.message : 'Share failed'),
      }
    );

  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Team connections are backed by the sharing member's account — team sessions act as them on the
        external service. If they disconnect or leave the team, the connection breaks (shown below) until
        another member re-sources it with their own.
      </p>

      {(connections ?? []).length > 0 ? (
        <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {(connections ?? []).map((c) => {
            const isSourcer = c.sourcedFromUserId === currentUser?.id;
            return (
              <li key={c.provider} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium capitalize">{c.provider}</span>
                    <span
                      className={
                        c.status === 'broken'
                          ? 'rounded-full border border-red-300 px-2 py-0.5 text-[10px] uppercase tracking-wide text-red-600 dark:border-red-800 dark:text-red-400'
                          : 'rounded-full border border-neutral-300 px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-500 dark:border-neutral-700 dark:text-neutral-400'
                      }
                    >
                      {c.status}
                    </span>
                  </div>
                  <div className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                    Shared by {c.sourcedFromName || c.sourcedFromEmail || 'a former member'}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {c.status === 'broken' && (myIntegrations ?? []).some((i) => i.service === c.provider && i.status === 'active') ? (
                    <Button type="button" size="sm" onClick={() => doShare(c.provider)} disabled={share.isPending}>
                      Re-source with mine
                    </Button>
                  ) : null}
                  {canManage || isSourcer ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        unshare.mutate(
                          { teamId, provider: c.provider },
                          {
                            onSuccess: () => toastSuccess('Connection removed'),
                            onError: (err) => toastError(err instanceof Error ? err.message : 'Remove failed'),
                          }
                        )
                      }
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="rounded-md border border-dashed border-neutral-300 p-6 text-center text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          No shared connections yet.
        </div>
      )}

      {shareable.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-neutral-700 dark:text-neutral-300">Share one of your connections</h4>
          <div className="flex flex-wrap gap-2">
            {shareable.map((i) => (
              <Button
                key={i.id}
                type="button"
                size="sm"
                variant="secondary"
                disabled={share.isPending}
                onClick={() => doShare(i.service)}
              >
                Share {i.service}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
