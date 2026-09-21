import { useState } from "react";
import type { CredentialSummary } from "@valet/api/wire";
import { useCredentials, useDelegateCredential } from "~/api/integrations";
import { Button, Popover, PopoverContent, PopoverTrigger } from "~/components/primitives";
import { displayName } from "~/components/integrations/display-name";
import { errorText } from "~/lib/error-text";

/**
 * Team Integrations → take one of YOUR OWN connections into this team.
 *
 * The other direction of `ShareWithTeam`, and the same write: the delegate
 * route reads the caller's own row and gates on team membership alone, so
 * standing on the team page changes nothing about who may do this. It exists
 * because a person looking for their team's connections looks at the team's
 * page, and the answer used to be a link back to the personal one.
 *
 * Sharing hands the team a pointer, not a copy. Teammates act through your
 * account with its permissions, and the team loses it if you leave.
 */

/** The reserved service that holds a 1Password service-account TOKEN. It is
 * a key to whole vaults rather than one service's credential, the delegate
 * route refuses it by name, and a team wanting 1Password connects its own
 * service account instead. */
const ONEPASSWORD = "onepassword";

/**
 * Why a row cannot be shared, or null when it can. A reference resolves for
 * a team only through the ORG token, so a personal-scope one would hand the
 * team a pointer that never resolves — the route refuses it, and saying so
 * here saves the round trip.
 */
export function blockedReason(cred: CredentialSummary, teamServices: Set<string>): string | null {
  if (cred.service === ONEPASSWORD) {
    return "A 1Password token is not a single connection. Connect a team service account instead.";
  }
  if (teamServices.has(cred.service)) return "This team already has a connection for this service.";
  if (cred.onepasswordTokenScope === "personal") {
    return "This reads a personal 1Password token, which a team cannot use. Store it again with the organization token.";
  }
  return null;
}

export function PullFromPersonal({ teamId, teamName }: { teamId: string; teamName: string }) {
  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const mineQ = useCredentials("user");
  const teamQ = useCredentials("team", { teamId });
  const delegate = useDelegateCredential();

  const mine = mineQ.data?.credentials ?? [];
  const teamServices = new Set((teamQ.data?.credentials ?? []).map((c) => c.service));
  const settled = !mineQ.isLoading && !mineQ.error;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setAcknowledged(false);
        delegate.reset();
      }}
    >
      <PopoverTrigger asChild>
        <Button size="sm" variant="secondary" aria-label={`Share one of your connections with ${teamName}`}>
          Share a personal connection
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        <p className="px-2 pb-2 text-xs text-muted">
          Prefer a dedicated team account. Sharing lets teammates act through your account with its
          permissions. Access stops if you leave {teamName} or revoke sharing.
        </p>
        <label className="flex items-start gap-2 px-2 pb-2 text-xs">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          I authorize teammates to act through my personal account.
        </label>

        {mineQ.isLoading && <p className="px-2 py-2 text-xs text-muted">Loading your connections…</p>}
        {mineQ.error && (
          <p className="px-2 py-2 text-xs text-danger-500">
            Could not load your connections. Reload the page.
          </p>
        )}
        {settled && mine.length === 0 && (
          <p className="px-2 py-2 text-xs text-muted">
            You have no personal connections yet. Connect one under Settings, You, Connected
            accounts.
          </p>
        )}

        {settled &&
          mine.map((cred) => {
            const blocked = blockedReason(cred, teamServices);
            const title = displayName(cred.service);
            return (
              <div key={cred.service} className="px-2 py-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm text-ink">{title}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!acknowledged || blocked !== null || delegate.isPending}
                    aria-label={`Share ${title} with ${teamName}`}
                    onClick={() => delegate.mutate({ service: cred.service, body: { teamId } })}
                  >
                    Share
                  </Button>
                </div>
                {blocked && <p className="text-xs text-muted">{blocked}</p>}
              </div>
            );
          })}

        {delegate.error && (
          <p className="px-2 py-2 text-xs text-danger-500">
            {errorText(delegate.error, "Couldn't share that connection.")}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
