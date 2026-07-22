import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import type { CredentialKind } from "@valet/api/wire";
import { apiErrorMessage } from "~/api/client";
import { useConnectCredential, useCredentials, useDisconnectCredential } from "~/api/integrations";
import { useOnePasswordSettings, usePutOnePasswordSettings } from "~/api/onepassword";
import { useOrg } from "~/api/settings";
import { Badge, Button, Input, Label, Spinner, Switch } from "~/components/primitives";
import { FieldRow } from "~/components/settings/field-row";
import { OnePasswordPicker, type OnePasswordComposedReference } from "~/components/settings/onepassword-picker";
import { Section } from "~/components/settings/section";

/**
 * `/settings/organization/onepassword` — Organization · 1Password
 * (1Password credential provider plan, Task 4). Renders inside
 * `/settings/organization`'s `OrgRouteGuard`, plus its own caller-role
 * check: every control here is either directly admin-gated server-side (the
 * `PUT /api/onepassword/settings` toggle, the `scope: "org"` token/reference
 * writes) or reads org-scoped state a member has no use for, so the page
 * shows the same "managed by your org admins" copy as the guard rather than
 * rendering controls that would just 403 on submit.
 */
export const Route = createFileRoute("/settings/organization/onepassword")({
  component: OrganizationOnePasswordPage,
});

export function OrganizationOnePasswordPage() {
  const orgQ = useOrg();

  if (orgQ.isLoading) return null;
  if (orgQ.data && orgQ.data.callerRole !== "admin") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center px-6 py-10 text-center text-sm text-muted">
        <p>Organization settings are managed by your org admins</p>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <OrgTokenSection />
      <ReferenceCredentialsSection />
    </div>
  );
}

function OrgTokenSection() {
  const settingsQ = useOnePasswordSettings();
  const putSettings = usePutOnePasswordSettings();
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
    <Section
      title="1Password"
      description="Let the assistant resolve credentials directly from your organization's 1Password vaults."
    >
      {settingsQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {settingsQ.error && (
        <div className="py-4 text-sm text-danger-500">Failed to load 1Password settings.</div>
      )}

      {settingsQ.data && (
        <>
          <FieldRow
            label="Organization token"
            hint="A 1Password service account token shared across the organization."
          >
            <div className="space-y-2">
              {settingsQ.data.orgTokenConnected && <Badge variant="success">Connected</Badge>}
              <div className="flex gap-2">
                <Input
                  type="password"
                  aria-label="Organization 1Password token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="1Password service account token"
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={connect.isPending || !token.trim()}
                  onClick={() => void saveToken()}
                >
                  {connect.isPending ? "Saving…" : settingsQ.data.orgTokenConnected ? "Rotate" : "Save"}
                </Button>
              </div>
              {tokenError && <p className="text-xs text-danger-500">{tokenError}</p>}
              {settingsQ.data.orgTokenConnected && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disconnect.isPending}
                  onClick={() => {
                    if (!confirm("Remove the organization 1Password token?")) return;
                    disconnect.mutate({ service: "onepassword", scope: "org" });
                  }}
                >
                  {disconnect.isPending ? "Removing…" : "Remove token"}
                </Button>
              )}
            </div>
          </FieldRow>

          <FieldRow
            label="Allow personal tokens"
            hint="Let members connect their own 1Password service account token."
          >
            <Switch
              checked={settingsQ.data.allowPersonal}
              onCheckedChange={(next) => putSettings.mutate({ allowPersonal: next })}
              aria-label="Allow personal tokens"
            />
            {putSettings.error && (
              <p className="mt-1 text-xs text-danger-500">
                {apiErrorMessage(putSettings.error, "Couldn't save the setting.")}
              </p>
            )}
          </FieldRow>
        </>
      )}
    </Section>
  );
}

const TYPE_OPTIONS: { value: CredentialKind; label: string }[] = [
  { value: "api_key", label: "API key" },
  { value: "oauth2", label: "OAuth2 access token" },
];

function ReferenceCredentialsSection() {
  const credentialsQ = useCredentials("org");
  const disconnect = useDisconnectCredential();

  const references = (credentialsQ.data?.credentials ?? []).filter(
    (c) => c.service !== "onepassword" && c.onepasswordRef,
  );

  return (
    <Section
      title="Reference credentials"
      description="Org-scoped credentials resolved live from a 1Password item, never stored as a secret."
    >
      {credentialsQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {credentialsQ.error && (
        <div className="py-4 text-sm text-danger-500">Failed to load credentials.</div>
      )}
      {!credentialsQ.isLoading && !credentialsQ.error && references.length === 0 && (
        <div className="py-4 text-sm text-muted">No 1Password reference credentials yet.</div>
      )}
      {references.map((cred) => (
        <FieldRow key={cred.service} label={cred.service}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="neutral">{cred.type}</Badge>
            <Badge variant="accent">{cred.onepasswordRef}</Badge>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disconnect.isPending}
              onClick={() => {
                if (!confirm(`Revoke ${cred.service}?`)) return;
                disconnect.mutate({ service: cred.service, scope: "org" });
              }}
            >
              {disconnect.isPending ? "Revoking…" : `Revoke ${cred.service}`}
            </Button>
          </div>
        </FieldRow>
      ))}

      <CreateReferenceCredentialRow />
    </Section>
  );
}

function CreateReferenceCredentialRow() {
  const [open, setOpen] = useState(false);
  const [service, setService] = useState("");
  const [type, setType] = useState<CredentialKind>("api_key");
  const [composed, setComposed] = useState<OnePasswordComposedReference | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connect = useConnectCredential();

  function submit() {
    const trimmedService = service.trim();
    if (!trimmedService || !composed) return;
    setError(null);
    connect.mutate(
      {
        service: trimmedService,
        body: { type, onepassword: composed, scope: "org" },
      },
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
    return (
      <div className="py-4">
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          Add from 1Password
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3 py-4">
      <div className="space-y-1">
        <Label htmlFor="org-op-ref-service">Service name</Label>
        <Input
          id="org-op-ref-service"
          value={service}
          onChange={(e) => setService(e.target.value)}
          placeholder="linear"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="org-op-ref-type">Type</Label>
        <select
          id="org-op-ref-type"
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

      <OnePasswordPicker scope="org" onCompose={setComposed} />
      {composed && <p className="break-all font-mono text-xs text-muted">{composed.reference}</p>}
      {error && <p className="text-xs text-danger-500">{error}</p>}

      <div className="flex gap-2">
        <Button
          type="button"
          onClick={submit}
          disabled={!service.trim() || !composed || connect.isPending}
        >
          {connect.isPending ? "Adding…" : "Add"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
