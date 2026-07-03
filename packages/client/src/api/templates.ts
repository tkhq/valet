import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { workflowKeys } from './workflows';
import type { WorkflowTemplateListResponse, InstallTemplateResponse } from '@valet/shared';

export const templateKeys = {
  all: ['templates'] as const,
  lists: () => [...templateKeys.all, 'list'] as const,
  list: (filters?: Record<string, unknown>) => [...templateKeys.lists(), filters] as const,
};

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
