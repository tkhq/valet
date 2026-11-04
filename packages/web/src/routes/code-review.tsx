import { useState, type ReactNode } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import type { CodeReviewWire, CreateEventSubscriptionRequest } from "@valet/api/wire";
import { useCodeReviews } from "~/api/code-review";
import { useCreateEventSubscription, useEventSubscriptions } from "~/api/events";
import { usePlugins } from "~/api/integrations";
import { useRepos } from "~/api/repos";
import { RepositoryRow } from "~/components/code-review/repository-row";
import { REVIEW_HANDLER, REVIEW_PLUGIN, isReviewLine, lineRepos, pullRequestUrl, reviewLineBody } from "~/components/code-review/review-lines";
import { handlerOptions } from "~/components/plugins/handler-settings";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  ErrorRow,
  LoadingRow,
  PageHeader,
  WorkRow,
  WorkSection,
  pageClass,
  textLinkClass,
} from "~/components/primitives";
import { RepoCombobox } from "~/components/repo-combobox";
import { WorkspaceClause } from "~/components/workspace-clause";
import { errorText } from "~/lib/error-text";
import { useListOwner } from "~/lib/use-list-owner";
import { useWorkspaceScope } from "~/lib/workspace-scope";

/**
 * `/code-review`: Valet Code Review for the active workspace. The PR review
 * plugin's handler reviews each push to a pull request and edits one review
 * in place. Each repository row is a line that hands the repository's pull
 * request events to that handler, so Presence lists the same lines. Recent
 * reviews come from the plugin's per-pull-request records.
 */
export const Route = createFileRoute("/code-review")({
  component: CodeReviewPage,
});

export function CodeReviewPage() {
  const scope = useWorkspaceScope();
  const owner = useListOwner();
  const pluginsQ = usePlugins();
  const linesQ = useEventSubscriptions(owner, { enabled: owner !== undefined });
  const reviewsQ = useCodeReviews(scope.teamId);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string | null>(null);

  const handler = handlerOptions(pluginsQ.data?.plugins).find((h) => h.plugin === REVIEW_PLUGIN && h.id === REVIEW_HANDLER);
  // The list also carries org-owned lines; only this workspace's lines are its own.
  const lines = (linesQ.data?.subscriptions ?? []).filter((sub) => isReviewLine(sub) && sub.ownerType === owner?.ownerType && sub.ownerId === owner.ownerId);
  const armed = new Set(lines.flatMap((line) => lineRepos(line) ?? []));

  const header = (
    <PageHeader
      className="mb-6"
      title="Code review"
      clause={<WorkspaceClause />}
      description="Valet reviews each push to an open pull request and keeps one review on it, edited in place."
      actions={handler !== undefined ? <Button onClick={() => setAdding(true)}>Add repository</Button> : undefined}
    />
  );

  if (pluginsQ.isLoading) return <Shell>{header}<LoadingRow label="Loading code review…" /></Shell>;
  if (pluginsQ.error) return <Shell>{header}<ErrorRow>Valet cannot load the plugins. Reload the page to try again.</ErrorRow></Shell>;
  if (handler === undefined) {
    return (
      <Shell>
        {header}
        <p className="text-sm text-muted">Code review is not installed on this deployment. Ask an org admin to load the PR review plugin.</p>
      </Shell>
    );
  }

  return (
    <Shell>
        {header}
        <div className="space-y-8">
          <WorkSection title="Repositories" count={lines.length}>
            {linesQ.isLoading ? <LoadingRow label="Loading repositories…" />
              : linesQ.error ? <ErrorRow>Valet cannot load this workspace's lines. Reload the page to try again.</ErrorRow>
              : lines.length === 0 ? (
                <div className="px-4 py-6 text-sm text-muted sm:px-5">
                  No repository has code review yet. Choose Add repository to pick one.
                </div>
              )
              : lines.map((line) => <RepositoryRow key={line.id} line={line} handler={handler} initiallyOpen={line.id === added} />)}
          </WorkSection>
          <RecentReviews reviews={reviewsQ.data?.reviews} loading={reviewsQ.isLoading} failed={reviewsQ.error != null} />
        </div>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="max-w-md">
          <DialogTitle>Add a repository</DialogTitle>
          <DialogDescription>Valet reviews new pushes to its pull requests with the default settings. Change them after you add it.</DialogDescription>
          <AddRepository
            armed={armed}
            body={(repo) => reviewLineBody(repo, handler, scope.teamId)}
            onAdded={(id) => { setAdded(id); setAdding(false); }}
          />
        </DialogContent>
      </Dialog>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return <div className="min-w-0 flex-1 overflow-y-auto"><div className={pageClass}>{children}</div></div>;
}

function RecentReviews({ reviews, loading, failed }: { reviews: CodeReviewWire[] | undefined; loading: boolean; failed: boolean }) {
  const shown = (reviews ?? []).slice(0, 20);
  return (
    <WorkSection title="Recent reviews" count={reviews?.length}>
      {loading ? <LoadingRow label="Loading reviews…" />
        : failed ? <ErrorRow>Valet cannot load the reviews. Reload the page to try again.</ErrorRow>
        : shown.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted sm:px-5">No reviews yet. Valet reviews the next push to a pull request in a repository above.</div>
        )
        : shown.map((r) => (
          <WorkRow
            key={`${r.repo}#${r.number}`}
            title={<a href={pullRequestUrl(r.repo, r.number, r.reviewId)} target="_blank" rel="noreferrer">{`${r.repo}#${r.number}`}</a>}
            time={r.updatedAt}
            detail={reviewDetail(r)}
            actions={r.threadId !== undefined
              ? <Link to="/threads/$threadId" params={{ threadId: r.threadId }} className={`${textLinkClass} text-sm`}>Open thread</Link>
              : undefined}
          />
        ))}
    </WorkSection>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** `2 open findings, 1 fixed, at a1b2c3d`. */
function reviewDetail(r: CodeReviewWire): string {
  if (r.head === undefined) return "Not reviewed yet";
  return `${plural(r.openFindings, "open finding")}, ${r.resolvedFindings} fixed, at ${r.head.slice(0, 7)}`;
}

/** The dialog's body. It mounts with the dialog, so the repositories load only when it opens. */
function AddRepository({ armed, body, onAdded }: {
  /** Repositories that already have a line. */
  armed: ReadonlySet<string>;
  body: (repo: string) => CreateEventSubscriptionRequest;
  onAdded: (lineId: string) => void;
}) {
  const reposQ = useRepos();
  const create = useCreateEventSubscription();
  const repos = (reposQ.data?.repos ?? []).filter((r) => !armed.has(r.fullName));
  return (
    <div className="mt-4 grid gap-2">
      {reposQ.isLoading ? <LoadingRow label="Loading repositories…" />
        : reposQ.data?.installed === false ? (
          <p className="text-sm text-muted">The GitHub App is not installed for this organization. Ask an org admin to install it in Settings.</p>
        )
        : <RepoCombobox repos={repos} label="Search repositories" onSelect={(repo) => create.mutate(body(repo.fullName), { onSuccess: (resp) => onAdded(resp.id) })} />}
      {create.error && <p role="alert" className="text-xs text-danger-500">{errorText(create.error)}</p>}
      {create.isPending && <p className="text-xs text-muted">Adding…</p>}
    </div>
  );
}
