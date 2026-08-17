/**
 * Workflow template queries — the gallery on `/workflows`. House pattern: a
 * query-key factory per resource file, mirroring `~/api/workflows`.
 *
 * The list is per-caller, not global: the server stamps each template's
 * `requires[].connected` from the caller's own credentials, so the cache key
 * must not be shared across users. Nothing here caches across a sign-out,
 * because the whole query client is torn down with the session.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type {
  InstallWorkflowTemplateRequest,
  InstallWorkflowTemplateResponse,
  ListWorkflowTemplatesResponse,
} from "@valet/api/wire";
import { api } from "./client";
import { qkWorkflows } from "./workflows";

export const qkTemplates = {
  list: () => ["templates"] as const,
};

export function useWorkflowTemplates(
  opts?: Partial<UseQueryOptions<ListWorkflowTemplatesResponse>>,
) {
  return useQuery<ListWorkflowTemplatesResponse>({
    queryKey: qkTemplates.list(),
    queryFn: () => api.listWorkflowTemplates(),
    ...opts,
  });
}

/**
 * Install a template. On success the workflow list holds a row it did not
 * have, so it is invalidated — the user lands on the new workflow, and the
 * list behind them is already correct when they go back.
 */
export function useInstallTemplate() {
  const qc = useQueryClient();
  return useMutation<
    InstallWorkflowTemplateResponse,
    Error,
    { templateId: string; body?: InstallWorkflowTemplateRequest }
  >({
    mutationFn: ({ templateId, body }) => api.installWorkflowTemplate(templateId, body ?? {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkWorkflows.list() });
      qc.invalidateQueries({ queryKey: qkTemplates.list() });
    },
  });
}
