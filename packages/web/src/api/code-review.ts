/**
 * Code review queries: the pull requests the PR review plugin reviewed for
 * one workspace (`GET /api/code-review/reviews`). The lines that turn
 * reviews on are event subscriptions (`~/api/events`).
 */
import { useQuery } from "@tanstack/react-query";
import type { ListCodeReviewsResponse } from "@valet/api/wire";
import { api } from "./client";

export const qkCodeReview = {
  reviews: (teamId?: string) => ["code-review", "reviews", teamId ?? ""] as const,
};

/** A review runs for minutes; a 30-second poll shows a new one soon enough. */
const REVIEWS_POLL_MS = 30_000;

export function useCodeReviews(teamId?: string) {
  return useQuery<ListCodeReviewsResponse>({
    queryKey: qkCodeReview.reviews(teamId),
    queryFn: () => api.listCodeReviews(teamId),
    refetchInterval: REVIEWS_POLL_MS,
  });
}
