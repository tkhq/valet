import { useState, type ReactNode } from "react";
import type { CredentialSummary, OrgDirectoryUserWire, TeamSummary } from "@valet/api/wire";
import { useCredentials, useDisconnectCredential, useRevokeDelegation } from "~/api/integrations";
import { Badge, Button, ConfirmDialog, EmptyRow, ErrorRow, LoadingRow } from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { CardHeading } from "./integration-card";
import { displayName } from "./display-name";
import { credentialRowHealth, healthBadge, healthNote, isDeadConnection, needsReauth, type ServiceHealth } from "./service-health";
import { TeamConnectionDialog } from "./team-connection-setup";

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

/**
 * The repair for a row that cannot act. Any member may reconnect a dead team
 * connection (`isDeadConnection`). For a team connection in another broken
 * state, an admin removes it and connects again. A shared account belongs to
 * its member, so only that member can repair it.
 */
function repairNote(
  row: CredentialSummary,
  health: ServiceHealth,
  canMutate: boolean,
  nameFor: (userId: string) => string,
): string {
  const service = displayName(row.service);
  const problem = health === "identity-only" ? "This connection gives sign-in only." : "The last token refresh failed.";
  if (row.delegatedFrom) return `${problem} ${nameFor(row.delegatedFrom)} must reconnect ${service} in their own Integrations.`;
  if (isDeadConnection(row)) return healthNote(health) ?? problem;
  return canMutate
    ? `${problem} Disconnect it, then connect ${service} again under Available.`
    : `${problem} Ask a team admin to connect ${service} again.`;
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
  children,
}: {
  team: TeamSummary;
  orgMembers: OrgDirectoryUserWire[];
  canMutate: boolean;
  cards?: boolean;
  /** Connected team rows that own their controls, such as 1Password, listed first. */
  children?: ReactNode;
}) {
  const credsQ = useCredentials("team", { teamId: team.id });
  const disconnect = useDisconnectCredential();
  const revoke = useRevokeDelegation();
  // One row at a time, so the list renders ONE dialog.
  const [removing, setRemoving] = useState<CredentialSummary | null>(null);
  const [reconnecting, setReconnecting] = useState<string | null>(null);
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
      {credsQ.isLoading && <LoadingRow label="Loading credentials…" className="py-2 text-xs" />}
      {credsQ.error && <ErrorRow>Could not load credentials. Reload the page.</ErrorRow>}
      {!cards && rows.length > 0 && (
        <p className="mt-1 text-xs text-muted">
          Team actions use the acting member's own account first, then the team connection. Using another member's account asks them first.
        </p>
      )}
      {!credsQ.isLoading && !credsQ.error && rows.length === 0 && !children && (
        <EmptyRow>
          No connections added to this team yet. Connect an account for this team.
        </EmptyRow>
      )}
      <ul aria-label="Team connections" className={cards ? "divide-y divide-line" : "mt-1 space-y-3"}>
        {children}
        {byService(rows).map((group) => (
          <li key={group.service} className={cards ? "py-3.5 first:pt-0.5 last:pb-0.5" : undefined}>
            <div className={cards ? undefined : "py-2"}>
              <CardHeading
                title={group.service === "linear" ? "Linear MCP" : displayName(group.service)}
                slug={group.service}
                description={group.rows.length === 1 ? "1 account" : `${group.rows.length} accounts`}
              />
              {/* pl-12 starts these lines under the title, past the 36px icon and its gap. */}
              <ul className="mt-2 space-y-3 text-xs sm:pl-12">
                {group.rows.map((row) => {
                  const removal = removalLabels(row, team.name, nameFor);
                  const health = credentialRowHealth(row);
                  const badge = needsReauth(health) ? healthBadge(health) : null;
                  const canReconnect = !row.delegatedFrom && row.type === "oauth2" && isDeadConnection(row);
                  return (
                    <li key={row.delegatedFrom ?? "team"} className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-ink">
                          <span className="truncate">{row.delegatedFrom ? `Shared by ${nameFor(row.delegatedFrom)}` : "Team connection"}</span>
                          {row.referenceBroken && <Badge variant="danger">Broken</Badge>}
                          {!row.referenceBroken && badge && <Badge variant={badge.variant}>{badge.label}</Badge>}
                        </p>
                        {row.referenceBroken && (
                          <p className="text-danger-500">Their account is gone or they left the team. They can share it again.</p>
                        )}
                        {!row.referenceBroken && badge && (
                          <p className="text-danger-500">{repairNote(row, health, canMutate, nameFor)}</p>
                        )}
                      </div>
                      <div className="flex shrink-0 gap-2">
                      {canReconnect && (
                        <Button size="sm" variant="primary" aria-label={`Reconnect ${displayName(row.service)} for ${team.name}`}
                          onClick={() => setReconnecting(row.service)}>
                          Reconnect
                        </Button>
                      )}
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
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </li>
        ))}
      </ul>

      {reconnecting && (
        <TeamConnectionDialog
          key={reconnecting}
          teamId={team.id}
          service={{ service: reconnecting, type: "oauth2", connect: "oauth" }}
          reconnect
          onClose={() => setReconnecting(null)}
        />
      )}
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
