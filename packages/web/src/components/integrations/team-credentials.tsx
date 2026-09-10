import { useState } from "react";
import type { CredentialSummary, OrgDirectoryUserWire, TeamSummary } from "@valet/api/wire";
import { useCredentials, useDisconnectCredential } from "~/api/integrations";
import { Badge, Button, ConfirmDialog, EmptyRow, ErrorRow, LoadingRow } from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { displayName } from "./display-name";

/**
 * The verb for a removal control. One route serves both rows
 * (`DELETE /api/credentials/:service?scope=team`), but they cost different
 * things. A delegated row is a secretless reference that follows a member's
 * live credential, so dropping it cuts the team's link and leaves that member
 * connected, which is what the Integrations share menu already calls "Stop
 * sharing". A direct row holds the team's own secret, and dropping it deletes
 * that secret. Calling both "Disconnect" read as though it would take a
 * member's personal connection away with it.
 *
 * Both targets name the service through `displayName`. `row.service` is the
 * wire id, and spelling it raw made one credential read "Linear" on
 * Integrations and in every API refusal, and "linear" here.
 */
function removalLabels(
  row: CredentialSummary,
  teamName: string,
): { action: string; pending: string; target: string } {
  const service = displayName(row.service);
  return row.delegatedFrom
    ? { action: "Stop sharing", pending: "Stopping…", target: `${service} with ${teamName}` }
    : { action: "Disconnect", pending: "Disconnecting…", target: `${service} from ${teamName}` };
}

/**
 * Credentials this team can act as, shared by Settings and Integrations.
 * Direct rows and delegated rows share the list because ownership varies
 * inside it, so each row names how it arrived.
 */
export function TeamCredentials({
  team,
  orgMembers,
  canMutate,
}: {
  team: TeamSummary;
  orgMembers: OrgDirectoryUserWire[];
  canMutate: boolean;
}) {
  const credsQ = useCredentials("team", { teamId: team.id });
  const disconnect = useDisconnectCredential();
  // One row at a time, so the list renders ONE dialog. A single boolean would
  // open it for every row and remove whichever service was last in scope.
  const [removing, setRemoving] = useState<CredentialSummary | null>(null);
  const nameFor = (userId: string) => orgMembers.find((m) => m.userId === userId)?.name ?? userId;
  const rows = credsQ.error ? [] : credsQ.data?.credentials ?? [];
  const dialogLabels = removing ? removalLabels(removing, team.name) : null;

  function removalNote(row: CredentialSummary): string {
    const service = displayName(row.service);
    const loss = `Sessions and workflows that run as ${team.name} lose access to ${service}.`;
    return row.delegatedFrom
      ? `${loss} This removes the team's link only. ${nameFor(row.delegatedFrom)} keeps their own ` +
          `${service} connection and can share it with the team again from Integrations.`
      : `${loss} This deletes the credential stored on the team. Connect ${service} again from ` +
          `Integrations to give the team access back.`;
  }

  return (
    <div>
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted">Credentials</h4>
      {credsQ.isLoading && <LoadingRow label="Loading credentials…" className="py-2 text-xs" />}
      {credsQ.error && <ErrorRow>Could not load credentials. Reload the page.</ErrorRow>}
      {!credsQ.isLoading && !credsQ.error && rows.length === 0 && (
        <EmptyRow>No credentials in {team.name} yet. Share one from Integrations.</EmptyRow>
      )}
      <ul className="mt-1 space-y-1">
        {rows.map((row) => {
          const removal = removalLabels(row, team.name);
          return (
            <li key={row.service} className="flex items-center justify-between gap-2 py-1">
              <div className="min-w-0">
                <p className="truncate text-sm text-ink">{displayName(row.service)}</p>
                <p className="text-xs text-muted">
                  {row.delegatedFrom
                    ? `Shared by ${nameFor(row.delegatedFrom)}`
                    : "Stored on the team"}
                  {row.referenceBroken ? " · broken" : ""}
                </p>
                {row.referenceBroken && (
                  <p className="text-xs text-danger-500">
                    The source credential is gone or the member left. Re-share it, or store a
                    direct team credential.
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {row.referenceBroken && <Badge variant="danger">Broken</Badge>}
                {canMutate && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disconnect.isPending}
                    aria-label={`${removal.action} ${removal.target}`}
                    onClick={() => {
                      // Clear the previous attempt's refusal as the dialog
                      // opens: React Query holds `error` until the next mutate.
                      disconnect.reset();
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
          pending={disconnect.isPending}
          // One mutation serves every row, so opening a second row's dialog
          // would otherwise show the first row's refusal before any click.
          error={
            disconnect.error != null && disconnect.variables?.service === removing.service
              ? errorText(disconnect.error)
              : undefined
          }
          onConfirm={() =>
            disconnect.mutate(
              { service: removing.service, scope: "team", teamId: team.id },
              { onSuccess: () => setRemoving(null) },
            )
          }
        />
      )}
    </div>
  );
}
