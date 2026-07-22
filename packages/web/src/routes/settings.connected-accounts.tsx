import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import type { CredentialKind, CredentialSummary, StartIdentityLinkResponse } from "@valet/api/wire";
import {
  useIdentityLinks,
  useSetLinkNotify,
  useStartIdentityLink,
  useUnlinkIdentity,
} from "~/api/queries";
import { useConnectGithub, useDisconnectGithub } from "~/api/repos";
import { useConnectCredential, useCredentials, useDisconnectCredential } from "~/api/integrations";
import { useOnePasswordSettings } from "~/api/onepassword";
import { useGithubApp } from "~/api/settings";
import { ApiError, apiErrorMessage } from "~/api/client";
import { Section } from "~/components/settings/section";
import { FieldRow } from "~/components/settings/field-row";
import {
  OnePasswordPicker,
  type OnePasswordComposedReference,
} from "~/components/settings/onepassword-picker";
import { Badge, Button, Input, Label, Spinner, Switch } from "~/components/primitives";

/**
 * `/settings/connected-accounts` — You · Connected accounts. Telegram
 * account linking only this pass (see `IdentityLinkStatus`'s `provider`
 * field for the shape more channels would slot into).
 */
export const Route = createFileRoute("/settings/connected-accounts")({
  component: ConnectedAccountsPage,
});

function formatLinkedSince(createdAt: number | undefined): string {
  if (!createdAt) return "";
  return new Date(createdAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Server sends `{ error: "telegram bot not configured" }` for the one
 * documented failure (bot token removed between load and click); fall back
 * to a generic message for anything else (network failure, unexpected
 * shape). */
function extractStartLinkError(err: unknown): string {
  if (err instanceof ApiError && err.payload && typeof err.payload === "object") {
    const message = (err.payload as Record<string, unknown>).error;
    if (typeof message === "string" && message) return message;
  }
  return "Couldn't start the Telegram link. Try again.";
}

export function ConnectedAccountsPage() {
  const linksQ = useIdentityLinks();
  const startLink = useStartIdentityLink();
  const setNotify = useSetLinkNotify();
  const unlink = useUnlinkIdentity();
  const [pendingLink, setPendingLink] = useState<StartIdentityLinkResponse | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  const telegram = linksQ.data?.links.find((l) => l.provider === "telegram");

  return (
    <>
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

      {telegram && !telegram.channelReady && (
        <FieldRow label="Telegram">
          <p className="text-sm text-muted">
            Telegram isn't configured for this organization yet. An admin can add a bot token
            under Integrations.
          </p>
        </FieldRow>
      )}

      {telegram && telegram.channelReady && !telegram.linked && (
        <FieldRow label="Telegram" hint="Message your assistant from Telegram.">
          <div className="space-y-2">
            <Button
              type="button"
              variant="secondary"
              disabled={startLink.isPending}
              onClick={async () => {
                try {
                  const res = await startLink.mutateAsync("telegram");
                  setPendingLink(res);
                  setConnectError(null);
                } catch (err) {
                  setConnectError(extractStartLinkError(err));
                }
              }}
            >
              {startLink.isPending ? "Connecting…" : "Connect Telegram"}
            </Button>
            {connectError && <p className="text-sm text-danger-500">{connectError}</p>}
            {pendingLink && (
              <div className="space-y-1 rounded-md border border-line bg-ink-wash p-3 text-sm">
                <a
                  href={pendingLink.deepLink}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-moss underline"
                >
                  Open Telegram and press Start
                </a>
                <p className="break-all font-mono text-xs text-muted">{pendingLink.deepLink}</p>
                <p className="text-xs text-muted">
                  Link expires in {Math.round(pendingLink.expiresInSeconds / 60)} minutes.
                </p>
              </div>
            )}
          </div>
        </FieldRow>
      )}

      {telegram && telegram.channelReady && telegram.linked && (
        <>
          <FieldRow label="Telegram">
            <div className="space-y-1 text-sm text-ink">
              <div>{telegram.externalId}</div>
              {telegram.createdAt && (
                <div className="text-xs text-muted">
                  Linked since {formatLinkedSince(telegram.createdAt)}
                </div>
              )}
            </div>
          </FieldRow>
          <FieldRow label="Notify on attention" hint="Ping you on Telegram when your assistant needs you.">
            <Switch
              checked={telegram.notifyAttention ?? false}
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
      )}

      <GithubRow />
      <OnePasswordSection />
    </Section>

    <CredentialsListSection />
    </>
  );
}

/** Personal 1Password token card (hidden entirely when `allowPersonal` is
 * false) plus the personal reference-credential creation flow (1Password
 * credential provider plan, Task 4). The creation flow itself isn't gated
 * by `allowPersonal` — a member can still create a credential resolved via
 * the org's token (`tokenScope: "org"`) even with personal tokens off; only
 * the personal-token *paste* card and the "personal" option's usability are
 * governed by that toggle (the server 403s a disallowed personal resolve
 * and the error surfaces inline). */
function OnePasswordSection() {
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
        <p className="text-sm text-danger-500">Failed to load 1Password settings.</p>
      </FieldRow>
    );
  }

  const { allowPersonal, personalTokenConnected, orgTokenConnected } = settingsQ.data;

  return (
    <>
      {allowPersonal && (
        <PersonalTokenRow personalTokenConnected={personalTokenConnected} />
      )}
      <ReferenceCredentialRow orgTokenConnected={orgTokenConnected} />
    </>
  );
}

function PersonalTokenRow({ personalTokenConnected }: { personalTokenConnected: boolean }) {
  const connect = useConnectCredential();
  const disconnect = useDisconnectCredential();
  const [token, setToken] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);

  async function saveToken() {
    const trimmed = token.trim();
    if (!trimmed) return;
    setTokenError(null);
    try {
      await connect.mutateAsync({ service: "onepassword", body: { type: "service_account", apiKey: trimmed } });
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
      <div className="space-y-2">
        {personalTokenConnected && <Badge variant="success">Connected</Badge>}
        <div className="flex gap-2">
          <Input
            type="password"
            aria-label="1Password personal token"
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
            {connect.isPending ? "Saving…" : personalTokenConnected ? "Rotate" : "Save"}
          </Button>
        </div>
        {tokenError && <p className="text-xs text-danger-500">{tokenError}</p>}
        {personalTokenConnected && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disconnect.isPending}
            onClick={() => {
              if (!confirm("Remove your personal 1Password token?")) return;
              disconnect.mutate({ service: "onepassword" });
            }}
          >
            {disconnect.isPending ? "Removing…" : "Remove token"}
          </Button>
        )}
      </div>
    </FieldRow>
  );
}

const REFERENCE_TYPE_OPTIONS: { value: CredentialKind; label: string }[] = [
  { value: "api_key", label: "API key" },
  { value: "oauth2", label: "OAuth2 access token" },
];

function ReferenceCredentialRow({ orgTokenConnected }: { orgTokenConnected: boolean }) {
  const [open, setOpen] = useState(false);
  const [service, setService] = useState("");
  const [type, setType] = useState<CredentialKind>("api_key");
  const [tokenScope, setTokenScope] = useState<"personal" | "org">("personal");
  const [composed, setComposed] = useState<OnePasswordComposedReference | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connect = useConnectCredential();

  function submit() {
    const trimmedService = service.trim();
    if (!trimmedService || !composed) return;
    setError(null);
    connect.mutate(
      { service: trimmedService, body: { type, onepassword: composed } },
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
      <FieldRow label="Add a credential from 1Password">
        <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
          Add from 1Password
        </Button>
      </FieldRow>
    );
  }

  return (
    <FieldRow label="Add a credential from 1Password">
      <div className="space-y-2">
        <div className="space-y-1">
          <Label htmlFor="op-ref-service">Service name</Label>
          <Input id="op-ref-service" value={service} onChange={(e) => setService(e.target.value)} placeholder="linear" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="op-ref-type">Type</Label>
          <select
            id="op-ref-type"
            className="h-8 w-full rounded border border-[--border] bg-[--bg] px-2 text-sm text-[--fg]"
            value={type}
            onChange={(e) => setType(e.target.value as CredentialKind)}
          >
            {REFERENCE_TYPE_OPTIONS.map((opt) => (
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
            <option value="personal">Personal</option>
            {orgTokenConnected && <option value="org">Organization</option>}
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

/** A credential is "healthy" (repo-capable + usable) when it's neither
 * identity-only, mid-refresh-failure, nor past its known expiry — mirrors
 * `services/github-tokens.ts`'s health rules on the server. */
function isExpired(cred: CredentialSummary): boolean {
  return typeof cred.expiresAt === "number" && cred.expiresAt < Date.now();
}

function GithubRow() {
  const credentialsQ = useCredentials();
  const githubAppQ = useGithubApp();
  const connectGithub = useConnectGithub();
  const disconnectGithub = useDisconnectGithub();
  const [connectError, setConnectError] = useState<string | null>(null);

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
  const installUrl =
    githubAppQ.data?.configured && githubAppQ.data.app ? githubAppQ.data.app.installUrl : undefined;

  async function connect() {
    if (repoCapable && !confirm("This will replace your existing GitHub token.")) return;
    setConnectError(null);
    try {
      const res = await connectGithub.mutateAsync();
      window.location.href = res.url;
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : "Couldn't start the GitHub connect flow.");
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
            onClick={() => void connect()}
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
                if (!confirm("Disconnect GitHub?")) return;
                disconnectGithub.mutate();
              }}
            >
              {disconnectGithub.isPending ? "Disconnecting…" : "Disconnect GitHub"}
            </Button>
          )}
        </div>

        {connectError && <p className="text-xs text-danger-500">{connectError}</p>}

        {installUrl && (
          <a href={installUrl} target="_blank" rel="noreferrer" className="block text-xs text-moss underline">
            Install on your personal account
          </a>
        )}
      </div>
    </FieldRow>
  );
}

/** Generic credentials list — every service from `GET /api/credentials`
 * except `github` (already surfaced above with its own richer row). */
function CredentialsListSection() {
  const credentialsQ = useCredentials();
  const disconnect = useDisconnectCredential();

  // `github` gets its own richer row above; `onepassword` (the reserved
  // service holding the personal service-account token itself) is surfaced
  // by `PersonalTokenRow` instead — this list is every OTHER credential,
  // including 1Password reference-backed ones (badge below).
  const others = (credentialsQ.data?.credentials ?? []).filter(
    (c) => c.service !== "github" && c.service !== "onepassword",
  );

  return (
    <Section title="Other credentials" description="Manually connected services.">
      {credentialsQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {credentialsQ.error && (
        <div className="py-4 text-sm text-danger-500">Failed to load credentials.</div>
      )}
      {!credentialsQ.isLoading && !credentialsQ.error && others.length === 0 && (
        <div className="py-4 text-sm text-muted">No other services connected.</div>
      )}
      {others.map((cred) => (
        <FieldRow key={cred.service} label={cred.service}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="neutral">{cred.type}</Badge>
            {cred.identityOnly && <Badge variant="neutral">Identity only</Badge>}
            {cred.refreshFailedAt && <Badge variant="danger">Refresh failed</Badge>}
            {isExpired(cred) && <Badge variant="danger">Expired</Badge>}
            {/* Reference-backed credentials have no inline secret to edit —
                only the reference itself, shown as a badge, and deletion via
                the same Revoke control every other credential uses. */}
            {cred.onepasswordRef && <Badge variant="accent">{cred.onepasswordRef}</Badge>}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disconnect.isPending}
              onClick={() => {
                if (!confirm(`Revoke ${cred.service}?`)) return;
                disconnect.mutate({ service: cred.service });
              }}
            >
              {disconnect.isPending ? "Revoking…" : `Revoke ${cred.service}`}
            </Button>
          </div>
        </FieldRow>
      ))}
    </Section>
  );
}
