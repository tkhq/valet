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
  AllowWorkflowPermissionsResponse,
  CreateWorkflowEventTriggerRequest,
  CreateWorkflowRequest,
  CreateWorkflowResponse,
  GetWorkflowPermissionsResponse,
  CreateWorkflowScheduleRequest,
  WorkflowWebhookResponse,
  GetWorkflowRunResponse,
  GetWorkflowTriggerCatalogResponse,
  ListAllWorkflowRunsResponse,
  ListWorkflowRunsResponse,
  ListWorkflowsResponse,
  ListWorkflowTriggersResponse,
  ResolveWorkflowApprovalRequest,
  RetryWorkflowRunResponse,
  StartWorkflowRunResponse,
  UpdateWorkflowEventTriggerRequest,
  UpdateWorkflowRequest,
  UpdateWorkflowResponse,
  UpdateWorkflowScheduleRequest,
  GetWorkflowVersionResponse,
  ListWorkflowVersionsResponse,
  WorkflowEventTriggerResponse,
  WorkflowScheduleResponse,
} from "@valet/api/wire";
import { api, ApiError, type OwnerFilter, type WorkflowRunFilter, type WorkflowRunPage } from "./client";
import { qkPolicies } from "./policies";

export const qkWorkflows = {
  /** The owner is a trailing element, so `["workflows"]` stays the prefix
   * that invalidates every workspace's list at once — a workflow created in
   * one workspace still refreshes the others. */
  list: (owner?: OwnerFilter) =>
    ["workflows", ...(owner ? [owner.ownerType, owner.ownerId] : [])] as const,
  detail: (id: string) => ["workflows", id] as const,
  // The page/filter is a trailing key element, so two pages of one list are
  // two cache entries while the page-less form stays the prefix that
  // invalidates all of them.
  runs: (id: string, page?: WorkflowRunPage) =>
    ["workflows", id, "runs", ...(page ? [page] : [])] as const,
  runList: (filter?: WorkflowRunFilter) =>
    ["workflows", "run-list", ...(filter ? [filter] : [])] as const,
  run: (runId: string) => ["workflows", "runs", runId] as const,
  versions: (id: string) => ["workflows", id, "versions"] as const,
  version: (id: string, version: number) => ["workflows", id, "versions", version] as const,
  webhook: (id: string) => ["workflows", id, "webhook"] as const,
  triggers: (workflowId?: string) => ["workflows", "triggers", workflowId ?? "all"] as const,
  allRuns: () => ["workflows", "all-runs"] as const,
  triggerCatalog: () => ["workflows", "trigger-catalog"] as const,
  // Sits under the `detail(id)` prefix on purpose: saving the definition
  // invalidates the detail, and the predictions must follow the definition.
  permissions: (id: string) => ["workflows", id, "permissions"] as const,
};

// ── Reads ────────────────────────────────────────────────────────────────

/**
 * The workflows of one workspace, or of everything the caller can reach.
 *
 * `owner` MUST be part of the query key, not only the request. Without it
 * React Query answers a switched workspace from the previous workspace's
 * cache: the list looks right on the first switch and wrong on the way back.
 */
export function useWorkflows(
  owner?: OwnerFilter,
  opts?: Partial<UseQueryOptions<ListWorkflowsResponse>>,
) {
  return useQuery<ListWorkflowsResponse>({
    queryKey: qkWorkflows.list(owner),
    queryFn: () => api.listWorkflows(owner),
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

/** One workflow's runs, newest first. Paged — read `nextCursor` to page on. */
export function useWorkflowRuns(
  id: string,
  page?: WorkflowRunPage,
  opts?: Partial<UseQueryOptions<ListWorkflowRunsResponse>>,
) {
  return useQuery<ListWorkflowRunsResponse>({
    queryKey: qkWorkflows.runs(id, page),
    queryFn: () => api.listWorkflowRuns(id, page),
    enabled: !!id,
    ...opts,
  });
}

/** Runs across every workflow the caller can reach. Pass `parentRunId` to
 * list one batch parent's child runs. */
export function useRuns(
  filter?: WorkflowRunFilter,
  opts?: Partial<UseQueryOptions<ListAllWorkflowRunsResponse>>,
) {
  return useQuery<ListAllWorkflowRunsResponse>({
    queryKey: qkWorkflows.runList(filter),
    queryFn: () => api.listRuns(filter),
    ...opts,
  });
}

export function useWorkflowVersions(
  id: string,
  opts?: Partial<UseQueryOptions<ListWorkflowVersionsResponse>>,
) {
  return useQuery<ListWorkflowVersionsResponse>({
    queryKey: qkWorkflows.versions(id),
    queryFn: () => api.listWorkflowVersions(id),
    enabled: !!id,
    ...opts,
  });
}

export function useWorkflowVersion(
  id: string,
  version: number | null,
  opts?: Partial<UseQueryOptions<GetWorkflowVersionResponse>>,
) {
  return useQuery<GetWorkflowVersionResponse>({
    queryKey: qkWorkflows.version(id, version ?? 0),
    queryFn: () => api.getWorkflowVersion(id, version ?? 0),
    enabled: !!id && version !== null,
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

export function useWorkflowTriggers(
  workflowId?: string,
  opts?: Partial<UseQueryOptions<ListWorkflowTriggersResponse>>,
) {
  return useQuery<ListWorkflowTriggersResponse>({
    queryKey: qkWorkflows.triggers(workflowId),
    queryFn: () => api.listWorkflowTriggers(workflowId),
    ...opts,
  });
}

export function useTriggerCatalog() {
  return useQuery<GetWorkflowTriggerCatalogResponse>({
    queryKey: qkWorkflows.triggerCatalog(),
    queryFn: () => api.getWorkflowTriggerCatalog(),
    staleTime: 5 * 60_000, // plugin catalog changes only on deploy
  });
}

export function useAllWorkflowRuns(opts?: Partial<UseQueryOptions<ListAllWorkflowRunsResponse>>) {
  return useQuery<ListAllWorkflowRunsResponse>({
    queryKey: qkWorkflows.allRuns(),
    queryFn: () => api.listAllWorkflowRuns(),
    refetchInterval: 5000, // runs move; same cadence as run detail
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
      qc.invalidateQueries({ queryKey: qkWorkflows.versions(id) });
    },
  });
}

export function useDeleteWorkflow() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api.deleteWorkflow(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkWorkflows.list() });
    },
  });
}

/** Per-node policy predictions: which tool nodes would park a run on a
 * policy gate for the calling user. */
export function useWorkflowPermissions(
  id: string,
  opts?: Partial<UseQueryOptions<GetWorkflowPermissionsResponse>>,
) {
  return useQuery<GetWorkflowPermissionsResponse>({
    queryKey: qkWorkflows.permissions(id),
    queryFn: () => api.getWorkflowPermissions(id),
    enabled: !!id,
    ...opts,
  });
}

/** Pre-approves every gating action of the workflow: the server derives the
 * set from the stored definition and writes one per-user allow override per
 * action. Refreshes the predictions and the settings overrides list. */
export function useAllowWorkflowPermissions(id: string) {
  const qc = useQueryClient();
  return useMutation<AllowWorkflowPermissionsResponse, Error, void>({
    mutationFn: () => api.allowWorkflowPermissions(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkWorkflows.permissions(id) });
      qc.invalidateQueries({ queryKey: qkPolicies.myOverrides() });
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
    onError: () => {
      // Invalidate on error too: a 409 "already resolved" means the run has
      // moved on, and the 5-s poll would leave the stale card visible until
      // the next tick. Invalidating here collapses the wait.
      qc.invalidateQueries({ queryKey: qkWorkflows.run(runId) });
    },
  });
}

/**
 * Retry a settled failed/cancelled run — starts a fresh run of the same
 * workflow with the original input and returns the new runId. Invalidates the
 * workflow's runs list so the new run appears in the runs drawer. The
 * workflowId is read from the cached run detail inside `onSuccess` (not taken
 * as a parameter) so a hook created before the detail query resolves never
 * closes over a placeholder id.
 */
export function useRetryRun(runId: string) {
  const qc = useQueryClient();
  return useMutation<RetryWorkflowRunResponse, Error, void>({
    mutationFn: () => api.retryWorkflowRun(runId),
    onSuccess: () => {
      const detail = qc.getQueryData<GetWorkflowRunResponse>(qkWorkflows.run(runId));
      if (detail) {
        qc.invalidateQueries({ queryKey: qkWorkflows.runs(detail.run.workflowId) });
      }
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

// ── Triggers: webhook, schedules, event triggers ─────────────────────────

/** The webhook status read treats "no webhook configured" (404) as `null`
 * rather than an error — absence is the normal starting state. */
export function useWorkflowWebhook(id: string) {
  return useQuery<WorkflowWebhookResponse | null>({
    queryKey: qkWorkflows.webhook(id),
    queryFn: async () => {
      try {
        return await api.getWorkflowWebhook(id);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
  });
}

export function useMintWorkflowWebhook(id: string) {
  const qc = useQueryClient();
  return useMutation<WorkflowWebhookResponse, Error, void>({
    mutationFn: () => api.mintWorkflowWebhook(id),
    onSuccess: (webhook) => {
      // Seed the cache from the response before the refetch lands: after a
      // rotate, the old URL is revoked the moment the POST returns, so the
      // screen must not keep showing it while a refetch round-trips.
      qc.setQueryData(qkWorkflows.webhook(id), webhook);
      void qc.invalidateQueries({ queryKey: qkWorkflows.webhook(id) });
    },
  });
}

export function useDeleteWorkflowWebhook(id: string) {
  const qc = useQueryClient();
  return useMutation<{ deleted: boolean }, Error, void>({
    mutationFn: () => api.deleteWorkflowWebhook(id),
    // onSettled, not onSuccess: a failed delete (e.g. already gone) must
    // also reconcile the cached row with the server.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qkWorkflows.webhook(id) });
    },
  });
}

function useInvalidateTriggers() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["workflows", "triggers"] });
}

export function useCreateSchedule() {
  const invalidate = useInvalidateTriggers();
  return useMutation<WorkflowScheduleResponse, Error, CreateWorkflowScheduleRequest>({
    mutationFn: (body) => api.createWorkflowSchedule(body),
    onSuccess: invalidate,
  });
}

export function useUpdateSchedule() {
  const invalidate = useInvalidateTriggers();
  return useMutation<WorkflowScheduleResponse, Error, { id: string; body: UpdateWorkflowScheduleRequest }>({
    mutationFn: ({ id, body }) => api.updateWorkflowSchedule(id, body),
    onSuccess: invalidate,
  });
}

export function useDeleteSchedule() {
  const invalidate = useInvalidateTriggers();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api.deleteWorkflowSchedule(id),
    onSuccess: invalidate,
  });
}

export function useRunScheduleNow() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api.runWorkflowScheduleNow(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["workflows", "triggers"] });
      void qc.invalidateQueries({ queryKey: qkWorkflows.allRuns() });
    },
  });
}

export function useCreateEventTrigger() {
  const invalidate = useInvalidateTriggers();
  return useMutation<WorkflowEventTriggerResponse, Error, CreateWorkflowEventTriggerRequest>({
    mutationFn: (body) => api.createWorkflowEventTrigger(body),
    onSuccess: invalidate,
  });
}

export function useUpdateEventTrigger() {
  const invalidate = useInvalidateTriggers();
  return useMutation<WorkflowEventTriggerResponse, Error, { id: string; body: UpdateWorkflowEventTriggerRequest }>({
    mutationFn: ({ id, body }) => api.updateWorkflowEventTrigger(id, body),
    onSuccess: invalidate,
  });
}

export function useDeleteEventTrigger() {
  const invalidate = useInvalidateTriggers();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api.deleteWorkflowEventTrigger(id),
    onSuccess: invalidate,
  });
}
