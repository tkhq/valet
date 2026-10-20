/**
 * Diagnostics on a line's page (docs/specs/2026-10-16-presence-hub-design.md
 * Part D step 1.8, Part F step 2): for an organization admin, a closed
 * disclosure that lists, per event, the intake trail and this line's
 * decision as the api records them. A member sees no Diagnostics, and the
 * page does not read them.
 */
import { Link } from "@tanstack/react-router";
import type { EventReceiptWire, ReceiptSubscriptionDecision } from "@valet/api/wire";
import { useRuleReceipts } from "~/api/rule";
import { receiptLabel } from "~/components/events/receipts-panel";
import { EmptyRow, ErrorRow, LoadingRow, WorkList, WorkRow } from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { eventInWords } from "./sentences";

const DECISION_WORDS: Record<ReceiptSubscriptionDecision["outcome"], string> = {
  matched: "matched",
  filter_excluded: "excluded by its filters",
  authorization_denied: "the sender may not use it",
  disabled: "it was off",
  key_mismatch: "a different event",
};

/** One intake record as a line: the event, then what this line decided. */
export function receiptLine(receipt: EventReceiptWire, lineId: string): string {
  const decision = receipt.subscriptions.find((d) => d.id === lineId);
  const event = eventInWords(receipt.eventKey);
  return decision ? `${event} · ${DECISION_WORDS[decision.outcome]}` : event;
}

/** The record's last stage and its outcome in words, such as `Delivery queue: Delivery queued`. */
export function lastStageInWords(receipt: EventReceiptWire): string | undefined {
  const last = receipt.stages.at(-1);
  return last ? `${receiptLabel(last.stage)}: ${receiptLabel(last.outcome)}` : undefined;
}

/** The disclosure. Render it only for an organization admin. */
export function Diagnostics({ id, name }: { id: string; name: string }) {
  const receiptsQ = useRuleReceipts(id, true);
  const receipts = receiptsQ.data?.receipts ?? [];
  return (
    <details className="group text-sm">
      {/* The muted line sits in the summary, so a closed disclosure still says what it holds. */}
      <summary className="cursor-pointer text-[13px] text-muted">
        <span className="font-medium hover:text-ink">Diagnostics</span>
        <span className="ml-2">How each event came in and was matched, step by step.</span>
      </summary>
      <div className="mt-3">
        <WorkList>
          {receiptsQ.isPending && <LoadingRow className="px-4" />}
          {receiptsQ.isError && (
            <ErrorRow className="px-4">{errorText(receiptsQ.error, "Could not load the diagnostics. Reload the page to try again.")}</ErrorRow>
          )}
          {receiptsQ.isSuccess && receipts.length === 0 && (
            <EmptyRow className="px-4 py-3">No event reached {name} in the last 7 days.</EmptyRow>
          )}
          {receipts.map((receipt) => (
            <WorkRow
              key={receipt.id}
              time={receipt.createdAt}
              title={receipt.eventId
                ? <Link to="/presence/events/$eventId" params={{ eventId: receipt.eventId }}>{receiptLine(receipt, id)}</Link>
                : receiptLine(receipt, id)}
              detail={lastStageInWords(receipt)}
            />
          ))}
        </WorkList>
      </div>
    </details>
  );
}
