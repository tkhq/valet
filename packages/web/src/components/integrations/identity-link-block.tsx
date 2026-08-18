/**
 * Account pairing for an org-provided service tile (`/integrations`).
 *
 * An org-provided service ("org" connect mode) has no token for the member
 * to paste — the org credential powers the integration. The member's own
 * step is pairing: link their provider account to their Valet account
 * through the identity-link code flow (`POST /api/me/identity-links/:provider/start`,
 * then send the code to the bot — e.g. DM the Slack app "link <code>").
 *
 * The block renders only for providers `GET /api/me/identity-links` lists,
 * i.e. plugins that declare `identityLink`. Three states:
 *
 *   linked      → "Linked as <externalId>" + Unlink
 *   not linked  → "Link account" button; starting shows the code, the
 *                 provider's own delivery instructions, and the expiry
 *   list failed → nothing; the tile's generic org note stands in
 *
 * The same flow lives on Settings → Connected accounts (`LinkAccountCard`)
 * with notify controls; this block is the tile-sized version so the
 * integrations page offers the pairing where members look for it.
 */
import { useState } from "react";
import type { IdentityLinkStatus, StartIdentityLinkResponse } from "@valet/api/wire";
import { Button } from "~/components/primitives";
import { useIdentityLinks, useStartIdentityLink, useUnlinkIdentity } from "~/api/queries";
import { ApiError } from "~/api/client";

/** The identity-link entry for `provider` — null on error and for providers
 * that declare no `identityLink`. `isLoading` is surfaced so the tile can
 * hold BOTH the pairing block and its fallback note until the list settles,
 * instead of flashing the fallback on every page load. */
export function useServiceIdentityLink(provider: string): {
  link: IdentityLinkStatus | null;
  isLoading: boolean;
} {
  const linksQ = useIdentityLinks();
  return {
    link: linksQ.data?.links.find((link) => link.provider === provider) ?? null,
    isLoading: linksQ.isLoading,
  };
}

function startErrorMessage(err: unknown, title: string): string {
  if (err instanceof ApiError && err.payload && typeof err.payload === "object") {
    const message = (err.payload as Record<string, unknown>).error;
    if (typeof message === "string" && message) return message;
  }
  return `Couldn't start the ${title} link. Try again.`;
}

export function IdentityLinkBlock({ link, title }: { link: IdentityLinkStatus; title: string }) {
  const [pendingLink, setPendingLink] = useState<StartIdentityLinkResponse | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const startLink = useStartIdentityLink();
  const unlink = useUnlinkIdentity(link.provider);

  if (link.linked) {
    return (
      <div className="space-y-1">
        <p className="text-xs leading-relaxed text-muted">
          Linked as <span className="font-mono text-ink">{link.externalId}</span>.
        </p>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Unlink ${title}`}
          disabled={unlink.isPending}
          onClick={() => {
            if (!confirm(`Unlink ${title}?`)) return;
            unlink.mutate();
          }}
        >
          {unlink.isPending ? "Unlinking…" : "Unlink"}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs leading-relaxed text-muted">
        Link your {title} account to chat with your assistant there.
      </p>
      <Button
        size="sm"
        aria-label={`Link ${title} account`}
        disabled={startLink.isPending}
        onClick={async () => {
          try {
            const res = await startLink.mutateAsync(link.provider);
            setPendingLink(res);
            setStartError(null);
          } catch (err) {
            setStartError(startErrorMessage(err, title));
          }
        }}
      >
        {startLink.isPending ? "Starting…" : "Link account"}
      </Button>
      {startError && <p className="text-xs text-danger-500">{startError}</p>}
      {pendingLink && (
        <div className="space-y-1 rounded-md border border-line bg-ink-wash p-3">
          <p className="break-all font-mono text-xs text-ink">{pendingLink.code}</p>
          <p className="text-xs leading-relaxed text-muted">{pendingLink.instructions}</p>
          <p className="text-xs text-muted">
            {/* ceil, not round: a code with seconds left must never read "0 minutes". */}
            The code expires in {Math.ceil(pendingLink.expiresInSeconds / 60)}{" "}
            {Math.ceil(pendingLink.expiresInSeconds / 60) === 1 ? "minute" : "minutes"}.
          </p>
        </div>
      )}
    </div>
  );
}
