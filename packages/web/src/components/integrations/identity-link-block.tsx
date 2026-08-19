/**
 * Account pairing for an org-provided service tile (`/integrations`).
 *
 * An org-provided service ("org" connect mode) has no token for the member
 * to paste — the org credential powers the integration. The member's own
 * step is pairing: link their provider account to their Valet account
 * through the identity-link code flow. Two ways in when the provider can
 * DM (`codeDelivery`):
 *
 *   DM me the code   → `POST /api/me/identity-links/:provider/deliver`. The
 *                      server finds the member by their Valet email and DMs
 *                      them the code. The card echoes the exact DM text so
 *                      the user knows what to look for.
 *   Find me by name  → `GET .../members` typeahead; picking a member DMs
 *                      that account. For users whose provider email differs
 *                      from their Valet email. Requires `memberSearch`.
 *
 * The show-code flow (`POST .../start`: the card shows the code and the
 * provider's delivery instructions) is never a third button. It is the
 * single "Link account" flow for providers without `codeDelivery`
 * (Telegram), and the automatic fallback when the email lookup 202s and
 * the provider has no member directory.
 *
 * The block renders only for providers `GET /api/me/identity-links` lists,
 * i.e. plugins that declare `identityLink`. Once a code is out (shown or
 * DMed), the block polls the link list so the tile flips to "Linked" the
 * moment the user completes the flow in the provider app.
 *
 * The same flow lives on Settings → Connected accounts (`LinkAccountCard`)
 * with notify controls; this block is the tile-sized version so the
 * integrations page offers the pairing where members look for it.
 */
import { useState } from "react";
import type {
  DeliverIdentityLinkResponse,
  IdentityLinkStatus,
  LinkMemberEntry,
  StartIdentityLinkResponse,
} from "@valet/api/wire";
import { Button, Input } from "~/components/primitives";
import {
  useDeliverIdentityLink,
  useIdentityLinks,
  useLinkMembers,
  useStartIdentityLink,
  useUnlinkIdentity,
} from "~/api/queries";
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

function ExpiryLine({ seconds }: { seconds: number }) {
  // ceil, not round: a code with seconds left must never read "0 minutes".
  const minutes = Math.ceil(seconds / 60);
  return (
    <p className="text-xs text-muted">
      The code expires in {minutes} {minutes === 1 ? "minute" : "minutes"}.
    </p>
  );
}

/** The find-me-by-name step: search the workspace directory, pick yourself,
 * and the bot DMs the picked account the code. */
function MemberSearch({
  provider,
  title,
  onPick,
  onCancel,
  busy,
}: {
  provider: string;
  title: string;
  onPick: (member: LinkMemberEntry) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const membersQ = useLinkMembers(provider, submitted, submitted !== "");

  return (
    <div className="space-y-2">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(query.trim());
        }}
      >
        <Input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Your name on ${title}…`}
          aria-label={`Search ${title} members`}
          autoFocus
          className="h-8 text-xs"
        />
        <Button type="submit" variant="ghost" size="sm" disabled={busy || query.trim() === ""}>
          Search
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Back
        </Button>
      </form>
      {membersQ.isLoading && <p className="text-xs text-muted">Searching…</p>}
      {membersQ.isError && (
        <p className="text-xs text-danger-500">{startErrorMessage(membersQ.error, title)}</p>
      )}
      {membersQ.data && membersQ.data.members.length === 0 && (
        <p className="text-xs text-muted">No members match. Try another name.</p>
      )}
      {membersQ.data && membersQ.data.members.length > 0 && (
        <ul className="max-h-40 space-y-1 overflow-y-auto">
          {membersQ.data.members.map((member) => (
            <li key={member.externalId}>
              <button
                type="button"
                disabled={busy}
                onClick={() => onPick(member)}
                className="w-full rounded-md border border-line px-2.5 py-1.5 text-left text-xs text-ink hover:bg-ink-wash"
              >
                {member.displayName}
                <span className="ml-1 text-muted">@{member.handle}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function IdentityLinkBlock({ link, title }: { link: IdentityLinkStatus; title: string }) {
  const [pendingLink, setPendingLink] = useState<StartIdentityLinkResponse | null>(null);
  const [delivery, setDelivery] = useState<DeliverIdentityLinkResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [fallbackNote, setFallbackNote] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const startLink = useStartIdentityLink();
  const deliver = useDeliverIdentityLink();
  const unlink = useUnlinkIdentity(link.provider);

  // A code is out — poll so the tile flips to "Linked" as soon as the user
  // completes the flow in the provider app.
  const awaitingReply = !link.linked && (pendingLink !== null || delivery !== null);
  useIdentityLinks(awaitingReply ? { refetchInterval: 3000 } : undefined);

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

  async function showCode() {
    setSearching(false);
    try {
      const res = await startLink.mutateAsync(link.provider);
      setPendingLink(res);
      setDelivery(null);
      setStartError(null);
    } catch (err) {
      setStartError(startErrorMessage(err, title));
    }
  }

  async function deliverTo(member?: LinkMemberEntry) {
    setFallbackNote(null);
    try {
      const res = await deliver.mutateAsync({
        provider: link.provider,
        member: member ? { externalId: member.externalId, displayName: member.displayName } : undefined,
      });
      if ("reason" in res) {
        // The caller's Valet email names nobody in the workspace. Not an
        // error — offer the member search when the provider has one, else
        // drop into the show-code flow.
        if (link.memberSearch) {
          setFallbackNote(
            `We couldn't find your ${title} account by your Valet email. Pick yourself from the list and we'll DM you the code.`,
          );
          setSearching(true);
          return;
        }
        setFallbackNote(
          `We couldn't find your ${title} account by your Valet email. Use the code below instead.`,
        );
        await showCode();
        return;
      }
      setDelivery(res);
      setPendingLink(null);
      setSearching(false);
      setStartError(null);
    } catch (err) {
      setStartError(startErrorMessage(err, title));
    }
  }

  const busy = startLink.isPending || deliver.isPending;

  return (
    <div className="space-y-2">
      <p className="text-xs leading-relaxed text-muted">
        Link your {title} account to chat with your assistant there.
      </p>
      {searching ? (
        <MemberSearch
          provider={link.provider}
          title={title}
          busy={busy}
          onPick={(member) => void deliverTo(member)}
          onCancel={() => setSearching(false)}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {link.codeDelivery ? (
            <>
              <Button
                size="sm"
                aria-label={`DM me the ${title} link code`}
                disabled={busy}
                onClick={() => void deliverTo()}
              >
                {deliver.isPending ? "Sending…" : "DM me the code"}
              </Button>
              {link.memberSearch && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Find my ${title} account by name`}
                  disabled={busy}
                  onClick={() => setSearching(true)}
                >
                  Find me by name
                </Button>
              )}
            </>
          ) : (
            <Button
              size="sm"
              aria-label={`Link ${title} account`}
              disabled={busy}
              onClick={() => void showCode()}
            >
              {startLink.isPending ? "Starting…" : "Link account"}
            </Button>
          )}
        </div>
      )}
      {startError && <p className="text-xs text-danger-500">{startError}</p>}
      {fallbackNote && <p className="text-xs leading-relaxed text-muted">{fallbackNote}</p>}
      {delivery && (
        <div className="space-y-1 rounded-md border border-line bg-ink-wash p-3">
          <p className="text-xs leading-relaxed text-muted">
            We DMed{" "}
            <span className="font-medium text-ink">
              {delivery.displayName ? `@${delivery.displayName}` : "you"}
            </span>{" "}
            on {title}. Reply with the <span className="font-mono">link</span> line to finish.
            The exact message:
          </p>
          <p className="whitespace-pre-wrap break-words font-mono text-xs text-ink">
            {delivery.messageText}
          </p>
          <ExpiryLine seconds={delivery.expiresInSeconds} />
        </div>
      )}
      {pendingLink && (
        <div className="space-y-1 rounded-md border border-line bg-ink-wash p-3">
          <p className="break-all font-mono text-xs text-ink">{pendingLink.code}</p>
          <p className="text-xs leading-relaxed text-muted">{pendingLink.instructions}</p>
          <ExpiryLine seconds={pendingLink.expiresInSeconds} />
        </div>
      )}
    </div>
  );
}
