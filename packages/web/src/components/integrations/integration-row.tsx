/**
 * Cards for `/integrations` (two-column facelift of the Task-15 connect
 * surface).
 *
 * One tile per plugin: a `ServiceMark`, name + connection state, the
 * description, and a footer with the mono "reach" meta (tool count /
 * "tools load on connect" / "no key needed") and the connect controls.
 * The token-entry reveal expands INSIDE the tile so connecting never
 * navigates away. Built-in plugins get quieter wash tiles — present but
 * visibly not asking anything of you.
 *
 * OAuth connect for services declaring `oauth` metadata; manual token
 * entry remains the fallback. The submit action is named "Connect" end to
 * end (button → form submit), never "Save".
 */
import { useState } from "react";
import type { PluginServiceSummary, PluginSummary } from "@valet/api/wire";
import { Badge, Button, Textarea } from "~/components/primitives";
import { useConnectCredential, useDisconnectCredential } from "~/api/integrations";
import { useConnectGithub } from "~/api/repos";
import { displayName } from "./display-name";
import { ServiceMark } from "./service-mark";

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

// ── Tiles ────────────────────────────────────────────────────────────────

export function IntegrationRow({ plugin }: { plugin: PluginSummary }) {
  const meta = reachMeta(plugin);
  const single = plugin.services.length === 1 ? plugin.services[0] : undefined;

  return (
    <div className="flex flex-col rounded-lg border border-line bg-paper p-4 transition-shadow hover:shadow-sm">
      {single ? (
        <ServiceBlock
          service={single}
          title={displayName(plugin.name)}
          markId={plugin.name}
          description={plugin.description}
          meta={meta}
        />
      ) : (
        <>
          <CardHeading
            title={displayName(plugin.name)}
            markId={plugin.name}
            description={plugin.description}
          />
          <CardFooter meta={meta} />
          {/* Multi-service plugins (none in the current fleet, but the manifest
              allows it): each credential service gets its own quiet sub-row. */}
          {plugin.services.length > 1 && (
            <ul className="mt-3 space-y-3 border-t border-line pt-3">
              {plugin.services.map((service) => (
                <li key={service.service}>
                  <ServiceBlock
                    service={service}
                    title={displayName(service.service)}
                    markId={service.service}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export function BuiltInRow({ plugin }: { plugin: PluginSummary }) {
  return (
    <div className="flex items-start gap-3 rounded-lg bg-ink-wash p-4">
      <ServiceMark id={plugin.name} quiet />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-ink">{displayName(plugin.name)}</div>
        {plugin.description && (
          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted">
            {plugin.description}
          </p>
        )}
      </div>
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted">
        built in
      </span>
    </div>
  );
}

function CardHeading({
  title,
  markId,
  description,
  state,
}: {
  title: string;
  markId: string;
  description?: string;
  state?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <ServiceMark id={markId} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-ink">{title}</span>
          {state}
        </div>
        {description && (
          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted">{description}</p>
        )}
      </div>
    </div>
  );
}

function CardFooter({ meta, right }: { meta?: string | null; right?: React.ReactNode }) {
  return (
    <div className="mt-auto flex items-center justify-between gap-3 pt-4">
      <span className="font-mono text-xs text-muted">{meta ?? ""}</span>
      {right}
    </div>
  );
}

/** A service's tile content + connect state, owning its own token-reveal state. */
function ServiceBlock({
  service,
  title,
  markId,
  description,
  meta,
}: {
  service: PluginServiceSummary;
  title: string;
  markId: string;
  description?: string;
  meta?: string | null;
}) {
  const [revealed, setRevealed] = useState(false);
  const disconnect = useDisconnectCredential();
  // GitHub connects through the org's GitHub App OAuth (POST
  // /api/me/github/connect → GitHub authorize → callback saves the user
  // credential) — not the generic per-service token flow. The manifest
  // declares no oauth metadata for github on purpose, so without this the
  // card fell back to manual token paste.
  const isGithub = service.service === "github";
  const connectGithub = useConnectGithub();

  async function startGithubOauth() {
    try {
      const res = await connectGithub.mutateAsync();
      window.location.href = res.url;
    } catch {
      // Error (e.g. no App configured) surfaces via connectGithub.error.
    }
  }

  const controls = service.connected ? (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        if (!confirm(`Disconnect ${title}?`)) return;
        void disconnect.mutateAsync(service.service);
      }}
      disabled={disconnect.isPending}
    >
      {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
    </Button>
  ) : isGithub ? (
    <span className="flex items-center gap-3">
      <button
        type="button"
        className="text-xs text-muted underline-offset-2 hover:underline"
        onClick={() => setRevealed((r) => !r)}
      >
        Enter token manually
      </button>
      <Button size="sm" onClick={() => void startGithubOauth()} disabled={connectGithub.isPending}>
        {connectGithub.isPending ? "Connecting…" : "Connect"}
      </Button>
    </span>
  ) : service.connect === "oauth" ? (
    <span className="flex items-center gap-3">
      <button
        type="button"
        className="text-xs text-muted underline-offset-2 hover:underline"
        onClick={() => setRevealed((r) => !r)}
      >
        Enter token manually
      </button>
      <Button size="sm" asChild>
        <a href={`/api/credentials/${encodeURIComponent(service.service)}/connect`}>Connect</a>
      </Button>
    </span>
  ) : (
    <Button size="sm" onClick={() => setRevealed((r) => !r)}>
      Connect
    </Button>
  );

  return (
    <>
      <CardHeading
        title={title}
        markId={markId}
        description={description}
        state={service.connected ? <Badge variant="success">Connected</Badge> : undefined}
      />
      <CardFooter meta={meta} right={controls} />
      {isGithub && connectGithub.error && (
        <p className="mt-2 text-xs text-danger-500">{connectGithub.error.message}</p>
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
