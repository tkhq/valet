import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import type { GetLinearConnectionResponse } from "@valet/api/wire";
import { useDisconnectLinear, useLinearConnection, useSaveLinearConnection } from "~/api/linear";
import { apiErrorMessage } from "~/api/policies";
import { Badge, Button, ConfirmDialog, ErrorRow, Input, LoadingRow } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { ServiceIcon } from "~/components/service-icon";

export const Route = createFileRoute("/settings/organization/linear")({ component: OrganizationLinearPage });

/** Where an admin manages the organization's Linear application after creation. */
const LINEAR_APPS_URL = "https://linear.app/settings/api/applications";

/**
 * Builds Linear's prefilled app creation form (documented at
 * https://linear.app/developers/oauth-app-manifests). It turns on the
 * client credentials grant and, when the deployment has a public HTTPS URL,
 * the app's webhook. Only public app metadata belongs in this URL.
 */
export function linearAppCreationUrl(setup: {
  redirectUri?: string;
  webhookUrl?: string;
  webhookResourceTypes?: string[];
}): string | undefined {
  if (!setup.redirectUri) return undefined;
  let callback: URL;
  try { callback = new URL(setup.redirectUri); } catch { return undefined; }
  if (callback.protocol !== "https:" && callback.protocol !== "http:") return undefined;
  const url = new URL("https://linear.app/settings/api/applications/new");
  const params = new URLSearchParams({
    distribution: "private",
    "display.description": "Connects your Linear workspace to Valet.",
    "developer.name": "Valet",
    "oauth.client_name": "Valet",
    "oauth.client_uri": callback.origin,
    "oauth.redirect_uris": callback.href,
  });
  params.append("oauth.grant_types", "authorization_code");
  params.append("oauth.grant_types", "client_credentials");
  if (setup.webhookUrl?.startsWith("https://") && setup.webhookResourceTypes?.length) {
    params.set("webhook.enabled", "true");
    params.set("webhook.url", setup.webhookUrl);
    for (const type of setup.webhookResourceTypes) params.append("webhook.resourceTypes", type);
  }
  url.search = params.toString();
  return url.href;
}

/**
 * Organization · Linear — the organization's native Linear integration,
 * modeled on the Slack page. Not connected: one box that links to a
 * prefilled app form and takes the app's client ID, client secret, and
 * webhook signing secret. Connect checks them with Linear and saves them.
 * Connected: a card with the Linear workspace and Disconnect.
 *
 * Personal Linear connections on the Integrations page stay separate: they
 * give one person's sessions Linear tools through MCP.
 */
export function OrganizationLinearPage() {
  const status = useLinearConnection();
  const data = status.data;
  return <Section title="Linear" description="Connect your organization’s Linear workspace. Workflows can then start when issues, comments, and projects change in Linear. People connect their own Linear accounts for tools on the Integrations page.">
    {status.isPending ? <LoadingRow label="Loading Linear connection…" />
      : status.isError || !data ? <ErrorRow>Could not load Linear setup. <button className="underline" onClick={() => void status.refetch()}>Retry</button></ErrorRow>
      : data.connected ? <ConnectedCard data={data} />
      : <SetupCards data={data} />}
  </Section>;
}

function SecretField({ id, label, hint, value, onChange, secret }: {
  id: string; label: string; hint: string; value: string; onChange: (value: string) => void; secret?: boolean;
}) {
  return <div className="space-y-1.5">
    <label htmlFor={id} className="text-sm font-medium text-ink">{label}</label>
    <Input id={id} required autoComplete={secret ? "new-password" : "off"} type={secret ? "password" : "text"}
      value={value} onChange={event => onChange(event.target.value)} />
    <p className="text-xs leading-relaxed text-muted">{hint}</p>
  </div>;
}

function SetupCards({ data }: { data: GetLinearConnectionResponse }) {
  const save = useSaveLinearConnection();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const createUrl = linearAppCreationUrl(data);
  const incomplete = !clientId.trim() || !clientSecret.trim() || !webhookSecret.trim();

  return <form className="-mx-4" onSubmit={event => {
      event.preventDefault();
      save.mutate({ clientId: clientId.trim(), clientSecret: clientSecret.trim(), webhookSecret: webhookSecret.trim() });
    }}>
    <div className="flex items-start gap-3 border-b border-line px-6 py-5">
      <ServiceIcon slug="linear" label="Linear" />
      <div className="min-w-0">
        <div className="font-display text-base text-ink">Connect Linear</div>
        <p className="mt-0.5 text-sm leading-relaxed text-muted">
          Create a Linear app from a prefilled form, then paste its three values here. Valet checks them with Linear before it saves anything.
        </p>
      </div>
    </div>

    {/* Step 1: create the app in Linear from a prefilled form. */}
    <div className="space-y-3 border-b border-line px-6 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm font-medium text-ink">1. Create the Linear app</div>
        {createUrl && <Button asChild variant="secondary" size="sm">
          <a href={createUrl} target="_blank" rel="noreferrer">Open Linear app creation</a>
        </Button>}
      </div>
      <p className="text-xs leading-relaxed text-muted">
        Valet fills in the name, callback URL, event webhook, and client credentials setting. Review them in Linear, then choose Create.
      </p>
      {data.webhookUrl
        ? <p className="text-xs text-muted">Linear delivers events to <span className="font-mono">{data.webhookUrl}</span>.</p>
        : <p className="rounded border border-amber-300 bg-amber-50/70 px-3 py-2 text-xs leading-relaxed text-ink dark:border-amber-700/60 dark:bg-amber-950/40">
          This deployment has no public HTTPS URL, and Linear delivers events only to one. Set VALET_PUBLIC_URL and reload this page before you create the app. Without it, the app connects but workflows never receive Linear events.
        </p>}
      {!createUrl && <p className="text-sm text-danger-500">
        App setup is unavailable. Ask your deployment admin to configure Valet’s public URL, then reload.
      </p>}
    </div>

    {/* Step 2: bring back the three values the app shows. */}
    <div className="space-y-4 px-6 py-5">
      <div className="text-sm font-medium text-ink">2. Paste the app’s values</div>
      <div className="grid gap-4 sm:grid-cols-2">
        <SecretField id="linear-client-id" label="Client ID" value={clientId} onChange={setClientId}
          hint="Shown on the app’s page in Linear." />
        <SecretField id="linear-client-secret" label="Client secret" value={clientSecret} onChange={setClientSecret} secret
          hint="Shown on the app’s page in Linear. Rotate it there if you lost it." />
        <div className="sm:col-span-2">
          <SecretField id="linear-webhook-secret" label="Webhook signing secret" value={webhookSecret} onChange={setWebhookSecret} secret
            hint="In the app’s webhook settings in Linear. Valet uses it to check that events come from Linear." />
        </div>
      </div>
    </div>

    <div className="flex flex-col items-start justify-between gap-4 border-t sm:flex-row sm:items-center border-line px-6 py-4">
      <p className="min-w-0 [overflow-wrap:anywhere] text-xs text-muted">{data.redirectUri && <>Redirect URI: <span className="font-mono">{data.redirectUri}</span></>}</p>
      <Button type="submit" disabled={save.isPending || incomplete}>
        {save.isPending ? "Checking with Linear…" : "Connect Linear"}
      </Button>
    </div>
    {save.error && <p className="border-t border-line px-6 py-3 text-sm text-danger-500">
      {apiErrorMessage(save.error)}
    </p>}
  </form>;
}

function ConnectedCard({ data }: { data: GetLinearConnectionResponse }) {
  const disconnect = useDisconnectLinear();
  const [confirm, setConfirm] = useState(false);
  return <div className="max-w-2xl space-y-3 rounded-md border border-line p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        <ServiceIcon slug="linear" label="Linear" />
        <div className="space-y-1">
          <div className="text-sm font-medium text-ink">{data.workspaceName ?? "Linear workspace"}</div>
          <a href={LINEAR_APPS_URL} target="_blank" rel="noreferrer" className="text-xs text-moss underline">Manage on Linear</a>
        </div>
      </div>
      <Badge variant={data.ready ? "success" : "warning"}>{data.ready ? "Connected" : "Needs reconnect"}</Badge>
    </div>
    {!data.ready && data.reason && <p className="text-xs leading-relaxed text-muted">{data.reason}</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="danger" size="sm" disabled={disconnect.isPending} onClick={() => { disconnect.reset(); setConfirm(true); }}>
        {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
      </Button>
    </div>
    <p className="text-xs text-muted">To use a different Linear app, disconnect, then connect again.</p>
    <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Disconnect Linear?"
      description="This deletes the organization’s saved Linear app credentials and token. Workflows stop starting from Linear activity. The app stays in Linear until you delete it there. Personal Linear connections stay available."
      confirmLabel="Disconnect" pendingLabel="Disconnecting…" pending={disconnect.isPending}
      error={disconnect.error ? apiErrorMessage(disconnect.error) : undefined}
      onConfirm={() => disconnect.mutate(undefined, { onSuccess: () => setConfirm(false) })} />
  </div>;
}
