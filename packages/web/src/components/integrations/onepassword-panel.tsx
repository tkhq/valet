import { useEffect, useState } from "react";
import { errorText } from "~/lib/error-text";
import { useConnectCredential, useDisconnectCredential } from "~/api/integrations";
import { useOnePasswordSettings, usePutOnePasswordSettings } from "~/api/onepassword";
import { useOrg } from "~/api/settings";
import { Badge, Button, ConfirmDialog, Input, Spinner, Switch } from "~/components/primitives";
import { FieldRow } from "~/components/settings/field-row";
import { Section } from "~/components/settings/section";
import { ServiceIcon } from "~/components/service-icon";

/**
 * Removing a service-account token is scoped, and the two scopes differ in
 * blast radius: the org row owns one shared token (`scope: "org"`), the
 * personal row owns the caller's own (`scope` omitted, so the server
 * resolves the owner to the session user). A credential whose secret is a
 * 1Password reference resolves through the token its `tokenScope` names, so
 * removing a token breaks exactly those references.
 */
const REMOVE_ORG_TOKEN_NOTE =
  "This token is shared across the organization. Credentials that read their secret through it " +
  "stop resolving for every member. An admin can connect a new token here.";

const REMOVE_PERSONAL_TOKEN_NOTE =
  "This token is yours alone. Credentials that read their secret through it stop resolving for " +
  "you, and other members and the organization token are not affected. You can connect a new " +
  "token here.";

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
  const [savedTick, setSavedTick] = useState(0);
  const [confirmRemove, setConfirmRemove] = useState(false);

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
      setSavedTick((n) => n + 1);
    } catch (err) {
      setTokenError(errorText(err, "Couldn't save the organization token."));
    }
  }

  return (
    <>
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
          onRemove={() => setConfirmRemove(true)}
          removeLabel="Remove token"
          savedTick={savedTick}
        />
      </FieldRow>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={(open) => {
          setConfirmRemove(open);
          // React Query holds `error` until the next mutate, so a dialog
          // reopened after a refusal would present the OLD failure as this
          // attempt's. Clear it as the dialog opens.
          if (open) disconnect.reset();
        }}
        title="Remove the organization 1Password token?"
        description={REMOVE_ORG_TOKEN_NOTE}
        confirmLabel="Remove token"
        pendingLabel="Removing…"
        pending={disconnect.isPending}
        error={disconnect.error != null ? errorText(disconnect.error) : undefined}
        onConfirm={() =>
          disconnect.mutate(
            { service: "onepassword", scope: "org" },
            { onSuccess: () => setConfirmRemove(false) },
          )
        }
      />
    </>
  );
}

function PersonalTokenRow({ connected }: { connected: boolean }) {
  const connect = useConnectCredential();
  const disconnect = useDisconnectCredential();
  const [token, setToken] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(0);
  const [confirmRemove, setConfirmRemove] = useState(false);

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
      setSavedTick((n) => n + 1);
    } catch (err) {
      setTokenError(errorText(err, "Couldn't save the 1Password token."));
    }
  }

  return (
    <>
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
          onRemove={() => setConfirmRemove(true)}
          removeLabel="Remove token"
          savedTick={savedTick}
        />
      </FieldRow>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={(open) => {
          setConfirmRemove(open);
          // React Query holds `error` until the next mutate, so a dialog
          // reopened after a refusal would present the OLD failure as this
          // attempt's. Clear it as the dialog opens.
          if (open) disconnect.reset();
        }}
        title="Remove your personal 1Password token?"
        description={REMOVE_PERSONAL_TOKEN_NOTE}
        confirmLabel="Remove token"
        pendingLabel="Removing…"
        pending={disconnect.isPending}
        error={disconnect.error != null ? errorText(disconnect.error) : undefined}
        onConfirm={() =>
          disconnect.mutate(
            { service: "onepassword" },
            { onSuccess: () => setConfirmRemove(false) },
          )
        }
      />
    </>
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
  savedTick,
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
  /** Incremented by the parent on every SUCCESSFUL save. */
  savedTick: number;
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
  // Replacing an already-connected token leaves `connected` true on both
  // sides of the save, so the effect above never re-runs and the form stays
  // open over a token that already saved. Close on the save itself, which
  // the parent reports by bumping this counter only when the mutation
  // resolved without error.
  useEffect(() => {
    if (savedTick > 0) setEntering(false);
  }, [savedTick]);

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
