/**
 * Personal Integrations → share a connected service with a team you
 * belong to. This is the written exception to workspace-as-place: the
 * page is personal, and the list is every team the caller is on. There
 * is no owner dropdown. The switcher is not this page's owner.
 */
import { useState } from "react";
import type { TeamSummary } from "@valet/api/wire";
import { ApiError } from "~/api/client";
import {
  useCredentials,
  useDelegateCredential,
  useRevokeDelegation,
} from "~/api/integrations";
import { useMe, useTeams } from "~/api/settings";
import { Button, Popover, PopoverContent, PopoverTrigger } from "~/components/primitives";
import { errorText } from "~/lib/error-text";

export function ShareWithTeam({ service, title }: { service: string; title: string }) {
  const [open, setOpen] = useState(false);
  const teamsQ = useTeams();
  const teams = teamsQ.data?.teams ?? [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" aria-label={`Share ${title} with a team`}>
          Share with a team
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <p className="px-2 pb-2 text-xs text-muted">
          Share your {title} connection with a team you belong to. The team
          follows your live credential. It does not copy the secret.
        </p>
        {teamsQ.isLoading && <p className="px-2 py-2 text-xs text-muted">Loading teams…</p>}
        {teamsQ.error && (
          <p className="px-2 py-2 text-xs text-danger-500">Could not load teams. Reload the page.</p>
        )}
        {!teamsQ.isLoading && !teamsQ.error && teams.length === 0 && (
          <p className="px-2 py-2 text-xs text-muted">You are not on a team yet.</p>
        )}
        <ul className="space-y-1">
          {teams.map((team) => (
            <TeamShareRow key={team.id} team={team} service={service} title={title} open={open} />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function TeamShareRow({
  team,
  service,
  title,
  open,
}: {
  team: TeamSummary;
  service: string;
  title: string;
  open: boolean;
}) {
  const me = useMe();
  const credsQ = useCredentials("team", { teamId: team.id, enabled: open });
  const delegate = useDelegateCredential();
  const revoke = useRevokeDelegation();
  const row = credsQ.data?.credentials.find((c) => c.service === service);
  const mine = row !== undefined && row.delegatedFrom === me.data?.id;
  const occupied = row !== undefined && !mine;
  const pending = delegate.isPending || revoke.isPending;
  const err = delegate.error ?? revoke.error;

  return (
    <li className="flex items-center justify-between gap-2 px-2 py-1">
      <div className="min-w-0">
        <p className="truncate text-sm text-ink">{team.name}</p>
        {occupied && (
          <p className="text-xs text-muted">
            {row.referenceBroken
              ? "Shared, but the reference is broken."
              : row.delegatedFrom
                ? "Already shared by another member."
                : "This team already has a direct credential."}
          </p>
        )}
        {mine && row?.referenceBroken && (
          <p className="text-xs text-danger-500">Broken. Reconnect {title}, then share again.</p>
        )}
        {err && <p className="text-xs text-danger-500">{shareError(err)}</p>}
      </div>
      {mine ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => void revoke.mutateAsync({ service, teamId: team.id })}
        >
          {revoke.isPending ? "Revoking…" : "Revoke"}
        </Button>
      ) : (
        <Button
          size="sm"
          disabled={pending || occupied || credsQ.isLoading}
          onClick={() => void delegate.mutateAsync({ service, body: { teamId: team.id } })}
        >
          {delegate.isPending ? "Sharing…" : "Share"}
        </Button>
      )}
    </li>
  );
}

function shareError(err: Error): string {
  if (err instanceof ApiError && err.status === 409) {
    return "This team already has that service. Ask an admin to disconnect it first.";
  }
  return errorText(err);
}
