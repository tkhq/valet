import { useEffect, useState } from "react";
import { errorText } from "~/lib/error-text";
import { useConnectCredential, useDisconnectCredential } from "~/api/integrations";
import { useOnePasswordSettings } from "~/api/onepassword";
import { useOrg } from "~/api/settings";
import { Badge, Button, ConfirmDialog, Input, Spinner } from "~/components/primitives";
import { FieldRow } from "~/components/settings/field-row";
import { Section } from "~/components/settings/section";
import { ServiceIcon } from "~/components/service-icon";

/**
 * Setup links. `www.1password.dev` is the current developer-docs host —
 * `developer.1password.com` answers every path with a 301 to it. Creating a
 * vault is an end-user task with no developer-docs page, so that one points
 * at the support site.
 */
const OP_CREATE_VAULT_URL = "https://support.1password.com/create-share-vaults-teams/";
const OP_SERVICE_ACCOUNT_URL = "https://www.1password.dev/service-accounts/get-started/";
const OP_SECRET_REFERENCE_URL = "https://www.1password.dev/cli/secret-reference-syntax/";
const VALET_SECRETS_GUIDE_URL =
  "https://github.com/tkhq/valet/blob/dev-v2/docs/onepassword-secrets.md";

/** Inline external link, the treatment the other setup pages already use. */
const LINK = "text-moss underline";

/**
 * The two removals differ in blast radius, so they get separate copy. A
 * credential whose secret is a 1Password reference resolves through the token
 * its `tokenScope` names, so removing a token breaks exactly those
 * references: org-wide for `scope: "org"`, caller-only when `scope` is
 * omitted and the server resolves the owner to the session user.
 */
const REMOVE_ORG_TOKEN_NOTE =
  "This token is shared across the organization. Credentials that read their secret through it " +
  "stop resolving for every member. An admin can connect a new token here.";

const REMOVE_PERSONAL_TOKEN_NOTE =
  "This token is yours alone. Credentials that read their secret through it stop resolving for " +
  "you, and other members and the organization token are not affected. You can connect a new " +
  "token here.";

/**
 * Organization · 1Password: the org service-account token and the reader's
 * own personal token, on one page for every role. An admin sets the org
 * token; a member sees the same row with the status in place of the
 * controls. A personal token is the member's own credential and needs no
 * organization permission, so its row is always live. Reference credentials
 * are resolved from the vaults by item title, so there is nothing to list
 * here.
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
        <div className="space-y-2 text-sm text-muted">
          <p>
            Connect a service-account token, then attach an item to Linear or any other
            service. The secret stays in 1Password, and an agent reads it at the moment it
            runs.
          </p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              <a className={LINK} href={OP_CREATE_VAULT_URL} target="_blank" rel="noreferrer">
                Create a vault
              </a>{" "}
              and put the items an agent needs into it.
            </li>
            <li>
              <a className={LINK} href={OP_SERVICE_ACCOUNT_URL} target="_blank" rel="noreferrer">
                Create a service account
              </a>{" "}
              with read access to that vault. 1Password shows the token once, so copy it
              before you leave the screen.
            </li>
            <li>Paste the token into a row below. Valet encrypts it and never shows it again.</li>
          </ol>
          <p>
            An item is addressed by a{" "}
            <a className={LINK} href={OP_SECRET_REFERENCE_URL} target="_blank" rel="noreferrer">
              secret reference
            </a>
            , written <span className="font-mono">op://Vault/Item/field</span>. The{" "}
            <a className={LINK} href={VALET_SECRETS_GUIDE_URL} target="_blank" rel="noreferrer">
              secrets guide
            </a>{" "}
            shows how an agent uses one.
          </p>
        </div>
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
          {isAdmin ? (
            <OrgTokenRow connected={settingsQ.data.orgTokenConnected} />
          ) : (
            <OrgTokenStatus connected={settingsQ.data.orgTokenConnected} />
          )}
          <PersonalTokenRow connected={settingsQ.data.personalTokenConnected} />
        </>
      )}
    </Section>
  );
}

/**
 * The org token as a plain member sees it: the same labelled row an admin
 * gets, with the status where the controls are and a line naming who can
 * change it. Read-only rather than hidden — a member who cannot find the row
 * cannot tell a missing org token from a page that is not showing it, and
 * both readings end in a support question. Same shape as the non-editable
 * branch of `ProxyGovernance`.
 */
function OrgTokenStatus({ connected }: { connected: boolean }) {
  return (
    <FieldRow
      label="Organization token"
      hint="A 1Password service account token shared across the organization."
    >
      <div className="space-y-1" role="group" aria-label="Organization token">
        {connected ? (
          <Badge variant="success">Connected</Badge>
        ) : (
          <p className="text-sm text-ink">Not connected</p>
        )}
        <p className="text-xs text-muted">
          Only an organization admin can connect or remove this token.
        </p>
      </div>
    </FieldRow>
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
          groupLabel="Organization token"
          connected={connected}
          token={token}
          onTokenChange={setToken}
          inputLabel="Organization 1Password token"
          error={tokenError}
          saving={connect.isPending}
          removing={disconnect.isPending}
          onSave={() => void saveToken()}
          onRemove={() => {
            // Radix fires no `onOpenChange(true)` here, so the stale refusal is cleared on open.
            disconnect.reset();
            setConfirmRemove(true);
          }}
          removeLabel="Remove token"
          savedTick={savedTick}
        />
      </FieldRow>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
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
        label="Personal token"
        hint="Your own service account token. It reads items from your own vaults, for work you own."
      >
        <TokenFields
          groupLabel="Personal token"
          connected={connected}
          token={token}
          onTokenChange={setToken}
          inputLabel="1Password personal token"
          error={tokenError}
          saving={connect.isPending}
          removing={disconnect.isPending}
          onSave={() => void saveToken()}
          onRemove={() => {
            // Radix fires no `onOpenChange(true)` here, so the stale refusal is cleared on open.
            disconnect.reset();
            setConfirmRemove(true);
          }}
          removeLabel="Remove token"
          savedTick={savedTick}
        />
      </FieldRow>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
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
  groupLabel,
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
  /** Names this row's controls as a group. Both rows are on screen for every
   *  role now, so "Connect", "Replace" and "Remove token" each appear twice
   *  whenever the two rows are in the same state. Never equal to
   *  `inputLabel`: both reach the accessibility tree as labels. */
  groupLabel: string;
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
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={groupLabel}>
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
    <div className="space-y-2" role="group" aria-label={groupLabel}>
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
