import { useState } from "react";
import type { GetSlackAppResponse } from "@valet/api/wire";
import { Badge, Button, Input, Spinner, Textarea } from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { qkSettings, useDeleteSlackApp, useSaveSlackCredential, useSlackApp } from "~/api/settings";

/** Where an operator manages the app after creation — install page, signing
 * secret, scope review all live behind it. */
const SLACK_APPS_URL = "https://api.slack.com/apps";

/**
 * Organization · Slack — the Slack agent app setup surface, rendered inside
 * `/settings/organization`'s `OrgRouteGuard`. Two states: not-connected
 * (manifest + token entry) and connected (workspace card + disconnect).
 *
 * Slack's `apps.manifest.create` method needs an app-configuration token
 * this deployment does not hold, so unlike the GitHub section there is no
 * one-click create: the operator copies the manifest `GET /api/org/slack`
 * builds, pastes it into Slack's app-creation form, installs the app, and
 * comes back with the bot token and signing secret. The server verifies
 * both against Slack before it stores anything.
 */
export function SlackAppSection() {
  // Committed on blur, not per keystroke — each distinct name is its own
  // query key, and a per-keystroke commit would refetch the manifest on
  // every character.
  const [manifestName, setManifestName] = useState<string | undefined>(undefined);
  const slackQ = useSlackApp(manifestName, {
    // `useSlackApp` sets the same key; `UseQueryOptions` makes it required.
    queryKey: qkSettings.slackApp(manifestName),
    // Keep the previous manifest on screen while a renamed one loads.
    placeholderData: (prev: GetSlackAppResponse | undefined) => prev,
  });

  if (slackQ.isLoading && !slackQ.data) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted">
        <Spinner size={14} /> Loading…
      </div>
    );
  }
  if (slackQ.error) {
    return <div className="py-4 text-sm text-danger-500">Failed to load the Slack app setup.</div>;
  }
  if (!slackQ.data) return null;

  return slackQ.data.connected ? (
    <ConnectedCard data={slackQ.data} />
  ) : (
    <SetupCards data={slackQ.data} onNameCommit={setManifestName} />
  );
}

function SlackTile() {
  return (
    <span
      aria-hidden="true"
      className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-base font-semibold text-white"
      style={{ backgroundColor: "#611f69" }}
    >
      S
    </span>
  );
}

function SetupCards({
  data,
  onNameCommit,
}: {
  data: GetSlackAppResponse;
  onNameCommit: (name: string | undefined) => void;
}) {
  const save = useSaveSlackCredential();
  const [nameInput, setNameInput] = useState("");
  const [copied, setCopied] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");

  const manifestJson = JSON.stringify(data.manifest, null, 2);
  const incomplete = botToken.trim().length === 0 || signingSecret.trim().length === 0;

  async function copyManifest() {
    await navigator.clipboard.writeText(manifestJson);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  async function connect() {
    try {
      await save.mutateAsync({
        accessToken: botToken.trim(),
        webhookSecret: signingSecret.trim(),
      });
      // On success the section re-renders as the connected card, because the
      // mutation invalidates the Slack app query.
    } catch {
      // useMutation surfaces the error via `save.error`.
    }
  }

  return (
    <div className="max-w-2xl space-y-4">
      {/* Step 1 — create the app on Slack from the manifest below. */}
      <div className="rounded-lg border border-line bg-paper">
        <div className="flex items-start gap-3 border-b border-line px-6 py-5">
          <SlackTile />
          <div className="min-w-0">
            <div className="font-display text-base text-ink">Create the Slack app</div>
            <p className="mt-0.5 text-sm leading-relaxed text-muted">
              Copy the manifest, open Slack's app-creation page, choose{" "}
              <span className="font-medium text-ink">From a manifest</span>, and paste it in.
              Then install the app to your workspace.
            </p>
          </div>
        </div>

        <div className="space-y-4 px-6 py-5">
          {data.ingress === "socket_mode" && (
            <div className="rounded border border-amber-300 bg-amber-50/70 px-3 py-2 text-xs leading-relaxed text-ink dark:border-amber-700/60 dark:bg-amber-950/40">
              This deployment has no public URL, so the manifest enables Socket Mode and Slack
              delivers events over a socket instead of a webhook. To use webhooks, set
              VALET_PUBLIC_URL (e.g. a tunnel) and reload this page before creating the app.
            </div>
          )}

          <div className="max-w-xs space-y-1.5">
            <label htmlFor="slack-app-name" className="text-sm font-medium text-ink">
              App name <span className="font-normal text-muted">— optional</span>
            </label>
            <Input
              id="slack-app-name"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onBlur={() => onNameCommit(nameInput.trim() === "" ? undefined : nameInput.trim())}
              placeholder="Valet"
              maxLength={35}
              aria-label="App name"
            />
            <p className="text-xs text-muted">
              Names the app in the manifest. Use it when this workspace already has another
              Valet app — two apps with the same name are indistinguishable in Slack.
            </p>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="slack-manifest" className="text-sm font-medium text-ink">
                App manifest
              </label>
              <Button type="button" variant="secondary" size="sm" onClick={() => void copyManifest()}>
                {copied ? "Copied" : "Copy manifest"}
              </Button>
            </div>
            <Textarea
              id="slack-manifest"
              readOnly
              rows={10}
              value={manifestJson}
              aria-label="App manifest"
              className="font-mono text-xs"
            />
            {data.requestUrl && (
              <p className="text-xs text-muted">
                Events and interactivity are delivered to{" "}
                <span className="font-mono">{data.requestUrl}</span>.
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-line px-6 py-4">
          <p className="text-xs text-muted">
            Slack shows you everything in the manifest before the app is created.
          </p>
          <Button asChild>
            <a href={data.createUrl} target="_blank" rel="noreferrer">
              Open Slack app creation
            </a>
          </Button>
        </div>
      </div>

      {/* Step 2 — bring back the two credentials the installed app minted. */}
      <div className="rounded-lg border border-line bg-paper">
        <div className="border-b border-line px-6 py-5">
          <div className="font-display text-base text-ink">Connect the installed app</div>
          <p className="mt-0.5 text-sm leading-relaxed text-muted">
            After installing, copy the two values below from the app's settings on Slack. The
            connection is checked with Slack before anything is saved.
          </p>
        </div>

        <div className="grid gap-4 px-6 py-5 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="slack-bot-token" className="text-sm font-medium text-ink">
              Bot token
            </label>
            <Input
              id="slack-bot-token"
              type="password"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="xoxb-…"
              aria-label="Bot token"
            />
            <p className="text-xs leading-relaxed text-muted">
              Install App → Bot User OAuth Token. It starts with xoxb-.
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="slack-signing-secret" className="text-sm font-medium text-ink">
              Signing secret
            </label>
            <Input
              id="slack-signing-secret"
              type="password"
              value={signingSecret}
              onChange={(e) => setSigningSecret(e.target.value)}
              aria-label="Signing secret"
            />
            <p className="text-xs leading-relaxed text-muted">
              Basic Information → App Credentials → Signing Secret. It authenticates Slack's
              event deliveries.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-6 py-4">
          <Button type="button" onClick={() => void connect()} disabled={save.isPending || incomplete}>
            {save.isPending ? "Checking with Slack…" : "Connect Slack"}
          </Button>
        </div>

        {save.error && (
          <p className="border-t border-line px-6 py-3 text-sm text-danger-500">
            {errorText(save.error)}
          </p>
        )}
      </div>
    </div>
  );
}

function ConnectedCard({ data }: { data: GetSlackAppResponse }) {
  const deleteApp = useDeleteSlackApp();

  return (
    <div className="max-w-2xl space-y-4">
      <div className="space-y-3 rounded-md border border-line p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <SlackTile />
            <div className="space-y-1">
              <div className="text-sm font-medium text-ink">
                {data.teamName ?? "Slack workspace"}
              </div>
              {data.teamId && <div className="text-xs text-muted">Workspace {data.teamId}</div>}
              <a
                href={SLACK_APPS_URL}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-moss underline"
              >
                Manage on Slack
              </a>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="success">Connected</Badge>
            <Badge variant={data.ingress === "webhook" ? "success" : "neutral"}>
              {data.ingress === "webhook" ? "webhook" : "socket mode"}
            </Badge>
          </div>
        </div>

        {data.requestUrl && (
          <p className="text-xs text-muted">
            Events and interactivity are delivered to{" "}
            <span className="font-mono">{data.requestUrl}</span>.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="danger"
            size="sm"
            disabled={deleteApp.isPending}
            onClick={() => {
              if (!confirm("Disconnect Slack? The agent stops answering in this workspace until a credential is saved again.")) {
                return;
              }
              deleteApp.mutate();
            }}
          >
            {deleteApp.isPending ? "Disconnecting…" : "Disconnect"}
          </Button>
        </div>
      </div>

      {data.missingScopes.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50/70 px-5 py-4 dark:border-amber-700/60 dark:bg-amber-950/40">
          <div className="text-sm font-medium text-ink">Missing scopes</div>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">
            The installed app did not grant these scopes, and each one costs a feature. Open the
            app's OAuth &amp; Permissions page on Slack, add them, and reinstall the app. Then
            disconnect and reconnect here, so the new grant is recorded.
          </p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {data.missingScopes.map((scope) => (
              <li key={scope}>
                <span className="rounded bg-ink-wash px-1.5 py-0.5 font-mono text-xs text-ink">
                  {scope}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
