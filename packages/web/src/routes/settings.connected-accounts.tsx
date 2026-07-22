import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import type {
  CredentialSummary,
  IdentityLinkStatus,
  SlackWorkspaceMember,
  StartIdentityLinkResponse,
} from "@valet/api/wire";
import {
  useIdentityLinks,
  useSetLinkNotify,
  useSlackWorkspaceMembers,
  useStartIdentityLink,
  useStartSlackLink,
  useUnlinkIdentity,
  useVerifySlackLink,
} from "~/api/queries";
import { useConnectGithub, useDisconnectGithub } from "~/api/repos";
import { useCredentials, useDisconnectCredential } from "~/api/integrations";
import { useGithubApp } from "~/api/settings";
import { ApiError } from "~/api/client";
import { useDebouncedValue } from "~/hooks/use-debounced-value";
import { Section } from "~/components/settings/section";
import { FieldRow } from "~/components/settings/field-row";
import { Badge, Button, Input, Spinner, Switch } from "~/components/primitives";

/**
 * `/settings/connected-accounts` — You · Connected accounts. One block per
 * transport-declaring channel provider (`IdentityLinkStatus`): Telegram
 * (deep-link flow) and Slack (typeahead → DMed code → verify, Slack design
 * decision 8).
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

/** Server sends `{ error: "…" }` for documented failures (bot token removed
 * between load and click, invalid code); fall back to a generic message for
 * anything else (network failure, unexpected shape). */
function extractLinkError(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.payload && typeof err.payload === "object") {
    const message = (err.payload as Record<string, unknown>).error;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}

export function ConnectedAccountsPage() {
  const linksQ = useIdentityLinks();

  const telegram = linksQ.data?.links.find((l) => l.provider === "telegram");
  const slack = linksQ.data?.links.find((l) => l.provider === "slack");

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

      {telegram && <TelegramRows link={telegram} />}
      {slack && <SlackRows link={slack} />}

      <GithubRow />
    </Section>

    <CredentialsListSection />
    </>
  );
}

function TelegramRows({ link }: { link: IdentityLinkStatus }) {
  const startLink = useStartIdentityLink();
  const [pendingLink, setPendingLink] = useState<StartIdentityLinkResponse | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  if (!link.channelReady) {
    return (
      <FieldRow label="Telegram">
        <p className="text-sm text-muted">
          Telegram isn't configured for this organization yet. An admin can add a bot token
          under Integrations.
        </p>
      </FieldRow>
    );
  }

  if (link.linked) {
    return <LinkedRows link={link} label="Telegram" />;
  }

  return (
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
              setConnectError(
                extractLinkError(err, "Couldn't start the Telegram link. Try again."),
              );
            }
          }}
        >
          {startLink.isPending ? "Connecting…" : "Connect Telegram"}
        </Button>
        {connectError && (
          <p role="status" className="text-sm text-danger-500">{connectError}</p>
        )}
        {pendingLink?.deepLink && (
          <div role="status" className="space-y-1 rounded-md border border-line bg-ink-wash p-3 text-sm">
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
  );
}

function SlackRows({ link }: { link: IdentityLinkStatus }) {
  if (!link.channelReady) {
    return (
      <FieldRow label="Slack">
        <p className="text-sm text-muted">
          Slack isn't configured for this organization yet. An admin can add a bot token under
          Integrations.
        </p>
      </FieldRow>
    );
  }

  if (link.linked) {
    return <LinkedRows link={link} label="Slack" />;
  }

  return <SlackConnectFlow />;
}

const SLACK_SEARCH_DEBOUNCE_MS = 300;

/** Typeahead → pick a member → bot DMs a code → verify it here (Slack
 * design decision 8: the code travels OUT to the account being linked). */
function SlackConnectFlow() {
  const startSlack = useStartSlackLink();
  const verifySlack = useVerifySlackLink();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<SlackWorkspaceMember | null>(null);
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [flowError, setFlowError] = useState<string | null>(null);

  const debouncedQuery = useDebouncedValue(query.trim(), SLACK_SEARCH_DEBOUNCE_MS);
  const searchEnabled = !codeSent && debouncedQuery.length >= 2;
  const membersQ = useSlackWorkspaceMembers(debouncedQuery, searchEnabled);

  if (codeSent && selected) {
    return (
      <FieldRow label="Slack" hint="Message your assistant from Slack.">
        <div className="space-y-2">
          <p role="status" className="text-sm text-ink">
            We DMed a code to @{selected.name} — enter it here.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              aria-label="Link code"
              placeholder="Link code"
              className="w-40"
            />
            <Button
              type="button"
              variant="secondary"
              disabled={verifySlack.isPending || code.trim() === ""}
              onClick={async () => {
                try {
                  await verifySlack.mutateAsync({ code: code.trim() });
                  setFlowError(null);
                  // Links query invalidation flips the block to linked.
                } catch (err) {
                  setFlowError(extractLinkError(err, "Couldn't verify the code. Try again."));
                }
              }}
            >
              {verifySlack.isPending ? "Verifying…" : "Verify"}
            </Button>
          </div>
          {flowError && (
            <p role="status" className="text-sm text-danger-500">{flowError}</p>
          )}
        </div>
      </FieldRow>
    );
  }

  return (
    <FieldRow label="Slack" hint="Message your assistant from Slack.">
      <div className="space-y-2">
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(null);
          }}
          aria-label="Find your Slack account"
          placeholder="Find your Slack account…"
        />
        {membersQ.isLoading && searchEnabled && (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner size={14} /> Searching…
          </div>
        )}
        {membersQ.error && (
          <p role="status" className="text-sm text-danger-500">
            {extractLinkError(membersQ.error, "Couldn't search the workspace. Try again.")}
          </p>
        )}
        {searchEnabled && membersQ.data && membersQ.data.members.length === 0 && (
          <p role="status" className="text-sm text-muted">No matching members.</p>
        )}
        {searchEnabled && membersQ.data && membersQ.data.members.length > 0 && (
          <ul className="space-y-1">
            {membersQ.data.members.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  aria-pressed={selected?.id === m.id}
                  onClick={() => setSelected(m)}
                  className={`w-full rounded border px-3 py-1.5 text-left text-sm transition-colors ${
                    selected?.id === m.id
                      ? "border-moss bg-moss/10 text-ink"
                      : "border-line text-ink hover:bg-ink-wash"
                  }`}
                >
                  @{m.name}
                  {m.realName && <span className="ml-2 text-xs text-muted">{m.realName}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        <Button
          type="button"
          variant="secondary"
          disabled={!selected || startSlack.isPending}
          onClick={async () => {
            if (!selected) return;
            try {
              await startSlack.mutateAsync({ externalId: selected.id });
              setCodeSent(true);
              setFlowError(null);
            } catch (err) {
              setFlowError(extractLinkError(err, "Couldn't send the link code. Try again."));
            }
          }}
        >
          {startSlack.isPending ? "Sending…" : "Send link code"}
        </Button>
        {flowError && (
          <p role="status" className="text-sm text-danger-500">{flowError}</p>
        )}
      </div>
    </FieldRow>
  );
}

/** Linked state shared by Telegram and Slack: externalId + linked-since,
 * notify-attention switch (generic PATCH), disconnect (generic DELETE). */
function LinkedRows({ link, label }: { link: IdentityLinkStatus; label: string }) {
  const setNotify = useSetLinkNotify();
  const unlink = useUnlinkIdentity();

  return (
    <>
      <FieldRow label={label}>
        <div className="space-y-1 text-sm text-ink">
          <div>{link.externalId}</div>
          {link.createdAt && (
            <div className="text-xs text-muted">
              Linked since {formatLinkedSince(link.createdAt)}
            </div>
          )}
        </div>
      </FieldRow>
      <FieldRow
        label="Notify on attention"
        hint={`Ping you on ${label} when your assistant needs you.`}
      >
        <Switch
          checked={link.notifyAttention ?? false}
          onCheckedChange={(next) =>
            setNotify.mutate({ provider: link.provider, notifyAttention: next })
          }
          aria-label={`Notify on attention (${label})`}
        />
      </FieldRow>
      <FieldRow label="Disconnect">
        <Button
          type="button"
          variant="danger"
          disabled={unlink.isPending}
          onClick={() => unlink.mutate(link.provider)}
        >
          {unlink.isPending ? "Disconnecting…" : `Disconnect ${label}`}
        </Button>
      </FieldRow>
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
