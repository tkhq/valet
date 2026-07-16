import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import type { StartIdentityLinkResponse } from "@valet/api/wire";
import {
  useIdentityLinks,
  useSetLinkNotify,
  useStartIdentityLink,
  useUnlinkIdentity,
} from "~/api/queries";
import { Section } from "~/components/settings/section";
import { FieldRow } from "~/components/settings/field-row";
import { Button, Spinner, Switch } from "~/components/primitives";

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

export function ConnectedAccountsPage() {
  const linksQ = useIdentityLinks();
  const startLink = useStartIdentityLink();
  const setNotify = useSetLinkNotify();
  const unlink = useUnlinkIdentity();
  const [pendingLink, setPendingLink] = useState<StartIdentityLinkResponse | null>(null);

  const telegram = linksQ.data?.links.find((l) => l.provider === "telegram");

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
                const res = await startLink.mutateAsync("telegram");
                setPendingLink(res);
              }}
            >
              {startLink.isPending ? "Connecting…" : "Connect Telegram"}
            </Button>
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
          <FieldRow label="Telegram" hint={`Connected as ${telegram.externalId ?? "—"}`}>
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
    </Section>
  );
}
