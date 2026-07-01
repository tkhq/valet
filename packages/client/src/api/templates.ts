import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { workflowKeys } from './workflows';
import { executionKeys } from './executions';
import type { WorkflowTemplateListResponse, InstallTemplateResponse } from '@valet/shared';

export const templateKeys = {
  all: ['templates'] as const,
  lists: () => [...templateKeys.all, 'list'] as const,
};

/** GET /api/templates — the template gallery catalog. */
export function useWorkflowTemplates() {
  return useQuery({
    queryKey: templateKeys.lists(),
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

export interface RunWorkflowNowInput {
  workflowId: string;
  variables: Record<string, unknown>;
}

interface ManualRunResponse {
  executionId: string;
  workflowId: string;
  status: string;
}

/** POST /api/triggers/manual/run — run a published workflow now with input variables. */
export function useRunWorkflowNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workflowId, variables }: RunWorkflowNowInput) =>
      api.post<ManualRunResponse>('/triggers/manual/run', { workflowId, variables }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: workflowKeys.executions(vars.workflowId) });
      queryClient.invalidateQueries({ queryKey: executionKeys.byWorkflow(vars.workflowId) });
    },
  });
}
