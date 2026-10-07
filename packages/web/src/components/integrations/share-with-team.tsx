/**
 * Personal Integrations → share a connected service with a team you
 * belong to. This is the written exception to workspace-as-place: the
 * page is personal, and the list is every team the caller is on. There
 * is no owner dropdown. The switcher is not this page's owner.
 *
 * "Every team the caller is on" is a filter, not a description of the
 * response: `GET /api/teams` gives an org admin every team in the org
 * (`callerRole: null` on the ones they are not on), while
 * `POST /api/credentials/:service/delegate` calls `isTeamMember` and answers
 * 404 for those same teams. Unfiltered, the list offered an admin rows that
 * could only fail.
 */
import { useState } from "react";
import type { TeamSummary } from "@valet/api/wire";
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
  const [acknowledged, setAcknowledged] = useState(false);
  const teamsQ = useTeams();
  const teams = teamsQ.data?.teams ?? [];
  const mine = teams.filter((team) => team.callerRole !== null);
  // Only an org admin is ever sent a team they are not on, so this count is
  // also the test for "explain the teams that are missing from this list".
  const hidden = teams.length - mine.length;
  const settled = !teamsQ.isLoading && !teamsQ.error;

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); setAcknowledged(false); }}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" aria-label={`Share ${title} with a team`}>
          Share with a team
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <p className="px-2 pb-2 text-xs text-muted">
          Your own work in the team uses your {title} account. When a teammate's request needs it, Valet asks you
          first. Sharing stops if you leave the team or stop sharing.
        </p>
        <label className="flex items-start gap-2 px-2 pb-2 text-xs">
          <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
          Use my account for my team work, and ask me before a teammate uses it.
        </label>
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
            <TeamShareRow key={team.id} team={team} service={service} title={title} open={open} acknowledged={acknowledged} />
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
  acknowledged,
}: {
  team: TeamSummary;
  service: string;
  title: string;
  open: boolean;
  acknowledged: boolean;
}) {
  const me = useMe();
  const credsQ = useCredentials("team", { teamId: team.id, enabled: open });
  const delegate = useDelegateCredential();
  const revoke = useRevokeDelegation();
  const rows = credsQ.data?.credentials.filter((c) => c.service === service) ?? [];
  // Each member keeps their own share, so sharing never displaces anyone.
  const myRow = rows.find((c) => c.delegatedFrom === me.data?.id);
  const mine = myRow !== undefined;
  const others = rows.filter((c) => c.delegatedFrom && c.delegatedFrom !== me.data?.id).length;
  const teamOwn = rows.some((c) => !c.delegatedFrom);
  const pending = delegate.isPending || revoke.isPending;
  const err = delegate.error ?? revoke.error;
  const context = [teamOwn ? "Has its own connection." : null,
    others > 0 ? `${others === 1 ? "1 other member shares" : `${others} other members share`} theirs.` : null].filter(Boolean).join(" ");

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-2 py-1">
      <div className="min-w-0">
        <p className="truncate text-sm text-ink">{team.name}</p>
        {context && <p className="text-xs text-muted">{context}</p>}
        {myRow?.referenceBroken && (
          <p className="text-xs text-danger-500">Broken. Reconnect {title}, then share again.</p>
        )}
        {credsQ.error && <p className="text-xs text-danger-500">Could not check this team’s connections. Reload before sharing.</p>}
        {err && <p className="text-xs text-danger-500">{errorText(err)}</p>}
      </div>
      {mine ? (
        // "Stop sharing", not "Disconnect": this drops the team's link and
        // leaves the caller connected. `settings/teams-panel.tsx` names the
        // same action the same way.
        //
        // `mutate`, not `mutateAsync`: the row reads the failure off
        // `revoke.error` above, and a `void mutateAsync(...)` rejection
        // reaches `window.onunhandledrejection`, reporting it a second time.
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0"
          disabled={pending}
          aria-label={`Stop sharing ${title} with ${team.name}`}
          onClick={() => revoke.mutate({ service, teamId: team.id })}
        >
          {revoke.isPending ? "Stopping…" : "Stop sharing"}
        </Button>
      ) : (
        <Button
          size="sm"
          className="shrink-0"
          disabled={!acknowledged || pending || credsQ.isLoading || !!credsQ.error || !credsQ.data}
          aria-label={`Share ${title} with ${team.name}`}
          onClick={() => delegate.mutate({ service, body: { teamId: team.id } })}
        >
          {delegate.isPending ? "Sharing…" : "Share"}
        </Button>
      )}
    </li>
  );
}
