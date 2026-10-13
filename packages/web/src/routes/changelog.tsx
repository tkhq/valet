import { useEffect, useRef, useState } from "react";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { Check, ClipboardCopy, ExternalLink, Info } from "lucide-react";
import type { ChangelogCategory } from "@valet/api/wire";
import { useChangelog } from "~/api/changelog";
import { useMe } from "~/api/settings";
import { Pager } from "~/components/pager";
import { Badge, Button, Label, Spinner, cardClass, pageClass, textLinkClass } from "~/components/primitives";
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
  isUnreadChangelogEntry,
  lastSeenChangelogState,
  markChangelogSeen,
  unreadCheckpointIds,
  type ChangelogReadState,
} from "~/lib/changelog-read-state";
import { cn } from "~/lib/cn";
import { textParam } from "~/lib/search-params";
import { useCopyToClipboard } from "~/lib/use-copy";

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

// Mix palette tokens locally so small text stays readable without changing other pages.
const secondaryTextClass = "text-[color:color-mix(in_oklch,var(--muted),var(--ink)_20%)]";
const newBadgeClass = "shrink-0 rounded-full border border-moss bg-moss-wash px-2.5 text-ink tracking-normal dark:bg-moss-wash dark:text-ink";
const focusClass = "rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss focus-visible:ring-offset-2 focus-visible:ring-offset-paper";
const selectClass = "h-12 w-full min-w-0 rounded-xl border border-line bg-paper px-3 text-base text-ink sm:h-11 sm:rounded sm:text-sm focus-visible:border-moss focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss";

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

function entryDate(value: string | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return buildDate(value);
}

export function ChangelogPage() {
  const changelog = useChangelog();
  const me = useMe();
  const { copied, copy } = useCopyToClipboard();
  const checkpoints = changelog.data?.manifest.checkpoints ?? [];
  const runningSha = changelog.data?.artifact.sha;
  const [emptyStatusReady, setEmptyStatusReady] = useState(false);
  const [seenWhenOpened, setSeenWhenOpened] = useState<ChangelogReadState | null>();
  const openingSnapshot = useRef<ChangelogReadState | null | undefined>(undefined);
  const search = readChangelogSearch(useSearch({ strict: false }));
  const navigate = useNavigate();
  const category: ChangelogCategoryFilter = search.category ?? "all";
  const sort: ChangelogSort = search.sort ?? "newest";
  const query = search.q ?? "";
  const requestedPage = search.page ?? 1;
  const unread = seenWhenOpened === undefined || seenWhenOpened?.checkpointId === null
    ? new Set<string>()
    : unreadCheckpointIds(checkpoints, seenWhenOpened?.checkpointId ?? null);
  const newestId = checkpoints[0]?.id;
  const visibleCheckpoints = filterAndSortCheckpoints(checkpoints, category, query, sort);
  const totalPages = pageCount(visibleCheckpoints.length);
  const currentPage = clampPage(requestedPage, totalPages);
  const pageCheckpoints = paginateCheckpoints(visibleCheckpoints, currentPage);

  function go(next: Partial<ChangelogSearch>): void {
    void navigate({ to: "/changelog", search: { ...search, ...next } });
  }

  useEffect(() => {
    if (!me.data || !newestId || openingSnapshot.current !== undefined) return;
    const seen = lastSeenChangelogState(me.data.id);
    openingSnapshot.current = seen;
    setSeenWhenOpened(seen);
    markChangelogSeen(me.data.id, newestId, checkpoints);
  }, [checkpoints, me.data, newestId]);

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

  useEffect(() => {
    if (changelog.isPending || changelog.isError) {
      setEmptyStatusReady(false);
      return;
    }
    // Register the empty live region before adding text, including on a direct no-match URL.
    const timer = window.setTimeout(() => setEmptyStatusReady(true), 0);
    return () => window.clearTimeout(timer);
  }, [changelog.isPending, changelog.isError]);

  if (changelog.isPending) {
    return (
      <div role="status" className={cn("flex flex-1 items-center justify-center gap-2 p-6 text-sm", secondaryTextClass)}>
        <span aria-hidden="true"><Spinner size={14} className="motion-reduce:animate-none" /></span> Loading changelog…
      </div>
    );
  }
  if (changelog.isError) {
    return (
      <div role="alert" className="flex-1 p-8 text-sm text-danger-600 dark:text-danger-500">
        Could not load the changelog. Reload the page to try again.
      </div>
    );
  }

  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <div className={cn(pageClass, "[container-type:inline-size]")}>
        <h1 className="font-display text-2xl font-medium text-ink">Changelog</h1>
        <p className={cn("mt-2 text-sm leading-6", secondaryTextClass)}>Changes in rolling builds and released versions.</p>
        {runningSha && (
          <div className={cn("mt-3 flex flex-wrap items-center gap-x-2 text-xs", secondaryTextClass)}>
            <span>Running commit</span>
            <a
              href={`https://github.com/tkhq/valet/commit/${runningSha}`}
              target="_blank"
              rel="noreferrer"
              aria-label={`Running commit ${runningSha}`}
              title={runningSha}
              className={cn(textLinkClass, focusClass, "min-h-6 font-mono max-sm:min-h-11 max-sm:min-w-11")}
            >
              {runningSha.slice(0, 9)}
            </a>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Copy running commit"
              onClick={() => void copy(runningSha)}
              className="text-ink hover:bg-moss-wash hover:text-moss focus-visible:ring-moss dark:text-ink dark:hover:bg-moss-wash dark:hover:text-moss"
            >
              {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <ClipboardCopy className="h-3.5 w-3.5" aria-hidden />}
            </Button>
          </div>
        )}

        {changelog.data.artifact.status === "latest-known" && (
          <div role="note" aria-label="Build information" className={cn(cardClass, "mt-6 flex gap-3 border-l-4 border-l-moss bg-moss-wash px-4 py-4 text-sm leading-6 text-ink sm:px-5")}>
            <Info className="mt-0.5 h-5 w-5 shrink-0 text-moss" aria-hidden="true" />
            <p>This build has no release checkpoint. The latest known checkpoint is shown.</p>
          </div>
        )}

        {checkpoints.length > 0 && (
          <div
            role="group"
            aria-label="Changelog filters"
            className={cn(cardClass, "mt-8 grid gap-4 p-4 sm:p-5 [@container(min-width:32rem)]:grid-cols-2 [@container(min-width:48rem)]:grid-cols-[minmax(0,1fr)_auto_auto]")}
          >
            <div className="min-w-0 space-y-2 [@container(min-width:32rem)]:col-span-2 [@container(min-width:48rem)]:col-span-1">
              <Label htmlFor="changelog-search" className={secondaryTextClass}>Search changes</Label>
              <SearchInput
                id="changelog-search"
                value={query}
                onSettled={(value) =>
                  go({ q: value.trim().length === 0 ? undefined : value, page: undefined })
                }
                placeholder="Search changes…"
                className="h-12 bg-paper placeholder:text-[color:color-mix(in_oklch,var(--muted),var(--ink)_20%)] focus-visible:border-moss focus-visible:ring-moss max-sm:focus-visible:ring-2 max-sm:focus-visible:ring-moss sm:h-11"
              />
            </div>
            <div className="min-w-0 space-y-2">
              <Label htmlFor="changelog-category" className={secondaryTextClass}>Change type</Label>
              <select
                id="changelog-category"
                value={category}
                onChange={(event) => {
                  const next = CHANGELOG_CATEGORIES.find((value) => value === event.target.value);
                  go({ category: next, page: undefined });
                }}
                className={selectClass}
              >
                <option value="all">All change types</option>
                {CHANGELOG_CATEGORIES.map((value) => (
                  <option key={value} value={value}>{CATEGORY[value].label}</option>
                ))}
              </select>
            </div>
            <div className="min-w-0 space-y-2">
              <Label htmlFor="changelog-sort" className={secondaryTextClass}>Sort releases</Label>
              <select
                id="changelog-sort"
                value={sort}
                onChange={(event) =>
                  go({ sort: event.target.value === "oldest" ? "oldest" : undefined, page: undefined })
                }
                className={selectClass}
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
              </select>
            </div>
          </div>
        )}

        <div
          role="status"
          aria-atomic="true"
          className={emptyStatusReady && checkpoints.length > 0 && visibleCheckpoints.length === 0
            ? cn(cardClass, "mt-8 px-4 py-10 text-center")
            : "sr-only"}
        >
          {emptyStatusReady && checkpoints.length > 0 && visibleCheckpoints.length === 0 && (
            <>
              <p className="text-sm font-medium text-ink">No changes match these filters.</p>
              <p className={cn("mt-2 text-sm leading-6", secondaryTextClass)}>Change the type filter or search terms.</p>
            </>
          )}
        </div>
        {checkpoints.length === 0 ? (
          <p className={cn(cardClass, "mt-8 px-4 py-10 text-center text-sm", secondaryTextClass)}>No release checkpoints are available for this build.</p>
        ) : visibleCheckpoints.length === 0 ? null : (
          <>
            <div className="mt-10 space-y-8">
              {pageCheckpoints.map((checkpoint) => {
                const unreleased = checkpoint.kind === "unreleased";
                const checkpointSha = unreleased ? checkpoint.buildSha : checkpoint.releasedSha;
                const checkpointUrl = unreleased ? checkpoint.buildUrl : checkpoint.releaseUrl;
                const groups = groupChangelogEntries(checkpoint.entries);
                return (
                  <section key={checkpoint.id} aria-labelledby={`release-${checkpoint.id}`} className={cn(cardClass, "min-w-0")}>
                    <div className="flex flex-col gap-3 border-b border-line px-4 py-5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:px-5">
                      <div className="min-w-0 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-3">
                          <h2 id={`release-${checkpoint.id}`} className="break-words font-display text-xl font-semibold text-ink">
                            {unreleased ? "Unreleased" : checkpoint.version}
                          </h2>
                          {unread.has(checkpoint.id) && <Badge variant="accent" className={newBadgeClass}>New</Badge>}
                        </div>
                        <time dateTime={unreleased ? checkpoint.builtAt : checkpoint.releasedAt} className={cn("block text-sm", secondaryTextClass)}>
                          {unreleased ? buildDate(checkpoint.builtAt) : releaseDate(checkpoint.releasedAt)}
                        </time>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                        {unreleased && (
                          <a
                            href={`https://github.com/tkhq/valet/commit/${checkpointSha}`}
                            target="_blank"
                            rel="noreferrer"
                            className={cn(textLinkClass, focusClass, "min-h-6 font-mono max-sm:min-h-11 max-sm:min-w-11")}
                          >
                            Build {checkpointSha.slice(0, 9)}
                          </a>
                        )}
                        {checkpointUrl && (
                          <a
                            href={checkpointUrl}
                            target="_blank"
                            rel="noreferrer"
                            className={cn(textLinkClass, focusClass, "min-h-6 max-sm:min-h-11 max-sm:min-w-11")}
                          >
                            {unreleased ? "Build" : "Release"} <ExternalLink className="h-3 w-3" aria-hidden />
                          </a>
                        )}
                      </div>
                    </div>

                    {checkpoint.entries.length === 0 ? (
                      <p className={cn("px-4 py-6 text-sm leading-6 sm:px-5", secondaryTextClass)}>
                        {unreleased
                          ? "No user-facing changes are pending in this build."
                          : "No user-facing changes shipped in this release."}
                      </p>
                    ) : (
                      <div className="divide-y divide-line px-4 sm:px-5">
                        {groups.map((group) => {
                          const presentation = CATEGORY[group.category];
                          return (
                            <div key={group.category} className="grid min-w-0 py-5 [@container(min-width:40rem)]:grid-cols-[8rem_minmax(0,1fr)] [@container(min-width:40rem)]:gap-5">
                              <h3 className={cn("text-xs font-semibold uppercase tracking-wide [@container(min-width:40rem)]:pt-4", secondaryTextClass)}>
                                {presentation.label}
                              </h3>
                              <ul className="min-w-0 divide-y divide-line">
                                {group.entries.map((entry) => {
                                  const commit = entry.sources.commitSha;
                                  const entryUnread = isUnreadChangelogEntry(
                                    checkpoint,
                                    entry,
                                    unread,
                                    seenWhenOpened ?? null,
                                  );
                                  return (
                                    <li
                                      key={`${checkpoint.id}-${commit}`}
                                      className="py-4"
                                    >
                                      <div className="min-w-0 space-y-2">
                                        <div className="min-w-0">
                                          <div className="flex flex-wrap items-center gap-2">
                                            <h4 className="min-w-0 font-medium leading-6 text-ink [overflow-wrap:anywhere]">{entry.title}</h4>
                                            {entryUnread && <Badge variant="accent" className={newBadgeClass}>New</Badge>}
                                          </div>
                                          {entry.description && (
                                            <p className="mt-1 text-sm leading-6 text-ink [overflow-wrap:anywhere]">{entry.description}</p>
                                          )}
                                        </div>
                                        <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-xs", secondaryTextClass)}>
                                          {entryDate(entry.authoredAt) && (
                                            <time dateTime={entry.authoredAt}>{entryDate(entry.authoredAt)}</time>
                                          )}
                                          {entry.sources.pullRequest && (
                                            <a
                                              href={`https://github.com/tkhq/valet/pull/${entry.sources.pullRequest}`}
                                              target="_blank"
                                              rel="noreferrer"
                                              className={cn(textLinkClass, focusClass, "min-h-6 whitespace-nowrap max-sm:min-h-11 max-sm:min-w-11")}
                                            >
                                              PR #{entry.sources.pullRequest}
                                            </a>
                                          )}
                                          <a
                                            href={`https://github.com/tkhq/valet/commit/${commit}`}
                                            target="_blank"
                                            rel="noreferrer"
                                            aria-label={`Commit ${commit}`}
                                            className={cn(textLinkClass, focusClass, "min-h-6 font-mono max-sm:min-h-11 max-sm:min-w-11")}
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
