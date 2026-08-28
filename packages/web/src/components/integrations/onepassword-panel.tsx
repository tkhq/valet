import { useState } from "react";
import type { CredentialKind, CredentialSummary } from "@valet/api/wire";
import { apiErrorMessage } from "~/api/client";
import { useConnectCredential, useCredentials, useDisconnectCredential } from "~/api/integrations";
import { useOnePasswordSettings, usePutOnePasswordSettings } from "~/api/onepassword";
import { useOrg } from "~/api/settings";
import { Badge, Button, Input, Label, Spinner, Switch } from "~/components/primitives";
import { FieldRow } from "~/components/settings/field-row";
import { OnePasswordPicker, type OnePasswordComposedReference } from "~/components/settings/onepassword-picker";
import { Section } from "~/components/settings/section";
import { ServiceIcon } from "~/components/service-icon";

/**
 * 1Password on `/integrations`. One home for the org token, the personal
 * token, and `op://` reference credentials. Organization · 1Password and
 * You · Connected accounts no longer carry this UI.
 */
export function OnePasswordPanel() {
  const orgQ = useOrg();
  const settingsQ = useOnePasswordSettings();
  const isAdmin = orgQ.data?.callerRole === "admin";

  return (
    <Section
      title="1Password"
      description="Resolve a credential from a vault instead of pasting the secret."
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
          <ReferenceList isAdmin={isAdmin} />
          <AddFromOnePassword
            allowPersonal={settingsQ.data.allowPersonal}
            orgTokenConnected={settingsQ.data.orgTokenConnected}
            isAdmin={isAdmin}
          />
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
          {apiErrorMessage(putSettings.error, "Couldn't save the setting.")}
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
      setTokenError(apiErrorMessage(err, "Couldn't save the organization token."));
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
      setTokenError(apiErrorMessage(err, "Couldn't save the 1Password token."));
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
  return (
    <div className="space-y-2">
      {connected && <Badge variant="success">Connected</Badge>}
      <div className="flex gap-2">
        <Input
          type="password"
          aria-label={inputLabel}
          value={token}
          onChange={(e) => onTokenChange(e.target.value)}
          placeholder="1Password service account token"
        />
        <Button type="button" size="sm" disabled={saving || !token.trim()} onClick={onSave}>
          {saving ? "Saving…" : connected ? "Rotate" : "Save"}
        </Button>
      </div>
      {error && <p className="text-xs text-danger-500">{error}</p>}
      {connected && (
        <Button type="button" variant="ghost" size="sm" disabled={removing} onClick={onRemove}>
          {removing ? "Removing…" : removeLabel}
        </Button>
      )}
    </div>
  );
}

function isReference(c: CredentialSummary): boolean {
  return c.service !== "onepassword" && Boolean(c.onepasswordRef);
}

function ReferenceList({ isAdmin }: { isAdmin: boolean }) {
  const userQ = useCredentials("user");
  const orgQ = useCredentials("org", { enabled: isAdmin });
  const disconnect = useDisconnectCredential();

  const userRefs = (userQ.data?.credentials ?? []).filter(isReference);
  const orgRefs = isAdmin ? (orgQ.data?.credentials ?? []).filter(isReference) : [];
  const loading = userQ.isLoading || (isAdmin && orgQ.isLoading);
  const error = userQ.error || (isAdmin ? orgQ.error : null);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-2 text-sm text-muted">
        <Spinner size={14} /> Loading…
      </div>
    );
  }
  if (error) {
    return <p className="py-2 text-sm text-danger-500">Failed to load credentials.</p>;
  }
  if (userRefs.length === 0 && orgRefs.length === 0) {
    return <p className="py-2 text-sm text-muted">No 1Password reference credentials yet.</p>;
  }

  return (
    <div className="space-y-2 py-2">
      {orgRefs.map((cred) => (
        <ReferenceRow
          key={`org:${cred.service}`}
          cred={cred}
          scope="org"
          pending={disconnect.isPending}
          onRevoke={() => disconnect.mutate({ service: cred.service, scope: "org" })}
        />
      ))}
      {userRefs.map((cred) => (
        <ReferenceRow
          key={`user:${cred.service}`}
          cred={cred}
          pending={disconnect.isPending}
          onRevoke={() => disconnect.mutate({ service: cred.service })}
        />
      ))}
    </div>
  );
}

function ReferenceRow({
  cred,
  scope,
  pending,
  onRevoke,
}: {
  cred: CredentialSummary;
  scope?: "org";
  pending: boolean;
  onRevoke: () => void;
}) {
  return (
    <FieldRow label={cred.service}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="neutral">{cred.type}</Badge>
        {scope === "org" && <Badge variant="neutral">Organization</Badge>}
        <Badge variant="accent">{cred.onepasswordRef}</Badge>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => {
            if (!confirm(`Revoke ${cred.service}?`)) return;
            onRevoke();
          }}
        >
          {pending ? "Revoking…" : `Revoke ${cred.service}`}
        </Button>
      </div>
    </FieldRow>
  );
}

const TYPE_OPTIONS: { value: CredentialKind; label: string }[] = [
  { value: "api_key", label: "API key" },
  { value: "oauth2", label: "OAuth2 access token" },
];

function AddFromOnePassword({
  allowPersonal,
  orgTokenConnected,
  isAdmin,
}: {
  allowPersonal: boolean;
  orgTokenConnected: boolean;
  isAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [service, setService] = useState("");
  const [type, setType] = useState<CredentialKind>("api_key");
  const defaultScope: "personal" | "org" = allowPersonal ? "personal" : "org";
  const [tokenScope, setTokenScope] = useState<"personal" | "org">(defaultScope);
  const [composed, setComposed] = useState<OnePasswordComposedReference | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connect = useConnectCredential();

  const canPersonal = allowPersonal;
  const canOrg = orgTokenConnected;

  function submit() {
    const trimmedService = service.trim();
    if (!trimmedService || !composed) return;
    setError(null);
    const body =
      tokenScope === "org" && isAdmin
        ? { type, onepassword: composed, scope: "org" as const }
        : { type, onepassword: composed };
    connect.mutate(
      { service: trimmedService, body },
      {
        onSuccess: () => {
          setOpen(false);
          setService("");
          setComposed(null);
        },
        onError: (err) => setError(apiErrorMessage(err, "Couldn't create the credential.")),
      },
    );
  }

  if (!open) {
    if (!canPersonal && !canOrg) return null;
    return (
      <div className="py-2">
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          Add from 1Password
        </Button>
      </div>
    );
  }

  return (
    <FieldRow label="Add a credential from 1Password">
      <div className="space-y-2">
        <div className="space-y-1">
          <Label htmlFor="op-ref-service">Service name</Label>
          <Input
            id="op-ref-service"
            value={service}
            onChange={(e) => setService(e.target.value)}
            placeholder="linear"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="op-ref-type">Type</Label>
          <select
            id="op-ref-type"
            className="h-8 w-full rounded border border-[--border] bg-[--bg] px-2 text-sm text-[--fg]"
            value={type}
            onChange={(e) => setType(e.target.value as CredentialKind)}
          >
            {TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="op-ref-scope">1Password token</Label>
          <select
            id="op-ref-scope"
            className="h-8 w-full rounded border border-[--border] bg-[--bg] px-2 text-sm text-[--fg]"
            value={tokenScope}
            onChange={(e) => {
              setTokenScope(e.target.value as "personal" | "org");
              setComposed(null);
            }}
          >
            {canPersonal && <option value="personal">Personal</option>}
            {canOrg && <option value="org">Organization</option>}
          </select>
        </div>

        <OnePasswordPicker scope={tokenScope} onCompose={setComposed} />
        {composed && <p className="break-all font-mono text-xs text-muted">{composed.reference}</p>}
        {error && <p className="text-xs text-danger-500">{error}</p>}

        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            disabled={!service.trim() || !composed || connect.isPending}
            onClick={submit}
          >
            {connect.isPending ? "Adding…" : "Add"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </div>
    </FieldRow>
  );
}
