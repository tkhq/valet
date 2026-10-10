import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { CredentialSummary, IdentityLinkStatus } from "@valet/api/wire";
import { useIdentityLinks, useSetLinkNotify, useUnlinkIdentity } from "~/api/queries";
import { useConnectGithub, useDisconnectGithub, useGithubOrgStatus } from "~/api/repos";
import { useCredentials } from "~/api/integrations";
import { Section } from "~/components/settings/section";
import { FieldRow } from "~/components/settings/field-row";
import { Badge, Button, ConfirmDialog, Spinner, Switch } from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { formatDateOr } from "~/lib/format-when";
import { displayName } from "~/components/integrations/display-name";
import { githubPersonalInstallationsLine, githubPersonalInstallNote } from "~/components/integrations/github-org-app";
import { useOnePasswordSettings } from "~/api/onepassword";
import { OnePasswordTokenRow } from "~/components/integrations/onepassword-setup";
import { IdentityLinkBlock } from "~/components/integrations/identity-link-block";
import { PERSONAL } from "~/lib/workspace-scope";

/**
 * `/settings/connected-accounts` — Account · Connected accounts: the chat
 * channels, GitHub, and 1Password token tied to you. Renders one
 * `LinkAccountCard` per provider returned by `GET /api/me/identity-links`.
 * Service credentials live on Integrations only, so this page links there
 * instead of listing them a second time.
 */
export const Route = createFileRoute("/settings/connected-accounts")({
  component: ConnectedAccountsPage,
});

interface LinkAccountCardProps {
  link: IdentityLinkStatus;
}

function LinkAccountCard({ link }: LinkAccountCardProps) {
  const setNotify = useSetLinkNotify(link.provider);
  const unlink = useUnlinkIdentity(link.provider);
  const label = displayName(link.provider);

  if (!link.channelReady) {
    return (
      <FieldRow label={label}>
        <p className="text-sm text-muted">
          {label} isn't configured for this organization yet. An admin can connect it in
          Settings → Organization.
        </p>
      </FieldRow>
    );
  }

  // The same pairing flow the Integrations tile uses: "DM me" and "Find me
  // by name" where the provider can DM, and the exact reply line to send.
  // A second copy here showed only the bare code, which the Slack bot does
  // not read as a link command.
  if (!link.linked) {
    return (
      <FieldRow label={label}>
        <IdentityLinkBlock link={link} title={label} offerOAuth />
      </FieldRow>
    );
  }

  return (
    <>
      <FieldRow label={label}>
        <div className="space-y-1 text-sm text-ink">
          <div>{link.externalId}</div>
          {link.createdAt && (
            <div className="text-xs text-muted">
              Linked since {formatDateOr(link.createdAt, "")}
            </div>
          )}
        </div>
      </FieldRow>
      <FieldRow label="Notify on attention" hint={`Ping you on ${label} when your assistant needs you.`}>
        <Switch
          checked={link.notifyAttention ?? false}
          onCheckedChange={(next) => setNotify.mutate({ notifyAttention: next })}
          aria-label="Notify on attention"
        />
      </FieldRow>
      <FieldRow label="Disconnect">
        <Button
          type="button"
          variant="danger"
          disabled={unlink.isPending}
          onClick={() => unlink.mutate()}
        >
          {unlink.isPending ? "Disconnecting…" : "Disconnect"}
        </Button>
      </FieldRow>
    </>
  );
}

export function ConnectedAccountsPage() {
  const linksQ = useIdentityLinks();

  return (
    <Section
      title="Connected accounts"
      description="Link other channels to your account to chat with your assistant there."
    >
      {linksQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {linksQ.error && (
        <div className="py-4 text-sm text-danger-500">Failed to load connected accounts.</div>
      )}

      {linksQ.data?.links.map((link) => (
        <LinkAccountCard key={link.provider} link={link} />
      ))}

      <GithubRow />
      <OnePasswordRow />
      <FieldRow label="Other services" hint="Connect services for your assistant on the Integrations page.">
        {/* Account settings are yours, so this opens your own Integrations
            whatever the switcher holds. */}
        <Link to="/integrations" search={{ workspace: PERSONAL }} className="text-sm text-moss underline underline-offset-2">
          Open Integrations
        </Link>
      </FieldRow>
    </Section>
  );
}

const REMOVE_PERSONAL_TOKEN_NOTE =
  "This token is yours alone. Credentials that read their secret through it stop resolving for " +
  "you, and other members and the organization token are not affected. You can connect a new " +
  "token here.";

/**
 * 1Password sits beside the other accounts you connect yourself. A personal
 * service account token needs no organization permission, so a member never
 * has to open an Organization page to set one up (TKAI-487).
 * Organization · 1Password keeps the org-wide token and opens the same
 * setup dialog.
 */
function OnePasswordRow() {
  const settingsQ = useOnePasswordSettings();

  if (settingsQ.isLoading) {
    return (
      <FieldRow label="1Password">
        <div className="flex items-center gap-2 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      </FieldRow>
    );
  }
  if (settingsQ.error || !settingsQ.data) {
    return (
      <FieldRow label="1Password">
        <p className="text-sm text-danger-500">Failed to load 1Password connection status.</p>
      </FieldRow>
    );
  }

  return (
    <OnePasswordTokenRow
      scope="personal"
      connected={settingsQ.data.personalTokenConnected}
      label="1Password"
      hint="Let an agent read a credential from your vaults instead of you pasting it. Your token reads your own vaults, for runtimes you own."
      removeNote={REMOVE_PERSONAL_TOKEN_NOTE}
    />
  );
}

/** A credential is "healthy" (repo-capable + usable) when it's neither
 * identity-only, mid-refresh-failure, nor past its known expiry — mirrors
 * `services/github-tokens.ts`'s health rules on the server. */
function isExpired(cred: CredentialSummary): boolean {
  return typeof cred.expiresAt === "number" && cred.expiresAt < Date.now();
}

function GithubRow() {
  const credentialsQ = useCredentials();
  const orgStatusQ = useGithubOrgStatus();
  const connectGithub = useConnectGithub();
  const disconnectGithub = useDisconnectGithub();
  const [connectError, setConnectError] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  if (credentialsQ.isLoading) {
    return (
      <FieldRow label="GitHub">
        <div className="flex items-center gap-2 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      </FieldRow>
    );
  }
  if (credentialsQ.error) {
    return (
      <FieldRow label="GitHub">
        <p className="text-sm text-danger-500">Failed to load GitHub connection status.</p>
      </FieldRow>
    );
  }

  const github = credentialsQ.data?.credentials.find((c) => c.service === "github");
  const repoCapable = !!github && !github.identityOnly;
  const installUrl = orgStatusQ.data?.personalInstallUrl;
  const personalNote = orgStatusQ.data ? githubPersonalInstallNote(orgStatusQ.data) : null;
  const ownInstallations = orgStatusQ.data ? githubPersonalInstallationsLine(orgStatusQ.data) : null;

  /** Answers whether the OAuth flow started, so the replace dialog can stay
   * open carrying the reason when it did not. */
  async function connect(): Promise<boolean> {
    setConnectError(null);
    try {
      const res = await connectGithub.mutateAsync(undefined);
      window.location.href = res.url;
      return true;
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : "Couldn't start the GitHub connect flow.");
      return false;
    }
  }

  return (
    <FieldRow label="GitHub" hint="Let the assistant clone and push to your repos.">
      <div className="space-y-2">
        {github && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-ink">
            {github.login && <span>{github.login}</span>}
            {github.identityOnly && <Badge variant="neutral">Identity only</Badge>}
            {github.refreshFailedAt && <Badge variant="danger">Refresh failed</Badge>}
            {isExpired(github) && <Badge variant="danger">Expired</Badge>}
            {repoCapable && !github.refreshFailedAt && !isExpired(github) && (
              <Badge variant="success">Connected</Badge>
            )}
          </div>
        )}
        {github?.identityOnly && (
          <p className="text-xs text-muted">Sign-in only — connect to enable repos.</p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant={repoCapable ? "secondary" : "primary"}
            size="sm"
            disabled={connectGithub.isPending}
            onClick={() => {
              // Reconnecting over a repo-capable token overwrites it, so it
              // asks first; a first connect has nothing to overwrite. And
              // `connectError` outlives the dialog, so clear it here.
              if (repoCapable) {
                setConnectError(null);
                setConfirmReplace(true);
              } else void connect();
            }}
          >
            {connectGithub.isPending
              ? "Connecting…"
              : repoCapable
                ? "Reconnect GitHub"
                : "Connect GitHub"}
          </Button>
          {github && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disconnectGithub.isPending}
              onClick={() => {
                // React Query holds `error` until the next mutate, and Radix
                // never calls `onOpenChange(true)` for a controlled dialog
                // with no trigger, so the previous refusal is cleared here.
                disconnectGithub.reset();
                setConfirmDisconnect(true);
              }}
            >
              {disconnectGithub.isPending ? "Disconnecting…" : "Disconnect GitHub"}
            </Button>
          )}
        </div>

        {/* The open replace dialog carries the failure itself, so the same
            text does not render twice. */}
        {connectError && !confirmReplace && (
          <p className="text-xs text-danger-500">{connectError}</p>
        )}

        {installUrl && (
          <a href={installUrl} target="_blank" rel="noreferrer" className="block text-xs text-moss underline">
            Install on your personal account
          </a>
        )}
        {ownInstallations && <p className="text-xs text-ink">{ownInstallations}</p>}
        {personalNote && <p className="text-xs text-muted">{personalNote}</p>}

        <ConfirmDialog
          open={confirmReplace}
          onOpenChange={setConfirmReplace}
          title="Replace your GitHub token?"
          description="Valet keeps one GitHub token for you. When you finish the sign-in on GitHub, the new token replaces the one stored now. Cancel to keep the token you have."
          confirmLabel="Reconnect GitHub"
          pendingLabel="Connecting…"
          pending={connectGithub.isPending}
          error={connectError ?? undefined}
          onConfirm={() => {
            void connect().then((started) => {
              if (started) setConfirmReplace(false);
            });
          }}
        />
        <ConfirmDialog
          open={confirmDisconnect}
          onOpenChange={setConfirmDisconnect}
          title="Disconnect GitHub?"
          description="Valet deletes your stored GitHub token, so the assistant can no longer clone or push to your repos. Teams you shared it with lose access too. Connect GitHub again to restore it."
          confirmLabel="Disconnect"
          pendingLabel="Disconnecting…"
          pending={disconnectGithub.isPending}
          error={disconnectGithub.error != null ? errorText(disconnectGithub.error) : undefined}
          onConfirm={() =>
            disconnectGithub.mutate(undefined, { onSuccess: () => setConfirmDisconnect(false) })
          }
        />
      </div>
    </FieldRow>
  );
}
