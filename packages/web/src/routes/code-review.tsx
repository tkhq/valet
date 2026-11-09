import { useState, type ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useCodeReviews } from "~/api/code-review";
import { useEventSubscriptions } from "~/api/events";
import { usePlugins } from "~/api/integrations";
import { useRepos } from "~/api/repos";
import { useTeams } from "~/api/settings";
import { AddRepositoryDialog } from "~/components/code-review/add-repository-dialog";
import { OngoingReviews } from "~/components/code-review/ongoing-reviews";
import { RepositoryRow } from "~/components/code-review/repository-row";
import { RepositorySetupRow } from "~/components/code-review/repository-setup-row";
import { RunReviewDialog } from "~/components/code-review/run-review-dialog";
import { belongsToWorkspace, repositoryInventory } from "~/components/code-review/repository-inventory";
import { REVIEW_HANDLER, REVIEW_PLUGIN, isReviewLine, isSingleRepositoryLine } from "~/components/code-review/review-lines";
import { handlerOptions } from "~/components/plugins/handler-settings";
import {
  Button,
  ErrorRow,
  Input,
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
  const linesQ = useEventSubscriptions();
  const reposQ = useRepos();
  const teamsQ = useTeams();
  const reviewsQ = useCodeReviews(scope.teamId);
  const [adding, setAdding] = useState(false);
  const [running, setRunning] = useState(false);
  const [repositorySearch, setRepositorySearch] = useState("");
  const [settingsRequest, setSettingsRequest] = useState<{ id: string; version: number } | null>(null);

  const handler = handlerOptions(pluginsQ.data?.plugins).find((h) => h.plugin === REVIEW_PLUGIN && h.id === REVIEW_HANDLER);
  const accessibleLines = (linesQ.data?.subscriptions ?? []).filter(isReviewLine);
  const lines = accessibleLines.filter((line) => belongsToWorkspace(line, owner));
  const inventory = repositoryInventory(reposQ.data?.repos ?? [], accessibleLines, owner);
  const loadingRepositories = linesQ.isLoading || reposQ.isLoading;
  const repositoryCount = inventory.repositories.length + inventory.rules.length;
  const repositoryQuery = repositorySearch.trim().toLowerCase();
  const visibleRepositories = inventory.repositories.filter((repo) => repo.name.toLowerCase().includes(repositoryQuery));
  const visibleRules = inventory.rules.filter((line) => line.name.toLowerCase().includes(repositoryQuery) || (line.filters.length === 0 && "every repository".includes(repositoryQuery)));
  const visibleCount = visibleRepositories.length + visibleRules.length;
  function scopeLabel(line: { ownerType: string; ownerId: string }) {
    if (line.ownerType === "user") return "Personal workspace";
    if (line.ownerType === "org") return "the organization";
    const team = teamsQ.data?.teams.find((candidate) => candidate.id === line.ownerId);
    return team ? `${team.name} workspace` : "another team workspace";
  }
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
      actions={handler !== undefined ? (
        <div className="flex gap-2">
          <Button variant="secondary" disabled={owner === undefined || lines.length === 0} onClick={() => setRunning(true)}>Review a pull request</Button>
          <Button disabled={owner === undefined} onClick={() => setAdding(true)}>Add repository</Button>
        </div>
      ) : undefined}
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
          <WorkSection title="Repositories" count={loadingRepositories || linesQ.error ? undefined : repositoryCount}>
            <div className="grid gap-2 px-4 py-3 sm:px-5">
              <Input size="sm" type="search" aria-label="Filter repositories" placeholder="Filter repositories…" value={repositorySearch} onChange={(event) => setRepositorySearch(event.target.value)} disabled={loadingRepositories || linesQ.error !== null} />
              {repositoryQuery && !loadingRepositories && !linesQ.error && <p className="text-xs text-muted">Showing {visibleCount} of {repositoryCount} repositories.</p>}
            </div>
            {loadingRepositories ? <LoadingRow label="Loading repositories…" />
              : linesQ.error ? <ErrorRow>Valet cannot load review configurations. Reload the page to try again.</ErrorRow>
              : <>
                {reposQ.error && <ErrorRow>Valet cannot load GitHub repositories. Reload the page to try again.</ErrorRow>}
                {repositoryCount === 0 && !reposQ.error && <div className="px-4 py-6 text-sm text-muted sm:px-5">No installed repositories or review configurations. Choose Add repository to set up code review.</div>}
                {repositoryCount > 0 && visibleCount === 0 && <div className="px-4 py-6 text-sm text-muted sm:px-5">No matching repositories. Try another filter.</div>}
                {visibleRepositories.map((repo) => repo.line && belongsToWorkspace(repo.line, owner) && isSingleRepositoryLine(repo.line)
                  ? <RepositoryRow key={`${repo.line.id}:${repo.name.toLowerCase()}`} repository={repo.name} installed={repo.installed} line={repo.line} handler={handler} openRequest={repo.line.id === settingsRequest?.id ? settingsRequest.version : undefined} />
                  : <RepositorySetupRow key={`${scope.key}:${repo.name.toLowerCase()}`} repository={repo.name} installed={repo.installed} line={repo.line} shared={repo.line !== undefined && !isSingleRepositoryLine(repo.line)} scopeLabel={repo.line ? scopeLabel(repo.line) : undefined} handler={handler} teamId={scope.teamId} disabled={owner === undefined || reposQ.error !== null} onAdded={openSettings} />)}
                {visibleRules.map((line) => belongsToWorkspace(line, owner)
                  ? <RepositoryRow key={line.id} line={line} handler={handler} openRequest={line.id === settingsRequest?.id ? settingsRequest.version : undefined} />
                  : <RepositorySetupRow key={line.id} repository={line.filters.some((filter) => filter.field === "repo") ? line.name : "Every repository"} installed={false} line={line} scopeLabel={scopeLabel(line)} handler={handler} onAdded={openSettings} />)}
              </>}
          </WorkSection>
          <OngoingReviews reviews={reviewsQ.data?.reviews} loading={reviewsQ.isLoading} error={reviewsQ.error} />
        </div>
      <RunReviewDialog open={running} onOpenChange={setRunning} teamId={scope.teamId} />
      <AddRepositoryDialog open={adding} onOpenChange={setAdding} lines={lines} handler={handler} teamId={scope.teamId} onAdded={openSettings} onExisting={openSettings} />
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return <div className="min-w-0 flex-1 overflow-y-auto"><div className={pageClass}>{children}</div></div>;
}
