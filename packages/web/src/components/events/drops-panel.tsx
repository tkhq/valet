/**
 * Problems tab — why events arrived but did not fire. The Activity feed shows
 * what ran; this shows what was dropped: a bad signature, the wrong workspace,
 * a missing credential, or (the common one) an event that matched no
 * subscription. It is the answer to "I set up a trigger and nothing happened."
 *
 * No payload is shown — the drop-log holds none. Each row names a corrective
 * action in its detail.
 */
import { EmptyRow, ErrorRow, LoadingRow } from "~/components/primitives";
import { useEventDrops } from "~/api/events";
import { relativeTime } from "~/lib/relative-time";

/** Human labels for the reasons ingest and the webhook routes record. An
 * unknown reason falls back to its raw string rather than hiding. */
const REASON_LABEL: Record<string, string> = {
  no_subscription_match: "No subscription",
  filter_excluded: "Filtered out",
  bad_signature: "Bad signature",
  foreign_workspace: "Wrong workspace",
  unknown_org: "Not connected",
  transport_unavailable: "Transport down",
  slack_retry: "Slow response",
  unlinked_sender: "Unlinked sender",
};

export function DropsPanel() {
  const dropsQ = useEventDrops();

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Events that arrived but did not become an activity row. If a trigger did not fire, the
        reason is here.
      </p>

      {dropsQ.data && (
        <p className="text-xs text-muted">
          {dropsQ.data.lastEventAt !== null
            ? `Last event received ${relativeTime(dropsQ.data.lastEventAt)}.`
            : "No event has reached Valet yet. Confirm the webhook URL is set in your integration's settings."}
        </p>
      )}

      {dropsQ.isPending && <LoadingRow label="Loading problems…" />}
      {dropsQ.error != null && <ErrorRow>Failed to load. Press refresh to try again.</ErrorRow>}
      {dropsQ.data && dropsQ.data.drops.length === 0 && (
        <EmptyRow>No problems in the recent window. Every event that arrived was handled.</EmptyRow>
      )}

      {dropsQ.data && dropsQ.data.drops.length > 0 && (
        <ul className="divide-y divide-line border-t border-line">
          {dropsQ.data.drops.map((drop) => (
            <li key={drop.id} className="flex items-start justify-between gap-3 py-3">
              <div className="min-w-0 space-y-0.5">
                <div className="text-sm font-medium text-ink">
                  {REASON_LABEL[drop.reason] ?? drop.reason}
                </div>
                <p className="text-xs leading-relaxed text-muted">{drop.detail}</p>
              </div>
              <span className="shrink-0 text-xs text-muted">{relativeTime(drop.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
