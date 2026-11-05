import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { EventSubscriptionFilterWire, EventSubscriptionWire } from "@valet/api/wire";
import { ApiError } from "~/api/api-error";
import { useCreateEventSubscription, useEventSubscriptions } from "~/api/events";
import { useRepos } from "~/api/repos";
import { collisionsFromError } from "~/components/events/collision-notice";
import type { HandlerOption } from "~/components/plugins/handler-settings";
import { Button, Dialog, DialogContent, Input, LoadingRow, textLinkClass } from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { isReviewLine, reviewLineBody } from "./review-lines";

interface AddRepositoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lines: EventSubscriptionWire[];
  handler: HandlerOption;
  teamId?: string;
  onAdded: (id: string) => void;
  onExisting: (id: string) => void;
}

export function AddRepositoryDialog(props: AddRepositoryDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        title="Add a repository"
        description="Choose a repository to turn on code review, or manage its existing configuration."
        className="max-w-md gap-3"
      >
        {props.open && <RepositoryChoices {...props} />}
      </DialogContent>
    </Dialog>
  );
}

function coversRepository(line: EventSubscriptionWire, repo: string): boolean {
  return isReviewLine(line) && line.filters
    .filter((filter) => filter.field === "repo")
    .every((filter) => repositoryFilterMatches(repo, filter));
}

/** Mirrors events/match.ts, with case-insensitive GitHub repository identity for equality lists. */
function repositoryFilterMatches(repo: string, filter: EventSubscriptionFilterWire): boolean {
  const value = filter.value;
  switch (filter.op) {
    case "eq":
      return typeof value === "string" && repo.toLowerCase() === value.toLowerCase();
    case "in":
    case "not_in": {
      if (!Array.isArray(value)) return false;
      const included = value.some((entry) => entry.toLowerCase() === repo.toLowerCase());
      return included === (filter.op === "in");
    }
    case "prefix":
      return typeof value === "string" && repo.startsWith(value);
    case "contains":
      return typeof value === "string" && repo.includes(value);
    case "not_prefix":
      return typeof value === "string" && !repo.startsWith(value);
    case "regex":
    case "not_regex":
      if (typeof value !== "string") return false;
      try {
        return new RegExp(value).test(repo.slice(0, 2_000)) === (filter.op === "regex");
      } catch {
        return false;
      }
  }
}

function RepositoryChoices({ lines, handler, teamId, onAdded, onExisting }: AddRepositoryDialogProps) {
  const reposQ = useRepos();
  // Other workspaces can already review a repository. Offer their settings
  // before a create request reaches the server's collision gate.
  const linesQ = useEventSubscriptions();
  const create = useCreateEventSubscription();
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const repos = (reposQ.data?.repos ?? []).filter((repo) => repo.fullName.toLowerCase().includes(query));
  const allLines = linesQ.data?.subscriptions ?? [];
  const rowClass = "h-auto w-full min-w-0 justify-between whitespace-normal rounded-none text-left hover:bg-ink-wash";

  return (
    <div className="grid min-w-0 gap-3">
      <Input
        type="search"
        aria-label="Search repositories"
        placeholder="Search repositories…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        disabled={create.isPending}
      />
      {reposQ.isLoading ? <LoadingRow label="Loading repositories…" />
        : reposQ.error ? (
          <div className="grid justify-items-start gap-2">
            <p role="alert" className="text-sm text-danger-500">Valet cannot load repositories. Try again.</p>
            <Button variant="secondary" onClick={() => void reposQ.refetch()}>Try again</Button>
          </div>
        )
        : linesQ.isLoading ? <LoadingRow label="Loading review configurations…" />
        : linesQ.error ? (
          <div className="grid justify-items-start gap-2">
            <p role="alert" className="text-sm text-danger-500">Valet cannot load review configurations. Try again.</p>
            <Button variant="secondary" onClick={() => void linesQ.refetch()}>Try again</Button>
          </div>
        )
        : reposQ.data?.installed === false ? (
          <p className="text-sm text-muted">The GitHub App is not installed for this organization. Ask an org admin to install it in Settings.</p>
        )
        : repos.length === 0 ? (
          <p className="text-sm text-muted">{query ? "No matching repositories. Try another search." : "No repositories are available. Check GitHub access in Integrations."}</p>
        )
        : (
          <div aria-label="Repository choices" className="max-h-[min(16rem,40dvh)] overflow-y-auto overscroll-contain rounded border border-line divide-y divide-line">
            {repos.map((repo) => {
              const local = lines.find((line) => coversRepository(line, repo.fullName));
              const foreign = allLines.filter((line) => coversRepository(line, repo.fullName));
              const existing = local ?? foreign.find((line) => line.enabled) ?? foreign[0];
              const foreignActive = existing !== undefined && !local && existing.enabled;
              const add = () => create.mutate(reviewLineBody(repo.fullName, handler, teamId), { onSuccess: (response) => onAdded(response.id) });
              const details = (
                <span className="flex w-full min-w-0 items-center justify-between gap-3 py-2">
                  <span className="min-w-0">
                    <span className="block break-words [overflow-wrap:anywhere]">{repo.fullName}</span>
                    {existing && <span className="block text-xs text-muted">{local ? (existing.enabled ? "Configured" : "Reviews off") : existing.enabled ? "Configured in another workspace" : "Reviews off in another workspace"}</span>}
                  </span>
                  <span className="shrink-0 text-xs text-muted">{local ? "Manage" : foreignActive ? "Open configuration" : "Add"}</span>
                </span>
              );
              if (foreignActive) {
                return (
                  <Button key={repo.fullName} asChild size="md" variant="ghost" className={rowClass}>
                    <Link to="/presence/rules/$id" params={{ id: existing.id }} aria-disabled={create.isPending} tabIndex={create.isPending ? -1 : undefined} onClick={(event) => { if (create.isPending) event.preventDefault(); }}>{details}</Link>
                  </Button>
                );
              }
              return (
                <div key={repo.fullName}>
                  <Button
                    size="md"
                    variant="ghost"
                    className={rowClass}
                    disabled={create.isPending}
                    onClick={() => { if (local) onExisting(local.id); else add(); }}
                  >
                    {details}
                  </Button>
                  {existing && !local && (
                    <div className="px-3.5 pb-2 text-xs">
                      <Link to="/presence/rules/$id" params={{ id: existing.id }} className={textLinkClass} aria-disabled={create.isPending} tabIndex={create.isPending ? -1 : undefined} onClick={(event) => { if (create.isPending) event.preventDefault(); }}>Open configuration</Link>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      {create.error && <CreateError error={create.error} />}
      {create.isPending && <p role="status" className="text-sm text-muted">Adding repository…</p>}
    </div>
  );
}

function CreateError({ error }: { error: Error }) {
  if (error instanceof ApiError && error.status === 409) {
    const collisions = collisionsFromError(error);
    const existing = [...(collisions?.blocking ?? []), ...(collisions?.overlapping ?? [])];
    return (
      <div role="alert" className="grid gap-1 text-sm">
        <p className="text-danger-500">Already configured. Open its configuration in Presence.</p>
        {existing.length > 0 ? existing.map(({ subscription }) => (
          <Link key={subscription.id} to="/presence/rules/$id" params={{ id: subscription.id }} className={`${textLinkClass} break-words [overflow-wrap:anywhere]`}>{subscription.name}</Link>
        )) : <Link to="/presence" className={textLinkClass}>Open Presence</Link>}
      </div>
    );
  }
  return <p role="alert" className="text-sm text-danger-500">{errorText(error)}</p>;
}
