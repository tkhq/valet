import { useEffect, useState } from "react";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import type { ChangelogCategory } from "@valet/api/wire";
import { useChangelog } from "~/api/changelog";
import { useMe } from "~/api/settings";
import { Pager } from "~/components/pager";
import { Badge, Spinner } from "~/components/primitives";
import { SearchInput } from "~/components/search-input";
import {
  CHANGELOG_CATEGORIES,
  clampPage,
  filterAndSortCheckpoints,
  groupChangelogEntries,
  pageCount,
  paginateCheckpoints,
  type ChangelogCategoryFilter,
  type ChangelogSort,
} from "~/lib/changelog-view";
import {
  lastSeenCheckpoint,
  markChangelogSeen,
  unreadCheckpointIds,
} from "~/lib/changelog-read-state";
import { textParam } from "~/lib/search-params";

export interface ChangelogSearch {
  category?: ChangelogCategory;
  sort?: ChangelogSort;
  q?: string;
  page?: number;
}

export function readChangelogSearch(raw: unknown): ChangelogSearch {
  const category = textParam(raw, "category");
  const sort = textParam(raw, "sort");
  let rawPage: unknown;
  if (typeof raw === "object" && raw !== null) {
    // The guard establishes an object. The cast only makes its keys readable.
    rawPage = (raw as Record<string, unknown>).page;
  }
  const parsedPage = typeof rawPage === "number" ? rawPage : Number(rawPage);

  return {
    category: CHANGELOG_CATEGORIES.find((value) => value === category),
    sort: sort === "oldest" ? "oldest" : undefined,
    q: textParam(raw, "q"),
    page: Number.isInteger(parsedPage) && parsedPage > 1 ? parsedPage : undefined,
  };
}

export const Route = createFileRoute("/changelog")({
  component: ChangelogPage,
  validateSearch: readChangelogSearch,
});

const CATEGORY: Record<ChangelogCategory, { label: string }> = {
  feature: { label: "Features" },
  improvement: { label: "Improvements" },
  fix: { label: "Fixes" },
  security: { label: "Security" },
};

function releaseDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(value));
}

function buildDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function ChangelogPage() {
  const changelog = useChangelog();
  const me = useMe();
  const checkpoints = changelog.data?.manifest.checkpoints ?? [];
  const [seenWhenOpened, setSeenWhenOpened] = useState<string | null>();
  const search = readChangelogSearch(useSearch({ strict: false }));
  const navigate = useNavigate();
  const category: ChangelogCategoryFilter = search.category ?? "all";
  const sort: ChangelogSort = search.sort ?? "newest";
  const query = search.q ?? "";
  const requestedPage = search.page ?? 1;
  const unread = seenWhenOpened === undefined
    ? new Set<string>()
    : unreadCheckpointIds(checkpoints, seenWhenOpened);
  const newestId = checkpoints[0]?.id;
  const visibleCheckpoints = filterAndSortCheckpoints(checkpoints, category, query, sort);
  const totalPages = pageCount(visibleCheckpoints.length);
  const currentPage = clampPage(requestedPage, totalPages);
  const pageCheckpoints = paginateCheckpoints(visibleCheckpoints, currentPage);

  function go(next: Partial<ChangelogSearch>): void {
    void navigate({ to: "/changelog", search: { ...search, ...next } });
  }

  useEffect(() => {
    if (!me.data || !newestId || seenWhenOpened !== undefined) return;
    setSeenWhenOpened(lastSeenCheckpoint(me.data.id));
    markChangelogSeen(me.data.id, newestId);
  }, [me.data, newestId, seenWhenOpened]);

  useEffect(() => {
    if (changelog.isPending || requestedPage === currentPage) return;
    void navigate({
      to: "/changelog",
      search: { ...search, page: currentPage === 1 ? undefined : currentPage },
      replace: true,
    });
    // The page bounds are the trigger. Router hook identities do not change
    // which invalid page must be replaced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changelog.isPending, currentPage, requestedPage]);

  if (changelog.isPending) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted">
        <Spinner size={14} /> Loading changelog…
      </div>
    );
  }
  if (changelog.isError) {
    return (
      <div className="flex-1 p-8 text-sm text-danger-500">
        Could not load the changelog. Reload the page to try again.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
        <h1 className="font-display text-2xl text-ink">Changelog</h1>
        <p className="mt-2 text-sm text-muted">Changes in rolling builds and released versions.</p>

        {changelog.data.artifact.status === "latest-known" && (
          <div className="mt-6 rounded border border-line bg-ink-wash px-3 py-2 text-sm text-ink">
            This build has no release checkpoint. The latest known checkpoint is shown.
          </div>
        )}

        {checkpoints.length > 0 && (
          <div className="mt-6 grid gap-3 rounded border border-line bg-ink-wash p-3 sm:grid-cols-[minmax(12rem,1fr)_auto_auto] sm:items-center">
            <SearchInput
              value={query}
              onSettled={(value) =>
                go({ q: value.trim().length === 0 ? undefined : value, page: undefined })
              }
              placeholder="Search changes…"
              aria-label="Search changes"
              className="bg-paper"
            />
            <select
              aria-label="Filter by change type"
              value={category}
              onChange={(event) => {
                const next = CHANGELOG_CATEGORIES.find((value) => value === event.target.value);
                go({ category: next, page: undefined });
              }}
              className="h-9 max-sm:min-h-11 max-sm:text-base rounded border border-line bg-paper px-3 text-sm text-ink"
            >
              <option value="all">All change types</option>
              {CHANGELOG_CATEGORIES.map((value) => (
                <option key={value} value={value}>{CATEGORY[value].label}</option>
              ))}
            </select>
            <select
              aria-label="Sort releases"
              value={sort}
              onChange={(event) =>
                go({ sort: event.target.value === "oldest" ? "oldest" : undefined, page: undefined })
              }
              className="h-9 max-sm:min-h-11 max-sm:text-base rounded border border-line bg-paper px-3 text-sm text-ink"
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
          </div>
        )}

        {checkpoints.length === 0 ? (
          <p className="mt-10 text-sm text-muted">No release checkpoints are available for this build.</p>
        ) : visibleCheckpoints.length === 0 ? (
          <div className="mt-10 rounded border border-line px-4 py-8 text-center">
            <p className="text-sm font-medium text-ink">No changes match these filters.</p>
            <p className="mt-1 text-sm text-muted">Change the type filter or search terms.</p>
          </div>
        ) : (
          <>
            <div className="mt-8 space-y-10">
              {pageCheckpoints.map((checkpoint) => {
                const unreleased = checkpoint.kind === "unreleased";
                const checkpointSha = unreleased ? checkpoint.buildSha : checkpoint.releasedSha;
                const checkpointUrl = unreleased ? checkpoint.buildUrl : checkpoint.releaseUrl;
                const groups = groupChangelogEntries(checkpoint.entries);
                return (
                  <section key={checkpoint.id} aria-labelledby={`release-${checkpoint.id}`}>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line pb-2">
                      <h2 id={`release-${checkpoint.id}`} className="font-display text-xl text-ink">
                        {unreleased ? "Unreleased" : checkpoint.version}
                      </h2>
                      <span className="text-sm text-muted">
                        {unreleased ? buildDate(checkpoint.builtAt) : releaseDate(checkpoint.releasedAt)}
                      </span>
                      {unread.has(checkpoint.id) && <Badge variant="accent">New</Badge>}
                      <div className="ml-auto flex items-center gap-3 text-xs text-muted">
                        {unreleased && (
                          <a
                            href={`https://github.com/tkhq/valet/commit/${checkpointSha}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex max-sm:min-h-11 items-center font-mono hover:text-moss hover:underline"
                          >
                            Build {checkpointSha.slice(0, 9)}
                          </a>
                        )}
                        {checkpointUrl && (
                          <a
                            href={checkpointUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex max-sm:min-h-11 items-center gap-1 text-moss hover:underline"
                          >
                            {unreleased ? "Build" : "Release"} <ExternalLink className="h-3 w-3" aria-hidden />
                          </a>
                        )}
                      </div>
                    </div>

                    {checkpoint.entries.length === 0 ? (
                      <p className="py-4 text-sm text-muted">
                        {unreleased
                          ? "No user-facing changes are pending in this build."
                          : "No user-facing changes shipped in this release."}
                      </p>
                    ) : (
                      <div className="divide-y divide-line">
                        {groups.map((group) => {
                          const presentation = CATEGORY[group.category];
                          return (
                            <div key={group.category} className="grid py-3 md:grid-cols-[8rem_minmax(0,1fr)] md:gap-4">
                              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted md:mb-0 md:pt-0.5">
                                {presentation.label}
                              </h3>
                              <ul className="divide-y divide-line">
                                {group.entries.map((entry) => {
                                  const commit = entry.sources.commitSha;
                                  return (
                                    <li key={`${checkpoint.id}-${commit}`} className="py-2 first:pt-0 last:pb-0">
                                      <div className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-4">
                                        <div className="min-w-0">
                                          <h4 className="font-medium leading-5 text-ink">{entry.title}</h4>
                                          {entry.description && (
                                            <p className="mt-0.5 text-sm leading-5 text-muted">{entry.description}</p>
                                          )}
                                        </div>
                                        <div className="flex items-start gap-3 text-xs text-muted sm:pt-0.5">
                                          {entry.sources.pullRequest && (
                                            <a
                                              href={`https://github.com/tkhq/valet/pull/${entry.sources.pullRequest}`}
                                              target="_blank"
                                              rel="noreferrer"
                                              className="inline-flex max-sm:min-h-11 items-center whitespace-nowrap hover:text-moss hover:underline"
                                            >
                                              PR #{entry.sources.pullRequest}
                                            </a>
                                          )}
                                          <a
                                            href={`https://github.com/tkhq/valet/commit/${commit}`}
                                            target="_blank"
                                            rel="noreferrer"
                                            aria-label={`Commit ${commit}`}
                                            className="inline-flex max-sm:min-h-11 items-center font-mono hover:text-moss hover:underline"
                                          >
                                            {commit.slice(0, 9)}
                                          </a>
                                        </div>
                                      </div>
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>

            {totalPages > 1 && (
              <div className="mt-8 border-t border-line">
                <Pager
                  label="changelog"
                  page={currentPage}
                  totalPages={totalPages}
                  hasPrevious={currentPage > 1}
                  hasNext={currentPage < totalPages}
                  onPrevious={() => go({ page: currentPage === 2 ? undefined : currentPage - 1 })}
                  onNext={() => go({ page: currentPage + 1 })}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
