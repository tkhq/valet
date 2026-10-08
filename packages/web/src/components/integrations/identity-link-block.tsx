/**
 * Account pairing: link a provider account to the Valet user. Settings →
 * Connected accounts and the org-provided Integrations tile both render it.
 * Two ways in when the provider can DM (`codeDelivery`), as in v1:
 *
 *   DM me on <title> → `POST /api/me/identity-links/:provider/deliver`. The
 *                      server finds the member by their Valet email and DMs
 *                      them a link code. The person enters that code here
 *                      (`POST .../verify`). Reading the DM proves the
 *                      provider account; entering the code here proves the
 *                      Valet user. The code is bound to both and is never
 *                      redeemable from chat.
 *   Find me by name  → `GET .../members` typeahead; picking a member DMs
 *                      that account. For users whose provider email differs
 *                      from their Valet email. Requires `memberSearch`.
 *
 * With `offerOAuth`, "Sign in with <title>" starts the provider's OAuth
 * connect, which links the account with no code.
 *
 * The show-code flow (`POST .../start`: the card shows the code and the
 * provider's delivery instructions) is never a third button. It is the single "Link account" flow for
 * providers without `codeDelivery` (Telegram), and the automatic fallback
 * when the email lookup 202s and the provider has no member directory.
 *
 * The block renders only for providers `GET /api/me/identity-links` lists,
 * i.e. plugins that declare `identityLink`. Once a code is out, the block
 * polls the link list so it flips to "Linked" when the flow completes.
 */
import { useEffect, useState, type ReactNode } from "react";
import type {
  DeliverIdentityLinkResponse,
  IdentityLinkStatus,
  LinkMemberEntry,
  StartIdentityLinkResponse,
} from "@valet/api/wire";
import { Button, ConfirmDialog, Input } from "~/components/primitives";
import { CopyButton } from "~/components/session/tool-renderers/tool-shell";
import {
  useDeliverIdentityLink,
  useIdentityLinks,
  useLinkMembers,
  useStartIdentityLink,
  useUnlinkIdentity,
  useVerifyIdentityLink,
} from "~/api/queries";
import { ApiError } from "~/api/client";
import { errorText } from "~/lib/error-text";

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

function startErrorMessage(err: unknown, title: string, fallback = `Couldn't start the ${title} link. Try again.`): string {
  if (err instanceof ApiError && err.payload && typeof err.payload === "object") {
    const message = (err.payload as Record<string, unknown>).error;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
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

/** The one panel both waiting states render: the value to send (a code or a
 * full reply line), an optional note, and the expiry. One component so the
 * DM path and the show-code path cannot drift apart. */
function CodePanel({
  intro,
  value,
  note,
  expiresInSeconds,
}: {
  intro?: ReactNode;
  value: string;
  note?: string;
  expiresInSeconds: number;
}) {
  return (
    <div className="space-y-1 rounded-md border border-line bg-ink-wash p-3">
      {intro}
      <div className="flex items-center gap-1">
        <p className="break-all font-mono text-xs text-ink">{value}</p>
        <CopyButton getText={() => value} label="Copy" className="shrink-0 opacity-100" />
      </div>
      {note !== undefined && <p className="text-xs leading-relaxed text-muted">{note}</p>}
      <ExpiryLine seconds={expiresInSeconds} />
    </div>
  );
}

/** After the bot DMs a code: the person types it here, as in v1. Reading
 * the DM proves the provider account; entering the code here proves the
 * Valet user. A match links the account and the card flips to "Linked". */
function EnterCodeForm({
  provider,
  recipient,
  title,
  expiresInSeconds,
}: {
  provider: string;
  recipient: string;
  title: string;
  expiresInSeconds: number;
}) {
  const [code, setCode] = useState("");
  const verify = useVerifyIdentityLink();
  return (
    <form
      className="space-y-1 rounded-md border border-line bg-ink-wash p-3"
      onSubmit={(e) => {
        e.preventDefault();
        verify.mutate({ provider, code: code.trim() });
      }}
    >
      <p className="text-xs leading-relaxed text-muted">
        We DMed <span className="font-medium text-ink">{recipient}</span> on {title}. Enter the code from that
        message.
      </p>
      <div className="flex items-center gap-2">
        <Input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Link code"
          aria-label={`${title} link code`}
          autoFocus
          autoComplete="one-time-code"
          className="h-8 font-mono text-xs"
        />
        <Button type="submit" size="sm" disabled={verify.isPending || code.trim() === ""}>
          {verify.isPending ? "Linking…" : "Link"}
        </Button>
      </div>
      {verify.error && (
        <p className="text-xs text-danger-500">
          {startErrorMessage(verify.error, title, "Couldn't check the code. Submit it again.")}
        </p>
      )}
      <ExpiryLine seconds={expiresInSeconds} />
    </form>
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

/**
 * `offerOAuth` adds "Sign in with <title>" when the deployment can run the
 * provider's OAuth connect (`link.oauthService`), which links the account
 * with no code. Settings turns it on. The Integrations page leaves it off
 * because that service already has its own tile there.
 */
export function IdentityLinkBlock({
  link,
  title,
  offerOAuth = false,
}: {
  link: IdentityLinkStatus;
  title: string;
  offerOAuth?: boolean;
}) {
  const [pendingLink, setPendingLink] = useState<StartIdentityLinkResponse | null>(null);
  const [delivery, setDelivery] = useState<DeliverIdentityLinkResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [fallbackNote, setFallbackNote] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const startLink = useStartIdentityLink();
  const deliver = useDeliverIdentityLink();
  const unlink = useUnlinkIdentity(link.provider);

  // A code is out — poll so the tile flips to "Linked" as soon as the user
  // completes the flow in the provider app.
  const awaitingReply = !link.linked && (pendingLink !== null || delivery !== null);
  useIdentityLinks(awaitingReply ? { refetchInterval: 3000 } : undefined);

  // Codes die after expiresInSeconds. Clear the waiting state then: it stops
  // the poll (an abandoned visible tab would otherwise poll forever) and
  // removes a code the bot no longer accepts from the screen.
  const expiresInSeconds = delivery?.expiresInSeconds ?? pendingLink?.expiresInSeconds;
  useEffect(() => {
    if (expiresInSeconds === undefined) return;
    const timer = setTimeout(() => {
      setDelivery(null);
      setPendingLink(null);
      setStartError("The code expired. Start again.");
    }, expiresInSeconds * 1000);
    return () => clearTimeout(timer);
  }, [expiresInSeconds, delivery, pendingLink]);

  if (link.linked) {
    // Deleting the pairing row costs two things a person would not guess from
    // "Unlink": inbound messages stop resolving to this user, and attention
    // pings on the provider stop with them.
    const unlinkDescription =
      `Messages from this ${title} account stop reaching your assistant, and it stops ` +
      `pinging you there when a thread needs you. To undo this, link the account ` +
      `again with a new code.`;
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
            // Radix fires no `onOpenChange(true)` here, so the stale refusal is cleared on open.
            unlink.reset();
            setConfirmUnlink(true);
          }}
        >
          {unlink.isPending ? "Unlinking…" : "Unlink"}
        </Button>
        <ConfirmDialog
          open={confirmUnlink}
          onOpenChange={setConfirmUnlink}
          title={`Unlink ${title}?`}
          description={unlinkDescription}
          confirmLabel="Unlink"
          pendingLabel="Unlinking…"
          pending={unlink.isPending}
          error={unlink.error != null ? errorText(unlink.error) : undefined}
          onConfirm={() => unlink.mutate(undefined, { onSuccess: () => setConfirmUnlink(false) })}
        />
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
      // The DM did not go out (or the lookup broke). Fall back to a shown
      // code so the card still offers a way to finish — there is no
      // show-code button to point the user at — then surface why, after,
      // because showCode clears the error slot on success.
      await showCode();
      setStartError(startErrorMessage(err, title));
    }
  }

  const busy = startLink.isPending || deliver.isPending;
  const oauthService = offerOAuth ? link.oauthService : undefined;

  return (
    <div className="space-y-2">
      <p className="text-xs leading-relaxed text-muted">
        Link your {title} account to chat with your assistant there.
      </p>
      {oauthService && !searching && (
        <p className="text-xs leading-relaxed text-muted">
          Sign in with {title} also lets Valet search, read, and post in {title} as you. The DM options link
          your account only.
        </p>
      )}
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
          {oauthService && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                window.location.href = `/api/credentials/${encodeURIComponent(oauthService)}/connect?landing=connected-accounts`;
              }}
            >
              Sign in with {title}
            </Button>
          )}
          {link.codeDelivery ? (
            <>
              <Button
                size="sm"
                aria-label={`DM me on ${title}`}
                disabled={busy}
                onClick={() => void deliverTo()}
              >
                {deliver.isPending ? "Sending…" : `DM me on ${title}`}
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
        <EnterCodeForm
          provider={link.provider}
          recipient={delivery.displayName ? `@${delivery.displayName}` : "you"}
          title={title}
          expiresInSeconds={delivery.expiresInSeconds}
        />
      )}
      {pendingLink && (
        <CodePanel
          intro={
            pendingLink.deepLink ? (
              <a
                href={pendingLink.deepLink}
                target="_blank"
                rel="noreferrer"
                className="text-xs font-medium text-moss underline"
              >
                Open {title} and press Start
              </a>
            ) : undefined
          }
          value={pendingLink.code}
          note={pendingLink.instructions}
          expiresInSeconds={pendingLink.expiresInSeconds}
        />
      )}
    </div>
  );
}
