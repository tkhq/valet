/**
 * Workflow template queries — the gallery on `/workflows`. House pattern: a
 * query-key factory per resource file, mirroring `~/api/workflows`.
 *
 * The list is per-WORKSPACE, not global: the server stamps each template's
 * `requires[].connected` from the credentials of the principal the install
 * would act as — the caller in their own workspace, the TEAM in a team's.
 * So the query sends the active workspace's team id and the cache keys on
 * it. A shared key would serve one workspace's answer under another's name,
 * and the gallery would offer or withhold Install on the wrong credentials.
 * Nothing here caches across a sign-out, because the whole query client is
 * torn down with the session.
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
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { qkWorkflows } from "./workflows";

export const qkTemplates = {
  /** Every template entry, whatever workspace it was taken in. Invalidate
   * this to reach them all. */
  all: () => ["templates"] as const,
  /** One workspace's listing. `teamId` is `useWorkspaceScope().teamId`:
   * undefined in your own workspace, a team id in a team's. */
  list: (teamId: string | undefined) => ["templates", teamId ?? "user"] as const,
};

export function useWorkflowTemplates(
  opts?: Partial<UseQueryOptions<ListWorkflowTemplatesResponse>>,
) {
  const { teamId } = useWorkspaceScope();
  return useQuery<ListWorkflowTemplatesResponse>({
    queryKey: qkTemplates.list(teamId),
    queryFn: () => api.listWorkflowTemplates(teamId),
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
      // Every workspace's listing, not only the one the install ran in: a
      // team install can be what makes a service resolve for that team.
      qc.invalidateQueries({ queryKey: qkTemplates.all() });
    },
  });
}
