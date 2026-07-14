/**
 * One credential service row inside a plugin card (Task 15 — connect
 * surface, manual token entry only; OAuth flows are deliberately out of
 * scope this phase). Connected: badge + Disconnect. Not connected: a
 * "Connect" button reveals a token textarea; the field label follows the
 * declared credential `type` (falls back to `connectLabel` when the plugin
 * supplies one) since this phase has no OAuth redirect to do the asking for it.
 */
import { useState } from "react";
import type { PluginServiceSummary } from "@valet/api/wire";
import { Badge, Button, Textarea } from "~/components/primitives";
import { useConnectCredential, useDisconnectCredential } from "~/api/integrations";

const TOKEN_FIELD_LABEL: Record<PluginServiceSummary["type"], string> = {
  api_key: "API key",
  oauth2: "Access token",
  bot_token: "Bot token",
  service_account: "Service account key",
};

export function ServiceRow({ service }: { service: PluginServiceSummary }) {
  const [connecting, setConnecting] = useState(false);
  const connect = useConnectCredential();
  const disconnect = useDisconnectCredential();

  async function handleDisconnect() {
    if (!confirm(`Disconnect ${service.service}?`)) return;
    await disconnect.mutateAsync(service.service);
  }

  return (
    <li className="px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-ink">{service.service}</span>
            {service.dynamic && (
              <Badge variant="accent" title="Actions for this service are discovered at connect time">
                dynamic
              </Badge>
            )}
            {service.connected ? (
              <Badge variant="success">Connected</Badge>
            ) : (
              <Badge variant="neutral">Not connected</Badge>
            )}
          </div>
          {service.connectLabel && <div className="mt-0.5 text-xs text-muted">{service.connectLabel}</div>}
        </div>

        {service.connected ? (
          <Button
            variant="danger"
            size="sm"
            onClick={() => void handleDisconnect()}
            disabled={disconnect.isPending}
          >
            {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
          </Button>
        ) : (
          !connecting && (
            <Button size="sm" onClick={() => setConnecting(true)}>
              Connect
            </Button>
          )
        )}
      </div>

      {connecting && !service.connected && (
        <ConnectForm
          service={service}
          onDone={() => setConnecting(false)}
          onCancel={() => setConnecting(false)}
        />
      )}
    </li>
  );
}

function ConnectForm({
  service,
  onDone,
  onCancel,
}: {
  service: PluginServiceSummary;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [token, setToken] = useState("");
  const connect = useConnectCredential();

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
      onDone();
    } catch {
      // useMutation surfaces the error in `connect.error`; the form stays open.
    }
  }

  return (
    <div className="mt-3 space-y-2">
      <label className="block text-xs font-medium text-muted" htmlFor={`token-${service.service}`}>
        {TOKEN_FIELD_LABEL[service.type]}
      </label>
      <Textarea
        id={`token-${service.service}`}
        rows={2}
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder={`Paste the ${TOKEN_FIELD_LABEL[service.type].toLowerCase()}…`}
        autoFocus
      />
      {connect.error && (
        <div className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-xs text-danger-600">
          {connect.error.message}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={connect.isPending}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void submit()} disabled={connect.isPending || !token.trim()}>
          {connect.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
