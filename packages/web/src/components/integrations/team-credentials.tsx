import { useState } from "react";
import type { CredentialSummary, OrgDirectoryUserWire, TeamSummary } from "@valet/api/wire";
import { useCredentials, useDisconnectCredential, useRevokeDelegation } from "~/api/integrations";
import { Badge, Button, ConfirmDialog, EmptyRow, ErrorRow, LoadingRow, cardClass } from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { CardHeading } from "./integration-card";
import { displayName } from "./display-name";
import { cn } from "~/lib/cn";

/**
 * The verb for a removal control. A share is a member's own account, so
 * ending it cuts the team's link and leaves that member connected, which is
 * what the Integrations share menu calls "Stop sharing". The team's own
 * connection holds the team's secret, and removing it deletes that secret.
 *
 * Both targets name the service through `displayName`: `row.service` is the
 * wire id, and the API refusals and Integrations spell it the product way.
 */
function removalLabels(
  row: CredentialSummary,
  teamName: string,
  nameFor: (userId: string) => string,
): { action: string; pending: string; target: string } {
  const service = displayName(row.service);
  return row.delegatedFrom
    ? { action: "Stop sharing", pending: "Stopping…", target: `${nameFor(row.delegatedFrom)}'s ${service} with ${teamName}` }
    : { action: "Disconnect", pending: "Disconnecting…", target: `${service} from ${teamName}` };
}

/** The rows grouped by integration, in the order the API lists them. */
function byService(rows: CredentialSummary[]): Array<{ service: string; rows: CredentialSummary[] }> {
  const groups = new Map<string, CredentialSummary[]>();
  for (const row of rows) groups.set(row.service, [...(groups.get(row.service) ?? []), row]);
  return [...groups].map(([service, grouped]) => ({ service, rows: grouped }));
}

/**
 * Every account this team can act as, one entry per integration, shared by
 * Settings and Integrations. An integration lists the team's own connection
 * and each member's shared account. A team action uses the acting member's
 * own share first, then the team's connection, and asks before it uses
 * another member's account.
 */
export function TeamCredentials({
  team,
  orgMembers,
  canMutate,
  cards = false,
}: {
  team: TeamSummary;
  orgMembers: OrgDirectoryUserWire[];
  canMutate: boolean;
  cards?: boolean;
}) {
  const credsQ = useCredentials("team", { teamId: team.id });
  const disconnect = useDisconnectCredential();
  const revoke = useRevokeDelegation();
  // One row at a time, so the list renders ONE dialog.
  const [removing, setRemoving] = useState<CredentialSummary | null>(null);
  const nameFor = (userId: string) => orgMembers.find((m) => m.userId === userId)?.name ?? userId;
  const rows = credsQ.error ? [] : credsQ.data?.credentials ?? [];
  const dialogLabels = removing ? removalLabels(removing, team.name, nameFor) : null;
  const pending = disconnect.isPending || revoke.isPending;
  const failure = removing?.delegatedFrom ? revoke.error : disconnect.error;

  function removalNote(row: CredentialSummary): string {
    const service = displayName(row.service);
    if (row.delegatedFrom) {
      return `Team actions stop using ${nameFor(row.delegatedFrom)}'s ${service} account. They keep their own ` +
        `${service} connection and can share it with the team again from Integrations.`;
    }
    if (row.service === "slack" || row.service === "github") {
      return `This deletes the ${service} credential stored on ${team.name}. Team Integrations cannot recreate this connection. ` +
        "An organization admin manages organization access in Organization settings. Its permissions can differ from this stored connection.";
    }
    return `Runtimes and workflows that run as ${team.name} lose the team's own ${service} connection. ` +
      `Members' shared accounts stay. Connect ${service} again from Integrations to restore it.`;
  }

  return (
    <div>
      {cards && <h4 className="text-xs font-medium uppercase tracking-wide text-muted">Team connections</h4>}
      {credsQ.isLoading && <LoadingRow label="Loading credentials…" className="py-2 text-xs" />}
      {credsQ.error && <ErrorRow>Could not load credentials. Reload the page.</ErrorRow>}
      {rows.length > 0 && (
        <p className="mt-1 text-xs text-muted">
          Team actions use the acting member's own account first, then the team connection. Using another member's account asks them first.
        </p>
      )}
      {!credsQ.isLoading && !credsQ.error && rows.length === 0 && (
        <EmptyRow>
          No connections added to this team yet. Connect an account for this team.
        </EmptyRow>
      )}
      <ul className={cards ? "grid gap-3 pt-4 sm:grid-cols-2" : "mt-1 space-y-3"}>
        {byService(rows).map((group) => (
          <li key={group.service}>
            <div className={cards ? cn(cardClass, "flex h-full flex-col p-5") : "py-2"}>
              <CardHeading
                title={group.service === "linear" ? "Linear MCP" : displayName(group.service)}
                slug={group.service}
                description={group.rows.length === 1 ? "1 account" : `${group.rows.length} accounts`}
              />
              {/* pl-12 starts these lines under the title, past the 36px icon and its gap. */}
              <ul className="mt-2 space-y-3 text-xs sm:pl-12">
                {group.rows.map((row) => {
                  const removal = removalLabels(row, team.name, nameFor);
                  return (
                    <li key={row.delegatedFrom ?? "team"} className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-ink">
                          <span className="truncate">{row.delegatedFrom ? `Shared by ${nameFor(row.delegatedFrom)}` : "Team connection"}</span>
                          {row.referenceBroken && <Badge variant="danger">Broken</Badge>}
                        </p>
                        {row.referenceBroken && (
                          <p className="text-danger-500">Their account is gone or they left the team. They can share it again.</p>
                        )}
                      </div>
                      {canMutate && (
                        <Button
                          size="sm"
                          variant="secondary"
                          className="shrink-0"
                          disabled={pending}
                          aria-label={`${removal.action} ${removal.target}`}
                          onClick={() => {
                            // Clear the previous attempt's refusal as the dialog
                            // opens: React Query holds `error` until the next mutate.
                            disconnect.reset();
                            revoke.reset();
                            setRemoving(row);
                          }}
                        >
                          {removal.action}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          </li>
        ))}
      </ul>

      {canMutate && !credsQ.error && removing && dialogLabels && (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setRemoving(null);
          }}
          title={`${dialogLabels.action} ${dialogLabels.target}?`}
          description={removalNote(removing)}
          confirmLabel={dialogLabels.action}
          pendingLabel={dialogLabels.pending}
          pending={pending}
          error={failure != null ? errorText(failure) : undefined}
          onConfirm={() => {
            const done = { onSuccess: () => setRemoving(null) };
            if (removing.delegatedFrom) {
              revoke.mutate({ service: removing.service, teamId: team.id, userId: removing.delegatedFrom }, done);
            } else {
              disconnect.mutate({ service: removing.service, scope: "team", teamId: team.id }, done);
            }
          }}
        />
      )}
    </div>
  );
}
