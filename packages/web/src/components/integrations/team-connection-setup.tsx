import { IntegrationDetails } from "./integration-details";
import { useEffect, useState, type ReactNode } from "react";
import type { PluginServiceSummary } from "@valet/api/wire";
import { useConnectCredential, useCredentials, usePlugins } from "~/api/integrations";
import { Button, Dialog, DialogContent, ErrorRow, Textarea } from "~/components/primitives";
import { SearchInput } from "~/components/search-input";
import { SubSection } from "~/components/settings/section";
import { CardHeading, CardFooter, IntegrationCard } from "./integration-card";
import { errorText } from "~/lib/error-text";
import { displayName, pluginDisplayName } from "./display-name";

/** Connect an account intended for one team. Organization connections live in Organization settings. */
export function TeamConnectionSetup({ teamId, canManage, children }: {
  teamId: string; canManage: boolean;
  /** Team connections with their own card, such as 1Password, shown first in the grid. */
  children?: ReactNode;
}) {
  // The team catalog reports effective credentials for this team. In
  // particular, an org-managed Slack bot is connected for team workflows
  // even though the team has no Slack credential row of its own.
  const plugins = usePlugins(teamId);
  const credentials = useCredentials("team", { teamId });
  const [selected, setSelected] = useState<PluginServiceSummary | null>(null);
  const [query, setQuery] = useState("");
  const canConnect = canManage && !!credentials.data && !credentials.error && !plugins.error;
  useEffect(() => {
    if (!canConnect) setSelected(null);
  }, [canConnect]);
  const services = [...new Map((plugins.error ? [] : plugins.data?.plugins ?? [])
    .flatMap((p) => p.services).map((s) => [s.service, s])).values()];
  const occupied = new Set(credentials.data?.credentials.map((c) => c.service));
  const choices = services.filter((s) => s.configKeys.length > 0 &&
    s.service !== "slack-user" && s.service !== "slack" && s.service !== "github" &&
    // `onepassword` is a service-account TOKEN, not one service's credential.
    // The team list skips reserved rows, so an already-connected token never
    // reads as occupied here, and this dialog's create-only promise does not
    // reach `mutateTeamOnePassword`, which upserts. It would replace a live
    // team token with no 409 and no confirmation. `TeamOnePasswordToken` is
    // the control for it, and the team Integrations page renders it.
    s.service !== "onepassword" && s.connect !== "org" && !occupied.has(s.service))
    .sort((a, b) => displayName(a.service).localeCompare(displayName(b.service)));

  const available = choices.filter((s) => displayName(s.service).toLowerCase().includes(query.toLowerCase()));
  return <div className="space-y-6">
    <SubSection title="Connect a service" description="Connect an account intended for this team."
      actions={<div className="w-56"><SearchInput value={query} onSettled={setQuery} placeholder="Search integrations…" /></div>}>
      {credentials.error && <ErrorRow>Could not check team connections. Reload the page.</ErrorRow>}
      {!plugins.isLoading && !plugins.error && available.length === 0 && <p className="text-sm text-muted">No available integrations match.</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {children}
        {available.map((service) => {
          const blocked = service.connect === "unconfigured" && service.connectBlockedBy !== "org";
          return <IntegrationCard key={service.service}>
            <CardHeading title={displayName(service.service)} slug={service.iconSlug ?? service.service}
              description={blocked ? "Ask an organization admin to configure OAuth for this service." : "Connect an account this team can use."} />
            <CardFooter meta={blocked ? undefined : canManage ? "Team connection" : "Team admin required"}
              right={<Button size="sm" variant="secondary" disabled={blocked || !canConnect} onClick={() => setSelected(service)}>{`Connect ${displayName(service.service)}`}</Button>} />
          </IntegrationCard>;
        })}
      </div>
      {canConnect && selected && <TeamConnectionDialog key={selected.service} teamId={teamId} service={selected} onClose={() => setSelected(null)} />}
    </SubSection>
    <SubSection title="Tools and skills" description="Installed capabilities for this team. Connection details appear above.">
      {plugins.error && <ErrorRow>Could not load plugin details. Reload the page to try again.</ErrorRow>}
      {!plugins.error && plugins.data?.plugins.filter((plugin) => plugin.services.length > 0).map((plugin) => <div key={plugin.name}>
        <h4 className="mt-4 text-sm font-medium">{pluginDisplayName(plugin)}</h4>
        <IntegrationDetails plugin={plugin} />
      </div>)}
    </SubSection>
  </div>;
}

function TeamConnectionDialog({ teamId, service, onClose }: {
  teamId: string; service: PluginServiceSummary; onClose: () => void;
}) {
  const connect = useConnectCredential();
  const [token, setToken] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const oauth = service.connect === "oauth" && service.service !== "github";
  return <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
    <DialogContent title={`Connect ${displayName(service.service)} to this team`}
      description={oauth ? "Sign in to the account intended for this team. Everyone on the team can use the permissions you grant." : "Paste a token for the account intended for this team. Everyone on this team can use its permissions."}>
      {!oauth && <label className="text-sm">Team account token
        <Textarea value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} />
      </label>}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        I authorize team members to use this account’s permissions.
      </label>
      <p className="text-xs text-muted">One connection per service. Disconnect the existing account before replacing it.</p>
      {connect.error && <ErrorRow>{errorText(connect.error)}</ErrorRow>}
      <Button disabled={(!oauth && !token.trim()) || !confirmed || connect.isPending} onClick={() => {
        if (oauth) {
          window.location.href = `/api/credentials/${encodeURIComponent(service.service)}/connect?scope=team&teamId=${encodeURIComponent(teamId)}`;
          return;
        }
        connect.mutate({ service: service.service, body: {
          scope: "team", teamId, type: service.type, createOnly: true,
          ...(service.type === "api_key" ? { apiKey: token.trim() } : { accessToken: token.trim() }),
        } }, { onSuccess: onClose });
      }}>{connect.isPending ? "Connecting…" : oauth ? `Continue to ${displayName(service.service)}` : "Connect team account"}</Button>
    </DialogContent>
  </Dialog>;
}
