/**
 * Rows for `/integrations` (facelift of the Task-15 connect surface).
 *
 * One hairline-separated row per plugin, in the settings idiom — no nested
 * cards. The right edge carries a mono "reach" meta line (tool count /
 * "tools load on connect" / "no key needed") plus the connect state; the
 * token-entry reveal is the page's one contained element, mirroring the
 * enable-organizations card's invitation treatment.
 *
 * OAuth connect for services declaring `oauth` metadata; manual token entry
 * remains the fallback. The submit action is named "Connect" end to end
 * (button → form submit), never "Save": the action keeps one name through
 * the whole flow.
 */
import { useState } from "react";
import type { PluginServiceSummary, PluginSummary } from "@valet/api/wire";
import { Badge, Button, Textarea } from "~/components/primitives";
import { useConnectCredential, useDisconnectCredential } from "~/api/integrations";
import { displayName } from "./display-name";

const TOKEN_FIELD_LABEL: Record<PluginServiceSummary["type"], string> = {
  api_key: "API key",
  oauth2: "Access token",
  bot_token: "Bot token",
  service_account: "Service account key",
};

/** True when the plugin belongs in the Services group (something the assistant reaches out to). */
export function isService(plugin: PluginSummary): boolean {
  return plugin.actionCount > 0 || plugin.dynamic === true || plugin.services.length > 0;
}

function reachMeta(plugin: PluginSummary): string | null {
  if (plugin.actionCount > 0) {
    return `${plugin.actionCount} tool${plugin.actionCount === 1 ? "" : "s"}`;
  }
  if (plugin.dynamic) {
    // Connected dynamic services report a live-resolved count (`toolCount`,
    // TTL-cached server-side); before connecting — or when resolution timed
    // out — fall back to the static copy.
    const resolved = plugin.services.find((s) => s.toolCount !== undefined)?.toolCount;
    if (resolved !== undefined) {
      return `${resolved} tool${resolved === 1 ? "" : "s"}`;
    }
    return plugin.services.length === 0 ? "no key needed" : "tools load on connect";
  }
  return null;
}

export function IntegrationRow({ plugin }: { plugin: PluginSummary }) {
  const meta = reachMeta(plugin);
  const single = plugin.services.length === 1 ? plugin.services[0] : undefined;

  return (
    <li className="py-4">
      {single ? (
        <ServiceBlock
          service={single}
          title={displayName(plugin.name)}
          description={plugin.description}
          meta={meta}
        />
      ) : (
        <>
          <RowHeading title={displayName(plugin.name)} description={plugin.description} meta={meta} />
          {/* Multi-service plugins (none in the current fleet, but the manifest
              allows it): each credential service gets its own quiet sub-row. */}
          {plugin.services.length > 1 && (
            <ul className="mt-2 space-y-2 border-l border-line pl-4">
              {plugin.services.map((service) => (
                <li key={service.service}>
                  <ServiceBlock service={service} title={displayName(service.service)} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </li>
  );
}

export function BuiltInRow({ plugin }: { plugin: PluginSummary }) {
  return (
    <li className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="text-sm text-ink">{displayName(plugin.name)}</div>
        {plugin.description && <p className="mt-0.5 text-xs text-muted">{plugin.description}</p>}
      </div>
      <span className="shrink-0 font-mono text-xs text-muted">built in</span>
    </li>
  );
}

function RowHeading({
  title,
  description,
  meta,
  right,
}: {
  title: string;
  description?: string;
  meta?: string | null;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink">{title}</div>
        {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {meta && <span className="font-mono text-xs text-muted">{meta}</span>}
        {right}
      </div>
    </div>
  );
}

/** A service's heading + connect state, owning its own token-reveal state. */
function ServiceBlock({
  service,
  title,
  description,
  meta,
}: {
  service: PluginServiceSummary;
  title: string;
  description?: string;
  meta?: string | null;
}) {
  const [revealed, setRevealed] = useState(false);
  const disconnect = useDisconnectCredential();

  const right = service.connected ? (
    <span className="flex items-center gap-2">
      <Badge variant="success">Connected</Badge>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          if (!confirm(`Disconnect ${title}?`)) return;
          void disconnect.mutateAsync({ service: service.service });
        }}
        disabled={disconnect.isPending}
      >
        {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
      </Button>
    </span>
  ) : service.connect === "oauth" ? (
    <Button size="sm" asChild>
      <a href={`/api/credentials/${encodeURIComponent(service.service)}/connect`}>Connect</a>
    </Button>
  ) : (
    <Button size="sm" onClick={() => setRevealed((r) => !r)}>
      Connect
    </Button>
  );

  return (
    <>
      <RowHeading title={title} description={description} meta={meta} right={right} />
      {!service.connected && service.connect === "oauth" && (
        <button
          type="button"
          className="mt-1 text-xs text-muted underline-offset-2 hover:underline"
          onClick={() => setRevealed((r) => !r)}
        >
          Enter token manually
        </button>
      )}
      {revealed && !service.connected && (
        <ConnectForm service={service} onClose={() => setRevealed(false)} />
      )}
    </>
  );
}

function ConnectForm({
  service,
  onClose,
}: {
  service: PluginServiceSummary;
  onClose: () => void;
}) {
  const [token, setToken] = useState("");
  const connect = useConnectCredential();
  const fieldLabel = TOKEN_FIELD_LABEL[service.type];

  async function submit() {
    const trimmed = token.trim();
    if (!trimmed) return;
    try {
      await connect.mutateAsync({
        service: service.service,
        body:
          service.type === "api_key"
            ? { type: service.type, apiKey: trimmed }
            : { type: service.type, accessToken: trimmed },
      });
      setToken("");
      onClose();
    } catch {
      // useMutation surfaces the error via `connect.error`; the form stays open.
    }
  }

  return (
    <div className="mt-3 space-y-2 rounded-md border border-line bg-ink-wash p-4">
      {service.connectLabel && <p className="text-xs text-muted">{service.connectLabel}</p>}
      <label className="block text-xs font-medium text-ink" htmlFor={`token-${service.service}`}>
        {fieldLabel}
      </label>
      <Textarea
        id={`token-${service.service}`}
        rows={2}
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder={`Paste the ${fieldLabel.toLowerCase()}…`}
        autoFocus
      />
      {connect.error && (
        <div className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-xs text-danger-600">
          {connect.error.message}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={connect.isPending}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void submit()} disabled={connect.isPending || !token.trim()}>
          {connect.isPending ? "Connecting…" : "Connect"}
        </Button>
      </div>
    </div>
  );
}
