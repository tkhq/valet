import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import type { CredentialSummary, StartIdentityLinkResponse } from "@valet/api/wire";
import {
  useIdentityLinks,
  useSetLinkNotify,
  useStartIdentityLink,
  useUnlinkIdentity,
} from "~/api/queries";
import { useConnectGithub, useDisconnectGithub } from "~/api/repos";
import { useCredentials, useDisconnectCredential } from "~/api/integrations";
import { useGithubApp } from "~/api/settings";
import { ApiError } from "~/api/client";
import { Section } from "~/components/settings/section";
import { FieldRow } from "~/components/settings/field-row";
import { Badge, Button, Spinner, Switch } from "~/components/primitives";

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
    </Section>

    <CredentialsListSection />
    </>
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

  const others = (credentialsQ.data?.credentials ?? []).filter((c) => c.service !== "github");

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
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disconnect.isPending}
              onClick={() => {
                if (!confirm(`Revoke ${cred.service}?`)) return;
                disconnect.mutate(cred.service);
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
