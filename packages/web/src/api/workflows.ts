/**
 * Workflows queries (engine v2 Phase 5 decision 19 — deliberately spartan
 * web surface). House pattern: a query-key factory per resource file,
 * mirroring `~/api/memory` / `~/api/orchestrator`.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type {
  CreateWorkflowRequest,
  CreateWorkflowResponse,
  GetWorkflowRunResponse,
  ListWorkflowRunsResponse,
  ListWorkflowsResponse,
  ResolveWorkflowApprovalRequest,
  StartWorkflowRunResponse,
  UpdateWorkflowRequest,
  UpdateWorkflowResponse,
} from "@valet/api/wire";
import { api } from "./client";

export const qkWorkflows = {
  list: () => ["workflows"] as const,
  detail: (id: string) => ["workflows", id] as const,
  runs: (id: string) => ["workflows", id, "runs"] as const,
  run: (runId: string) => ["workflows", "runs", runId] as const,
};

// ── Reads ────────────────────────────────────────────────────────────────

export function useWorkflows(opts?: Partial<UseQueryOptions<ListWorkflowsResponse>>) {
  return useQuery<ListWorkflowsResponse>({
    queryKey: qkWorkflows.list(),
    queryFn: () => api.listWorkflows(),
    ...opts,
  });
}

export function useWorkflow(
  id: string,
  opts?: Partial<UseQueryOptions<CreateWorkflowResponse>>,
) {
  return useQuery<CreateWorkflowResponse>({
    queryKey: qkWorkflows.detail(id),
    queryFn: () => api.getWorkflow(id),
    enabled: !!id,
    ...opts,
  });
}

export function useWorkflowRuns(
  id: string,
  opts?: Partial<UseQueryOptions<ListWorkflowRunsResponse>>,
) {
  return useQuery<ListWorkflowRunsResponse>({
    queryKey: qkWorkflows.runs(id),
    queryFn: () => api.listWorkflowRuns(id),
    enabled: !!id,
    ...opts,
  });
}

/**
 * Run detail — polls every 5s while non-terminal (plan decision 19), stops
 * once the run has settled so a finished run doesn't keep hitting the API.
 */
export function useRunDetail(
  runId: string,
  opts?: Partial<UseQueryOptions<GetWorkflowRunResponse>>,
) {
  return useQuery<GetWorkflowRunResponse>({
    queryKey: qkWorkflows.run(runId),
    queryFn: () => api.getWorkflowRun(runId),
    enabled: !!runId,
    refetchInterval: (query) => (query.state.data?.run.status === "settled" ? false : 5000),
    ...opts,
  });
}

// ── Mutations ────────────────────────────────────────────────────────────

export function useCreateWorkflow() {
  const qc = useQueryClient();
  return useMutation<CreateWorkflowResponse, Error, CreateWorkflowRequest>({
    mutationFn: (body) => api.createWorkflow(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkWorkflows.list() });
    },
  });
}

/** Return type of {@link useUpdateWorkflow} — named so `workflows.$workflowId.tsx`
 * can thread it through `WorkflowEditorPane`'s props without repeating the
 * generic instantiation. */
export type UpdateWorkflowMutation = UseMutationResult<
  UpdateWorkflowResponse,
  Error,
  UpdateWorkflowRequest
>;

export function useUpdateWorkflow(id: string): UpdateWorkflowMutation {
  const qc = useQueryClient();
  return useMutation<UpdateWorkflowResponse, Error, UpdateWorkflowRequest>({
    mutationFn: (body) => api.updateWorkflow(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkWorkflows.list() });
      qc.invalidateQueries({ queryKey: qkWorkflows.detail(id) });
    },
  });
}

export function useStartRun(id: string) {
  const qc = useQueryClient();
  return useMutation<StartWorkflowRunResponse, Error, Record<string, unknown> | void>({
    mutationFn: (input) => api.startWorkflowRun(id, input ? { input } : {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkWorkflows.runs(id) });
    },
  });
}

export function useResolveApproval(runId: string) {
  const qc = useQueryClient();
  return useMutation<
    { ok: true },
    Error,
    { nodeId: string; body: ResolveWorkflowApprovalRequest }
  >({
    mutationFn: ({ nodeId, body }) => api.resolveWorkflowApproval(runId, nodeId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkWorkflows.run(runId) });
    },
  });
}

export function useCancelRun(runId: string) {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, void>({
    mutationFn: () => api.cancelWorkflowRun(runId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkWorkflows.run(runId) });
    },
  });
}
