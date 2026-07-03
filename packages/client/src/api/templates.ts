import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { workflowKeys } from './workflows';
import { triggerKeys } from './triggers';
import type { WorkflowTemplateListResponse, InstallTemplateResponse } from '@valet/shared';

export const templateKeys = {
  all: ['templates'] as const,
  lists: () => [...templateKeys.all, 'list'] as const,
  list: (filters?: Record<string, unknown>) => [...templateKeys.lists(), filters] as const,
};

/** An org/user the Valet GitHub App is installed on. */
export interface GithubAppInstallation {
  level: string;
  accountLogin: string;
  accountType: string;
  createdAt: string;
}

/** GET /api/templates — the template gallery catalog. */
export function useWorkflowTemplates() {
  return useQuery({
    queryKey: templateKeys.list(),
    queryFn: () => api.get<WorkflowTemplateListResponse>('/templates'),
  });
}

/** POST /api/templates/:id/install — install a template as a published workflow. */
export function useInstallTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (templateId: string) =>
      api.post<InstallTemplateResponse>(`/templates/${templateId}/install`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workflowKeys.lists() });
    },
  });
}

/** GET /api/repo-providers/github/installations — orgs/users the Valet GitHub App is installed on. */
export function useGithubAppInstallations() {
  return useQuery({
    queryKey: ['github', 'app-installations'],
    queryFn: () =>
      api.get<{ installations: GithubAppInstallation[] }>('/repo-providers/github/installations'),
  });
}

/** POST /api/templates/:id/enable-app — arm a repo for the template via the GitHub App (no webhook). */
export function useEnableTemplateApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      templateId,
      workflowId,
      owner,
      repo,
    }: {
      templateId: string;
      workflowId: string;
      owner: string;
      repo: string;
    }) =>
      api.post<{ triggerId: string; owner: string; repo: string; alreadyArmed: boolean }>(
        `/templates/${templateId}/enable-app`,
        { workflowId, owner, repo },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: triggerKeys.lists() });
    },
  });
}
