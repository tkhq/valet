import { useEffect, useState } from "react";
import { errorText } from "~/lib/error-text";
import { useConnectCredential, useDisconnectCredential } from "~/api/integrations";
import { useOnePasswordSettings, usePutOnePasswordSettings } from "~/api/onepassword";
import { useOrg } from "~/api/settings";
import { Badge, Button, Input, Spinner, Switch } from "~/components/primitives";
import { FieldRow } from "~/components/settings/field-row";
import { Section } from "~/components/settings/section";
import { ServiceIcon } from "~/components/service-icon";

/**
 * Organization · 1Password: the org service-account token (admin), the
 * allow-personal toggle (admin), and the personal token (when allowed).
 * Reference credentials are resolved from the vaults by item title, so
 * there is nothing to list here.
 */
export function OnePasswordPanel() {
  const orgQ = useOrg();
  const settingsQ = useOnePasswordSettings();
  const isAdmin = orgQ.data?.callerRole === "admin";

  return (
    <Section
      title="1Password"
      description="Connect a service account, and agents read credentials from your vaults instead of you pasting them."
    >
      <div className="flex items-start gap-3 py-4">
        <ServiceIcon slug="1password" label="1Password" />
        <p className="text-sm text-muted">
          Connect a service-account token, then attach an item to Linear or any other
          service. The secret stays in 1Password.
        </p>
      </div>

      {settingsQ.isLoading && (
        <div className="flex items-center gap-2 py-2 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {settingsQ.error && (
        <p className="py-2 text-sm text-danger-500">Failed to load 1Password settings.</p>
      )}

      {settingsQ.data && (
        <>
          {isAdmin && (
            <>
              <OrgTokenRow connected={settingsQ.data.orgTokenConnected} />
              <FieldRow
                label="Allow personal tokens"
                hint="Let members connect their own 1Password service account token."
              >
                <AllowPersonalSwitch checked={settingsQ.data.allowPersonal} />
              </FieldRow>
            </>
          )}
          {settingsQ.data.allowPersonal && (
            <PersonalTokenRow connected={settingsQ.data.personalTokenConnected} />
          )}
          {!isAdmin && !settingsQ.data.allowPersonal && !settingsQ.data.orgTokenConnected && (
            <p className="py-2 text-sm text-muted">
              An admin can connect an organization 1Password token on this page.
            </p>
          )}
        </>
      )}
    </Section>
  );
}

function AllowPersonalSwitch({ checked }: { checked: boolean }) {
  const putSettings = usePutOnePasswordSettings();
  return (
    <>
      <Switch
        checked={checked}
        onCheckedChange={(next) => putSettings.mutate({ allowPersonal: next })}
        aria-label="Allow personal tokens"
      />
      {putSettings.error && (
        <p className="mt-1 text-xs text-danger-500">
          {errorText(putSettings.error, "Couldn't save the setting.")}
        </p>
      )}
    </>
  );
}

function OrgTokenRow({ connected }: { connected: boolean }) {
  const connect = useConnectCredential();
  const disconnect = useDisconnectCredential();
  const [token, setToken] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);

  async function saveToken() {
    const trimmed = token.trim();
    if (!trimmed) return;
    setTokenError(null);
    try {
      await connect.mutateAsync({
        service: "onepassword",
        body: { type: "service_account", apiKey: trimmed, scope: "org" },
      });
      setToken("");
    } catch (err) {
      setTokenError(errorText(err, "Couldn't save the organization token."));
    }
  }

  return (
    <FieldRow
      label="Organization token"
      hint="A 1Password service account token shared across the organization."
    >
      <TokenFields
        connected={connected}
        token={token}
        onTokenChange={setToken}
        inputLabel="Organization 1Password token"
        error={tokenError}
        saving={connect.isPending}
        removing={disconnect.isPending}
        onSave={() => void saveToken()}
        onRemove={() => {
          if (!confirm("Remove the organization 1Password token?")) return;
          disconnect.mutate({ service: "onepassword", scope: "org" });
        }}
        removeLabel="Remove token"
      />
    </FieldRow>
  );
}

function PersonalTokenRow({ connected }: { connected: boolean }) {
  const connect = useConnectCredential();
  const disconnect = useDisconnectCredential();
  const [token, setToken] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);

  async function saveToken() {
    const trimmed = token.trim();
    if (!trimmed) return;
    setTokenError(null);
    try {
      await connect.mutateAsync({
        service: "onepassword",
        body: { type: "service_account", apiKey: trimmed },
      });
      setToken("");
    } catch (err) {
      setTokenError(errorText(err, "Couldn't save the 1Password token."));
    }
  }

  return (
    <FieldRow
      label="1Password personal token"
      hint="Lets you reference items from your own 1Password vaults."
    >
      <TokenFields
        connected={connected}
        token={token}
        onTokenChange={setToken}
        inputLabel="1Password personal token"
        error={tokenError}
        saving={connect.isPending}
        removing={disconnect.isPending}
        onSave={() => void saveToken()}
        onRemove={() => {
          if (!confirm("Remove your personal 1Password token?")) return;
          disconnect.mutate({ service: "onepassword" });
        }}
        removeLabel="Remove token"
      />
    </FieldRow>
  );
}

function TokenFields({
  connected,
  token,
  onTokenChange,
  inputLabel,
  error,
  saving,
  removing,
  onSave,
  onRemove,
  removeLabel,
}: {
  connected: boolean;
  token: string;
  onTokenChange: (value: string) => void;
  inputLabel: string;
  error: string | null;
  saving: boolean;
  removing: boolean;
  onSave: () => void;
  onRemove: () => void;
  removeLabel: string;
}) {
  // A connected token is state, not a form. Two always-visible password
  // boxes with the same placeholder read as "paste your token twice"; the
  // input now appears only when there is a reason to type into one.
  const [entering, setEntering] = useState(!connected);
  // `connected` flips after a save or a remove; the mount value alone would
  // leave the form open after connecting, or the badge up after removing.
  useEffect(() => {
    setEntering(!connected);
  }, [connected]);

  if (connected && !entering) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="success">Connected</Badge>
        <Button type="button" variant="ghost" size="sm" onClick={() => setEntering(true)}>
          Replace
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={removing} onClick={onRemove}>
          {removing ? "Removing…" : removeLabel}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          type="password"
          aria-label={inputLabel}
          value={token}
          onChange={(e) => onTokenChange(e.target.value)}
          placeholder="ops_…"
        />
        <Button type="button" size="sm" disabled={saving || !token.trim()} onClick={onSave}>
          {saving ? "Saving…" : "Connect"}
        </Button>
      </div>
      {error && <p className="text-xs text-danger-500">{error}</p>}
      {connected && (
        <Button type="button" variant="ghost" size="sm" onClick={() => setEntering(false)}>
          Cancel
        </Button>
      )}
    </div>
  );
}
