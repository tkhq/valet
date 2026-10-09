import { useState } from "react";
import { useTeamOnePasswordStatus, useTeamOnePasswordToken } from "~/api/onepassword";
import { Badge, Button, ConfirmDialog, Dialog, DialogContent, ErrorRow, Input } from "~/components/primitives";
import { CardHeading, IntegrationCard } from "~/components/integrations/integration-card";
import { OnePasswordInstructions } from "~/components/integrations/onepassword-setup";

/**
 * The team's 1Password service account, as an integration row like every
 * other connection: Connect opens a dialog for the token. Mounted with the
 * team ID as key so a draft cannot move between teams. The dialog shows the
 * same setup steps as the personal and organization dialogs, because a team
 * admin in Valet can still be refused by 1Password.
 */
export function TeamOnePasswordToken({ teamId, teamName, canMutate }: {
  teamId: string; teamName: string; canMutate: boolean;
}) {
  const status = useTeamOnePasswordStatus(teamId);
  const mutation = useTeamOnePasswordToken(teamId);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [draft, setDraft] = useState("");
  const [failed, setFailed] = useState(false);
  const connected = status.data?.tokenConnected === true;

  function save(token: string | null, onDone: () => void) {
    setFailed(false);
    mutation.mutate(token, {
      onSuccess: () => { setDraft(""); onDone(); },
      onError: () => setFailed(true),
      onSettled: () => mutation.reset(),
    });
  }

  return <IntegrationCard>
    <CardHeading
      compact
      title="1Password"
      slug="onepassword"
      description={status.isError
        ? "Could not load the connection. Reload the page to try again."
        : "A service account for this team. Valet finds credentials in the vaults it can access."}
      state={status.isSuccess
        // The long fallback badge gives way on a phone so the row stays one line.
        ? <span className={connected ? undefined : "max-sm:hidden"}><Badge variant={connected ? "success" : "neutral"}>{connected ? "Connected" : "Uses the organization token"}</Badge></span>
        : undefined}
      right={canMutate && status.isSuccess ? <div className="flex items-center gap-1">
        {connected && <Button size="sm" variant="ghost" disabled={mutation.isPending}
          onClick={() => { setFailed(false); setDisconnecting(true); }}>Disconnect</Button>}
        <Button size="sm" variant="secondary" disabled={mutation.isPending} aria-label={connected ? "Replace token" : "Connect 1Password"}
          onClick={() => { setFailed(false); setConnecting(true); }}>{connected ? "Replace" : "Connect"}</Button>
      </div> : status.isSuccess ? <span className="text-xs text-muted">Team admin required</span> : undefined}
    />
    <Dialog open={connecting} onOpenChange={(open) => { setConnecting(open); if (!open) setDraft(""); }}>
      <DialogContent
        title={`Connect 1Password to ${teamName}`}
        description="Paste a 1Password service account token. Everyone on this team can use the vaults it can access."
      >
        <OnePasswordInstructions />
        <label className="text-sm">Service account token
          <Input type="password" autoComplete="new-password" value={draft} className="mt-1"
            onChange={(event) => setDraft(event.target.value)} />
        </label>
        {failed && <ErrorRow>Could not save the token. Check it and your team access, then try again.</ErrorRow>}
        <Button disabled={!draft.trim() || mutation.isPending} onClick={() => save(draft.trim(), () => setConnecting(false))}>
          {mutation.isPending ? "Connecting…" : "Connect token"}
        </Button>
      </DialogContent>
    </Dialog>
    <ConfirmDialog open={disconnecting} onOpenChange={setDisconnecting} title={`Disconnect 1Password from ${teamName}?`}
      description="Explicit team references will stop resolving. Automatic discovery can use the organization token again."
      confirmLabel="Disconnect" pendingLabel="Disconnecting…" pending={mutation.isPending}
      error={failed ? "Could not disconnect. Check your team access and try again." : undefined}
      onConfirm={() => save(null, () => setDisconnecting(false))} />
  </IntegrationCard>;
}
