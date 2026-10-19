/**
 * The query hook for one line's Activity and its health strip
 * (docs/specs/2026-10-16-presence-hub-design.md Part D steps 1.4, 1.7, and 4).
 * Each page holds 50 entries, newest first. `Show earlier` fetches the next
 * page with the previous page's `nextCursor` as `before`. The health strip
 * reads the counts from the first page.
 */
import { useInfiniteQuery } from "@tanstack/react-query";
import type { LineActivityResponse } from "@valet/api/wire";
import { api } from "./client";

export const qkLineActivity = {
  // Under `events`, so a change to a line or a redeliver refreshes it with the rest.
  line: (id: string) => ["events", "line-activity", id] as const,
};

export const LINE_ACTIVITY_PAGE = 50;

export function useLineActivity(id: string) {
  return useInfiniteQuery({
    queryKey: qkLineActivity.line(id),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }): Promise<LineActivityResponse> =>
      api.getLineActivity(id, { limit: LINE_ACTIVITY_PAGE, ...(pageParam !== undefined ? { before: pageParam } : {}) }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 30_000,
  });
}
