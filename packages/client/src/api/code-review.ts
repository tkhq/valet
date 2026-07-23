import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { triggerKeys } from './triggers';

export interface EnableCodeReviewResult {
  workflowId: string;
  triggerId: string;
  owner: string;
  repo: string;
  alreadyArmed: boolean;
}

/**
 * POST /api/code-review/enable — enable Claude PR reviews on a repository via
 * the org GitHub App. Installs the review workflow + a github-app trigger scoped
 * to owner/repo. Idempotent per (user, repo).
 */
export function useEnableCodeReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ owner, repo }: { owner: string; repo: string }) =>
      api.post<EnableCodeReviewResult>('/code-review/enable', { owner, repo }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: triggerKeys.lists() });
    },
  });
}
