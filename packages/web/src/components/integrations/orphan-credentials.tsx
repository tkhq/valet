import { useState } from "react";
import type { CredentialSummary, PluginSummary } from "@valet/api/wire";
import { useCredentials, useDisconnectCredential } from "~/api/integrations";
import { Badge, Button, ConfirmDialog } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { errorText } from "~/lib/error-text";
import { CardHeading, IntegrationCard, IntegrationList } from "./integration-card";
import { displayName } from "./display-name";

/** `onepassword` is the personal service-account token itself, managed in
 * Settings → Connected accounts, not a service credential. */
const RESERVED = new Set(["onepassword"]);

/** The caller's credentials that no listed plugin service covers, such as
 * one left behind by a removed plugin. */
export function orphanCredentials(credentials: CredentialSummary[], plugins: PluginSummary[]): CredentialSummary[] {
  const listed = new Set(plugins.flatMap((plugin) => plugin.services.map((service) => service.service)));
  return credentials.filter((cred) => !listed.has(cred.service) && !RESERVED.has(cred.service));
}

/** A reference-backed row stores only the `op://` reference, so revoking it
 * leaves the 1Password item itself in place. */
function revokeDescription(cred: CredentialSummary): string {
  const service = displayName(cred.service);
  const removed = cred.onepasswordRef
    ? `Valet deletes its stored ${service} reference. The item in 1Password is not deleted.`
    : `Valet deletes the stored ${service} credential.`;
  return `${removed} Teams you shared it with lose it too.`;
}

/**
 * Saved credentials that no row above can show. Integrations is the one
 * place a person manages service credentials, so a credential whose plugin
 * is gone still needs a Revoke control here. Renders nothing when every
 * credential has a row.
 */
export function OrphanCredentials({ plugins }: { plugins: PluginSummary[] }) {
  const credentialsQ = useCredentials();
  const disconnect = useDisconnectCredential();
  // The row being confirmed: the rows share one dialog.
  const [confirmRevoke, setConfirmRevoke] = useState<CredentialSummary | null>(null);
  const orphans = orphanCredentials(credentialsQ.data?.credentials ?? [], plugins);
  if (orphans.length === 0) return null;

  return (
    <Section title="Other saved credentials" description="No installed integration uses these. Revoke the ones you no longer need.">
      <IntegrationList label="Other saved credentials">
        {orphans.map((cred) => (
          <IntegrationCard key={cred.service}>
            <CardHeading
              title={displayName(cred.service)}
              slug={cred.service}
              state={
                <>
                  {cred.refreshFailedAt && <Badge variant="danger">Refresh failed</Badge>}
                  {cred.onepasswordRef && <Badge variant="accent">{cred.onepasswordRef}</Badge>}
                </>
              }
              meta={cred.type}
              right={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Revoke ${displayName(cred.service)}`}
                  disabled={disconnect.isPending}
                  onClick={() => {
                    // Clear the previous row's refusal as this dialog opens.
                    disconnect.reset();
                    setConfirmRevoke(cred);
                  }}
                >
                  Revoke
                </Button>
              }
            />
          </IntegrationCard>
        ))}
      </IntegrationList>
      {confirmRevoke && (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setConfirmRevoke(null);
          }}
          title={`Revoke ${displayName(confirmRevoke.service)}?`}
          description={revokeDescription(confirmRevoke)}
          confirmLabel="Revoke"
          pendingLabel="Revoking…"
          pending={disconnect.isPending}
          // The rows share one mutation, so a failure belongs to the row it
          // was fired for.
          error={
            disconnect.error != null && disconnect.variables?.service === confirmRevoke.service
              ? errorText(disconnect.error)
              : undefined
          }
          onConfirm={() =>
            disconnect.mutate({ service: confirmRevoke.service }, { onSuccess: () => setConfirmRevoke(null) })
          }
        />
      )}
    </Section>
  );
}
