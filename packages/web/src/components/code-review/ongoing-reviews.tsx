import { useId, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { CodeReviewWire } from "@valet/api/wire";
import { Badge, Button, ErrorRow, LoadingRow, WorkRow, WorkSection, textLinkClass } from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { pullRequestUrl } from "./review-lines";

const STATUS_LABEL: Record<CodeReviewWire["status"], string> = {
  running: "Reviewing…",
  complete: "Reviewed",
  failed: "Review failed",
};

export function OngoingReviews({ reviews, loading, error }: {
  reviews: CodeReviewWire[] | undefined;
  loading: boolean;
  error: Error | null;
}) {
  return (
    <WorkSection title="Ongoing reviews" count={loading || error ? undefined : reviews?.length}>
      {loading ? <LoadingRow label="Loading ongoing reviews…" />
        : error ? <ErrorRow>{errorText(error)}</ErrorRow>
        : !reviews?.length ? (
          <div className="px-4 py-6 text-sm text-muted sm:px-5">
            No ongoing reviews in this workspace. Open pull requests appear here when Valet starts reviewing them.
          </div>
        )
        : reviews.map((review) => <ReviewChain key={`${review.repo}#${review.number}`} review={review} />)}
    </WorkSection>
  );
}

function ReviewChain({ review }: { review: CodeReviewWire }) {
  const [expanded, setExpanded] = useState(false);
  const chainId = useId();
  const rounds = review.rounds;
  return (
    <div>
      <WorkRow
        title={<a href={pullRequestUrl(review.repo, review.number, review.reviewId)} target="_blank" rel="noreferrer">{`${review.repo}#${review.number}`}</a>}
        badge={<Badge variant={review.status === "failed" ? "danger" : review.status === "running" ? "accent" : "neutral"}>{STATUS_LABEL[review.status]}</Badge>}
        time={review.updatedAt}
        detail={(
          <>
            <span className="font-medium text-ink">{review.title}</span>
            <span className="mt-1 block">{review.head === undefined
              ? "Waiting for the first review result."
              : `${plural(review.openFindings, "open finding")}, ${review.resolvedFindings} fixed`}</span>
          </>
        )}
        actions={(
          <>
            {rounds.length > 0 && (
              <Button size="sm" variant="ghost" aria-expanded={expanded} aria-controls={chainId} onClick={() => setExpanded(!expanded)}>
                Review chain ({rounds.length})
              </Button>
            )}
            {review.threadId !== undefined && (
              <Link to="/threads/$threadId" params={{ threadId: review.threadId }} className={`${textLinkClass} text-sm`}>Open conversation</Link>
            )}
          </>
        )}
      />
      {expanded && (
        <ol id={chainId} aria-label={`Review chain for ${review.repo}#${review.number}`} className="divide-y divide-line border-t border-line bg-ink-wash sm:pl-4">
          {[...rounds].reverse().map((round) => (
            <li key={`${round.head}:${round.at}`}>
              <WorkRow
                title={(
                  <span className="flex flex-wrap items-center gap-2">
                    <span>{round.mode === "full" ? "Full review" : "Incremental review"}</span>
                    <a href={`https://github.com/${review.repo}/commit/${round.head}`} target="_blank" rel="noreferrer" className={`${textLinkClass} font-mono text-xs`}>{round.head.slice(0, 7)}</a>
                  </span>
                )}
                time={Number.isFinite(Date.parse(round.at)) ? Date.parse(round.at) : undefined}
                detail={`${plural(round.newFindings, "new finding")}, ${round.resolved} fixed${round.withdrawn > 0 ? `, ${round.withdrawn} withdrawn` : ""}${round.rules > 0 ? `, ${plural(round.rules, "team rule")}` : ""}`}
              />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}
