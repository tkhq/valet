/**
 * Personal Integrations → share a connected service with a team you
 * belong to. This is the written exception to workspace-as-place: the
 * page is personal, and the list is every team the caller is on. There
 * is no owner dropdown. The switcher is not this page's owner.
 *
 * "Every team the caller is on" is a filter, not a description of the
 * response. `GET /api/teams` gives an org admin every team in the org
 * (`callerRole: null` on the ones they are not on), while
 * `POST /api/credentials/:service/delegate` calls `isTeamMember` and
 * answers 404 for those same teams. An unfiltered list therefore offered
 * an admin rows that could only fail, so the rows are filtered and a note
 * says where to join a team instead.
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
  const mine = teams.filter((team) => team.callerRole !== null);
  // Only an org admin is ever sent a team they are not on, so this count is
  // also the test for "explain the teams that are missing from this list".
  const hidden = teams.length - mine.length;
  const settled = !teamsQ.isLoading && !teamsQ.error;

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
        {settled && mine.length === 0 && hidden === 0 && (
          <p className="px-2 py-2 text-xs text-muted">
            You are not on a team yet. Ask a team admin to add you, then share your {title}{" "}
            connection.
          </p>
        )}
        <ul className="space-y-1">
          {mine.map((team) => (
            <TeamShareRow key={team.id} team={team} service={service} title={title} open={open} />
          ))}
        </ul>
        {settled && hidden > 0 && (
          <p className="px-2 pt-2 text-xs text-muted">
            Teams you are not on are not listed. Add yourself to a team in Settings → Organization →
            Teams to share with it.
          </p>
        )}
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
        {err && <p className="text-xs text-danger-500">{shareError(err, title)}</p>}
      </div>
      {mine ? (
        // The team row carries no secret, so this drops the team's link and
        // leaves the caller connected. `settings/teams-panel.tsx` names the
        // same action the same way for a delegated row.
        //
        // `mutate`, not `mutateAsync`: the row reads the failure off
        // `revoke.error` above and needs nothing from the promise.
        // `mutateAsync` rejects, and a dropped rejection reaches
        // `window.onunhandledrejection`, which reports the same failure a
        // second time.
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          aria-label={`Stop sharing ${title} with ${team.name}`}
          onClick={() => revoke.mutate({ service, teamId: team.id })}
        >
          {revoke.isPending ? "Stopping…" : "Stop sharing"}
        </Button>
      ) : (
        <Button
          size="sm"
          disabled={pending || occupied || credsQ.isLoading}
          aria-label={`Share ${title} with ${team.name}`}
          onClick={() => delegate.mutate({ service, body: { teamId: team.id } })}
        >
          {delegate.isPending ? "Sharing…" : "Share"}
        </Button>
      )}
    </li>
  );
}

/** A 409 says the team's slot filled between the list read and the click.
 * The row behind it may be another member's share or a secret the team
 * stores, and the two are removed under different labels, so this names the
 * page rather than one of them. */
function shareError(err: Error, title: string): string {
  if (err instanceof ApiError && err.status === 409) {
    return `This team already has ${title}. Ask a team admin to change it in Settings → Organization → Teams.`;
  }
  return errorText(err);
}
