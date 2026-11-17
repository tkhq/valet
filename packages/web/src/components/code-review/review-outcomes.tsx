import type { CodeReviewOutcomeWire } from "@valet/api/wire";
import { Badge, ErrorRow, LoadingRow, WorkRow, WorkSection } from "~/components/primitives";
import { errorText } from "~/lib/error-text";

/**
 * What authors did with Valet's findings, per repository and build. The
 * address rate is the share of findings on merged pull requests whose
 * flagged lines changed before the merge. It compares builds and
 * repositories; it is not a precision score. A shadow line's row counts
 * the findings it would have posted in its latest review of each pull request.
 */
export function ReviewOutcomes({ outcomes, loading, error }: {
  outcomes: CodeReviewOutcomeWire[] | undefined;
  loading: boolean;
  error: Error | null;
}) {
  return (
    <WorkSection title="Review outcomes" count={loading || error ? undefined : outcomes?.length}>
      {loading ? <LoadingRow label="Loading review outcomes…" />
        : error ? <ErrorRow>{errorText(error)}</ErrorRow>
        : !outcomes?.length ? (
          <div className="px-4 py-6 text-sm text-muted sm:px-5">
            No outcomes yet. When a reviewed pull request closes, Valet records what happened to each finding.
          </div>
        )
        : outcomes.map((o) => <OutcomeRow key={`${o.repo}:${o.build ?? ""}:${o.shadow ? "shadow" : "live"}`} outcome={o} />)}
    </WorkSection>
  );
}

function OutcomeRow({ outcome: o }: { outcome: CodeReviewOutcomeWire }) {
  const rate = o.merged > 0 ? Math.round((o.addressed / o.merged) * 100) : undefined;
  return (
    <WorkRow
      title={o.repo}
      badge={(
        <>
          {o.shadow && <Badge variant="accent">Shadow</Badge>}
          {rate !== undefined && <Badge variant="neutral">{`${rate}% addressed`}</Badge>}
        </>
      )}
      time={Date.parse(o.lastPostedAt)}
      detail={(
        <>
          <span className="block">{o.build ? `Build ${o.build.slice(0, 9)}` : "Build unknown"}</span>
          <span className="mt-1 block tabular-nums">
            {o.merged > 0
              ? `${o.posted} posted, ${o.merged} on merged pull requests: ${o.addressed} addressed, ${o.rejected} rejected, ${o.ignored} ignored`
              : `${o.posted} posted, none on a merged pull request yet`}
          </span>
        </>
      )}
    />
  );
}
