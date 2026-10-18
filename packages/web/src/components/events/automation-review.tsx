import type { ReactNode } from "react";

type Row = readonly [string, ReactNode];

/** The optional rows every review shares: delivery, audience, replaces, permissions. */
function sharedRows({ permissions, workflowId, follow, audience, replaces }: {
  permissions?: ReactNode;
  workflowId?: string;
  follow?: boolean;
  audience?: string;
  replaces?: string;
}): Row[] {
  return [
    ...(follow !== undefined ? [["Delivery", follow ? "Also deliver later replies from the source thread" : "Deliver only events matching these filters"] as const] : []),
    ...(audience ? [["Audience", audience === "team" ? "Team members" : "Anyone in the organization"] as const] : []),
    ...(replaces ? [["Replaces", replaces] as const] : []),
    ["Permissions", permissions ?? (workflowId ? <span><a className="text-moss underline" href={`/workflows/${encodeURIComponent(workflowId)}`} target="_blank" rel="noreferrer">Review workflow permissions</a>. Enabling grants no new access. Dynamic actions are checked at runtime.</span> : "Uses this workspace’s existing access. Enabling does not grant new permissions.")],
  ];
}

function SummaryList({ rows }: { rows: readonly Row[] }) {
  // Each term appears once in a review, so the term keys its row.
  return <dl aria-label="Summary" className="divide-y divide-line rounded-lg border border-line px-3">
    {rows.map(([label, value]) => <div key={label} className="grid gap-1 py-3 text-sm sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-muted">{label}</dt><dd className="min-w-0 break-words">{value || "Not configured"}</dd>
    </div>)}
  </dl>;
}

/** The same review vocabulary for assistant proposals and manual setup. */
export function AutomationReview({ when, scope, result, destination, permissions, workflowId, follow, audience, replaces }: {
  when: ReactNode;
  scope: ReactNode;
  result: ReactNode;
  destination: ReactNode;
  permissions?: ReactNode;
  workflowId?: string;
  follow?: boolean;
  audience?: string;
  /** What enabling this one does to the subscription it replaces. */
  replaces?: string;
}) {
  const rows: Row[] = [
    ["When", when], ["Scope", scope], ["Result", result], ["Destination", destination],
    ...sharedRows({ permissions, workflowId, follow, audience, replaces }),
  ];
  return <SummaryList rows={rows} />;
}

/** One fact of a line or a routine, in words: When, Do, Runs in, Appears as. */
export interface ReviewFact {
  term: string;
  value: ReactNode;
}

/**
 * A review in the Presence words: the sentence first, then the facts the
 * fact strip shows (When, Do, Runs in, Appears as). It never shows an event
 * key, a cron expression, or a raw filter.
 */
export function SentenceReview({ sentence, facts, permissions, workflowId, follow, audience, replaces }: {
  /** The sentence, when the review leads with it. */
  sentence?: ReactNode;
  facts: readonly ReviewFact[];
  permissions?: ReactNode;
  workflowId?: string;
  follow?: boolean;
  audience?: string;
  replaces?: string;
}) {
  const rows: Row[] = [
    ...facts.map((fact): Row => [fact.term, fact.value]),
    ...sharedRows({ permissions, workflowId, follow, audience, replaces }),
  ];
  return (
    <div className="space-y-3">
      {sentence !== undefined && <p data-testid="review-sentence" className="text-base leading-relaxed text-ink">{sentence}</p>}
      <SummaryList rows={rows} />
    </div>
  );
}
