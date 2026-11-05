import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import type { CredentialSummary } from "@valet/api/wire";
import { useConnectCredential, useCredentials, useDisconnectCredential } from "~/api/integrations";
import { apiErrorMessage } from "~/api/policies";
import { useIdentityLinks } from "~/api/queries";
import { Badge, Button, ConfirmDialog, ErrorRow, Input, LoadingRow } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { ServiceIcon } from "~/components/service-icon";

export const Route = createFileRoute("/settings/organization/telegram")({ component: OrganizationTelegramPage });

const BOTFATHER_URL = "https://t.me/BotFather";

/**
 * Organization · Telegram: the organization's Telegram bot, modeled on the
 * Slack and Linear pages. The bot token is an org credential
 * (`requires.orgCredential` in plugin-telegram). The api checks it with
 * Telegram's `getMe` before it saves it. The channel host reads the token
 * only at boot, so the connected card says whether the bot runs now or
 * starts at the next restart. People link their own Telegram accounts on
 * the Integrations page.
 */
export function OrganizationTelegramPage() {
  const credentials = useCredentials("org");
  const links = useIdentityLinks();
  const bot = credentials.data?.credentials.find(c => c.service === "telegram");
  const running = links.data?.links.find(link => link.provider === "telegram")?.channelReady === true;
  return <Section title="Telegram" description="Connect a Telegram bot so people can talk to the assistant from Telegram. People link their own Telegram accounts on the Integrations page.">
    {credentials.isPending ? <LoadingRow label="Loading Telegram bot…" />
      : credentials.isError ? <ErrorRow>Could not load the Telegram bot. <button className="underline" onClick={() => void credentials.refetch()}>Retry</button></ErrorRow>
      : bot ? <ConnectedCard bot={bot} running={running} />
      : <SetupCard />}
  </Section>;
}

function SetupCard() {
  const save = useConnectCredential();
  const [token, setToken] = useState("");
  return <form className="-mx-4" onSubmit={event => {
      event.preventDefault();
      save.mutate({ service: "telegram", body: { type: "bot_token", accessToken: token.trim(), scope: "org" } });
    }}>
    <div className="flex items-start gap-3 border-b border-line px-6 py-5">
      <ServiceIcon slug="telegram" label="Telegram" />
      <div className="min-w-0">
        <div className="font-display text-base text-ink">Connect Telegram</div>
        <p className="mt-0.5 text-sm leading-relaxed text-muted">
          Create a bot with @BotFather, then paste its token here. Valet checks the token with Telegram before it saves it.
        </p>
      </div>
    </div>

    <div className="space-y-3 border-b border-line px-6 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm font-medium text-ink">1. Create the bot</div>
        <Button asChild variant="secondary" size="sm">
          <a href={BOTFATHER_URL} target="_blank" rel="noreferrer">Open @BotFather</a>
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-muted">
        Send /newbot, then choose a name and a username. BotFather replies with the bot token.
      </p>
    </div>

    <div className="space-y-1.5 px-6 py-5">
      <label htmlFor="telegram-bot-token" className="text-sm font-medium text-ink">2. Bot token</label>
      <Input id="telegram-bot-token" required autoComplete="new-password" type="password"
        value={token} onChange={event => setToken(event.target.value)} />
      <p className="text-xs leading-relaxed text-muted">The token looks like 123456789:AA… and is in BotFather’s reply.</p>
    </div>

    <div className="flex justify-end border-t border-line px-6 py-4">
      <Button type="submit" disabled={save.isPending || !token.trim()}>
        {save.isPending ? "Checking with Telegram…" : "Connect Telegram"}
      </Button>
    </div>
    {save.error && <p className="border-t border-line px-6 py-3 text-sm text-danger-500">
      {apiErrorMessage(save.error)}
    </p>}
  </form>;
}

function ConnectedCard({ bot, running }: { bot: CredentialSummary; running: boolean }) {
  const disconnect = useDisconnectCredential();
  const [confirm, setConfirm] = useState(false);
  return <div className="max-w-2xl space-y-3 rounded-md border border-line p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        <ServiceIcon slug="telegram" label="Telegram" />
        <div className="space-y-1">
          <div className="text-sm font-medium text-ink">{bot.login ?? "Telegram bot"}</div>
          <a href={BOTFATHER_URL} target="_blank" rel="noreferrer" className="text-xs text-moss underline">Manage in @BotFather</a>
        </div>
      </div>
      <Badge variant={running ? "success" : "warning"}>{running ? "Running" : "Starts on restart"}</Badge>
    </div>
    {!running && <p className="text-xs leading-relaxed text-muted">
      Valet saved the token. The bot starts the next time the Valet server restarts.
    </p>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="danger" size="sm" disabled={disconnect.isPending} onClick={() => { disconnect.reset(); setConfirm(true); }}>
        {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
      </Button>
    </div>
    <p className="text-xs text-muted">To use a different bot, disconnect, then connect again.</p>
    <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Disconnect Telegram?"
      description="This deletes the organization’s saved bot token. The bot stops answering after the next Valet server restart. The bot stays in Telegram until you delete it with @BotFather."
      confirmLabel="Disconnect" pendingLabel="Disconnecting…" pending={disconnect.isPending}
      error={disconnect.error ? apiErrorMessage(disconnect.error) : undefined}
      onConfirm={() => disconnect.mutate({ service: "telegram", scope: "org" }, { onSuccess: () => setConfirm(false) })} />
  </div>;
}
