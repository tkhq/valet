/**
 * The query hook for one line's Activity and its health strip
 * (docs/specs/2026-10-16-presence-hub-design.md Part D steps 1.4, 1.7, and 4).
 * Each page holds 50 entries, newest first. `Show earlier` fetches the next
 * page with the previous page's `nextCursor` as `before`. The health strip
 * reads the counts from the first page.
 */
import { useEffect } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { LineActivityResponse } from "@valet/api/wire";
import { api } from "./client";

export const qkLineActivity = {
  // Under `events`, so a change to a line or a redeliver refreshes it with the rest.
  line: (id: string) => ["events", "line-activity", id] as const,
};

export const LINE_ACTIVITY_PAGE = 50;

/** How many empty pages in a row the hook fetches past by itself. After
 * that, the reader selects `Show earlier`. */
export const LINE_ACTIVITY_AUTO_FETCHES = 3;

const POLL_MS = 30_000;

/** The number of empty pages at the end of the loaded pages. */
export function trailingEmptyPages(pages: readonly Pick<LineActivityResponse, "entries">[]): number {
  let n = 0;
  for (let i = pages.length - 1; i >= 0 && pages[i]?.entries.length === 0; i--) n++;
  return n;
}

/**
 * True when the hook fetches the next page by itself: the last page came
 * back empty but carries a cursor, because the api stopped its scan before
 * it found an entry. It stops after `LINE_ACTIVITY_AUTO_FETCHES` empty pages
 * in a row, and after a failed fetch.
 */
export function shouldFetchPastEmpty(state: {
  pages: readonly Pick<LineActivityResponse, "entries">[];
  hasNextPage: boolean;
  fetching: boolean;
  failed: boolean;
}): boolean {
  if (!state.hasNextPage || state.fetching || state.failed) return false;
  const empty = trailingEmptyPages(state.pages);
  return empty > 0 && empty <= LINE_ACTIVITY_AUTO_FETCHES;
}

/** The poll interval: 30 s while one page is loaded. With more pages a poll
 * would read every loaded page again, so it stops. */
export function lineActivityPollMs(pageCount: number | undefined): number | false {
  return pageCount === 1 ? POLL_MS : false;
}

export function useLineActivity(id: string) {
  const query = useInfiniteQuery({
    queryKey: qkLineActivity.line(id),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }): Promise<LineActivityResponse> =>
      api.getLineActivity(id, { limit: LINE_ACTIVITY_PAGE, ...(pageParam !== undefined ? { before: pageParam } : {}) }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // A line's page has no live feed; a poll shows new acted and skipped
    // entries while the page stays open, at one cheap read.
    refetchInterval: (q) => lineActivityPollMs(q.state.data?.pages.length),
  });
  const { data, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query;
  const fetchPastEmpty = shouldFetchPastEmpty({
    pages: data?.pages ?? [],
    hasNextPage,
    fetching: isFetchingNextPage,
    failed: isFetchNextPageError,
  });
  useEffect(() => {
    if (fetchPastEmpty) void fetchNextPage();
  }, [fetchPastEmpty, fetchNextPage, data?.pages.length]);
  return query;
}
