import { useState, type ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useCodeReviews } from "~/api/code-review";
import { useEventSubscriptions } from "~/api/events";
import { usePlugins } from "~/api/integrations";
import { AddRepositoryDialog } from "~/components/code-review/add-repository-dialog";
import { OngoingReviews } from "~/components/code-review/ongoing-reviews";
import { RepositoryRow } from "~/components/code-review/repository-row";
import { REVIEW_HANDLER, REVIEW_PLUGIN, isReviewLine } from "~/components/code-review/review-lines";
import { handlerOptions } from "~/components/plugins/handler-settings";
import {
  Button,
  ErrorRow,
  LoadingRow,
  PageHeader,
  WorkSection,
  pageClass,
} from "~/components/primitives";
import { WorkspaceClause } from "~/components/workspace-clause";
import { useListOwner } from "~/lib/use-list-owner";
import { useWorkspaceScope } from "~/lib/workspace-scope";

/**
 * `/code-review`: Valet Code Review for the active workspace. The PR review
 * plugin's handler reviews each push to a pull request and edits one review
 * in place. Each repository row is a line that hands the repository's pull
 * request events to that handler, so Presence lists the same lines. Ongoing
 * reviews show open pull requests and their review chains.
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
  const [settingsRequest, setSettingsRequest] = useState<{ id: string; version: number } | null>(null);

  const handler = handlerOptions(pluginsQ.data?.plugins).find((h) => h.plugin === REVIEW_PLUGIN && h.id === REVIEW_HANDLER);
  // The list also carries org-owned lines; only this workspace's lines are its own.
  const lines = (linesQ.data?.subscriptions ?? []).filter((sub) => isReviewLine(sub) && sub.ownerType === owner?.ownerType && sub.ownerId === owner.ownerId);
  function openSettings(id: string) {
    setSettingsRequest((previous) => ({ id, version: (previous?.version ?? 0) + 1 }));
    setAdding(false);
  }

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
              : lines.map((line) => <RepositoryRow key={line.id} line={line} handler={handler} openRequest={line.id === settingsRequest?.id ? settingsRequest.version : undefined} />)}
          </WorkSection>
          <OngoingReviews reviews={reviewsQ.data?.reviews} loading={reviewsQ.isLoading} error={reviewsQ.error} />
        </div>
      <AddRepositoryDialog open={adding} onOpenChange={setAdding} lines={lines} handler={handler} teamId={scope.teamId} onAdded={openSettings} onExisting={openSettings} />
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return <div className="min-w-0 flex-1 overflow-y-auto"><div className={pageClass}>{children}</div></div>;
}
