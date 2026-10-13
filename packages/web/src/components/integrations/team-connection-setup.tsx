import { IntegrationDetails } from "./integration-details";
import { useEffect, useState, type ReactNode } from "react";
import type { PluginServiceSummary } from "@valet/api/wire";
import { useConnectCredential, useCredentials, usePlugins } from "~/api/integrations";
import { Button, Dialog, DialogContent, ErrorRow, Textarea } from "~/components/primitives";
import { SearchInput } from "~/components/search-input";
import { Section } from "~/components/settings/section";
import { CardHeading, IntegrationCard, IntegrationList } from "./integration-card";
import { errorText } from "~/lib/error-text";
import { displayName, pluginDisplayName } from "./display-name";

/** Connect an account intended for one team. Organization connections live in Organization settings. */
export function TeamConnectionSetup({ teamId, canManage, children }: {
  teamId: string; canManage: boolean;
  /** Team connections with their own row, such as 1Password, shown first in the list. */
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
  const withTools = plugins.error ? [] : (plugins.data?.plugins ?? []).filter((plugin) => plugin.services.length > 0);
  return <>
    <div className="space-y-3">
      <div className="ml-auto w-full sm:w-56"><SearchInput value={query} onSettled={setQuery} placeholder="Search integrations…" aria-label="Search integrations" /></div>
      <Section title="Available" description="Connect an account intended for this team.">
        {credentials.error && <ErrorRow>Could not check team connections. Reload the page.</ErrorRow>}
        <IntegrationList label="Available">
          {children}
          {available.map((service) => {
            const blocked = service.connect === "unconfigured" && service.connectBlockedBy !== "org";
            const reason = blocked ? "Ask an organization admin to configure OAuth for this service." : canManage ? undefined : "Team admin required";
            const label = blocked ? "Set up" : "Connect";
            const name = displayName(service.service);
            return <IntegrationCard key={service.service}>
              {/* The accessible name starts with the visible label (WCAG
                  2.5.3), and the reason stays on screen at every width. */}
              <CardHeading compact title={name} slug={service.iconSlug ?? service.service}
                description={reason} phoneNote={reason}
                right={<Button size="sm" variant="secondary" disabled={blocked || !canConnect} aria-label={`${label} ${name}`} title={reason} onClick={() => setSelected(service)}>{label}</Button>} />
            </IntegrationCard>;
          })}
        </IntegrationList>
        {!plugins.isLoading && !plugins.error && available.length === 0 && <p className="text-sm text-muted">No available integrations match.</p>}
      </Section>
    </div>
    {canConnect && selected && <TeamConnectionDialog key={selected.service} teamId={teamId} service={selected} onClose={() => setSelected(null)} />}
    <Section title="Tools and skills" description="Installed capabilities for this team.">
      {plugins.error && <ErrorRow>Could not load plugin details. Reload the page to try again.</ErrorRow>}
      {/* Collapsed: a list of every plugin's tools would bury the
          connections above it. */}
      {withTools.length > 0 && <details className="group">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
          <span className="transition-transform group-open:rotate-90" aria-hidden>›</span>
          {`Show the tools of ${withTools.length} ${withTools.length === 1 ? "integration" : "integrations"}`}
        </summary>
        <IntegrationList label="Tools and skills">
          {withTools.map((plugin) => <IntegrationCard key={plugin.name}>
            <CardHeading title={pluginDisplayName(plugin)} slug={plugin.services[0]?.iconSlug ?? plugin.name} description={plugin.description} />
            <IntegrationDetails plugin={plugin} />
          </IntegrationCard>)}
        </IntegrationList>
      </details>}
    </Section>
  </>;
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
