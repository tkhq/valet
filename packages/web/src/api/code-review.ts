/**
 * Code review queries: the pull requests the PR review plugin reviewed for
 * one workspace (`GET /api/code-review/reviews`). The lines that turn
 * reviews on are event subscriptions (`~/api/events`).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ListCodeReviewsResponse, RunCodeReviewRequest, RunCodeReviewResponse } from "@valet/api/wire";
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

/** Review one pull request now (`POST /api/code-review/runs`). */
export function useRunCodeReview() {
  const qc = useQueryClient();
  return useMutation<RunCodeReviewResponse, Error, RunCodeReviewRequest>({
    mutationFn: (body) => api.runCodeReview(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["code-review", "reviews"] }),
  });
}
