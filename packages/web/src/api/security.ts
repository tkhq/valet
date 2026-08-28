/**
 * Security engagement queries (valet-security design, §Web Surfaces). House
 * pattern: a query-key factory per resource file, mirroring `~/api/workflows`.
 * M7 ships the hub's reads; M8 adds findings (cursor-paged), the triage
 * mutations, and the export download. Live updates poll — the `host_event`
 * wire seam belongs to #396 (spec §Data and events).
 */
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type {
  CreateSessionResponse,
  GetSessionSecurityResponse,
  ListSecurityCoverageResponse,
  ListSecurityFindingsResponse,
  ListSessionsResponse,
  SecurityAddFindingCommentResponse,
  SecurityDigestIssueResponse,
  SecurityFileIssueResponse,
  SecurityFindingWire,
  SecurityPlanCellInput,
  SecurityReviewFindingResponse,
  SecuritySetConfigResponse,
  SecuritySetPlanResponse,
} from "@valet/api/wire";
import { api, ApiError, type OwnerFilter, type SecurityFindingsQuery } from "./client";
import { qk } from "./queries";

/** Filters the findings surface holds; the cursor stays inside the
 * infinite query, never in this shape. */
export type SecurityFindingsFilters = Omit<SecurityFindingsQuery, "cursor" | "limit">;

export const qkSecurity = {
  /** Under the `["sessions"]` prefix on purpose: `useCreateSession`
   * invalidates that prefix, so a just-created review refreshes this list
   * with no extra wiring. The owner stays trailing, same as `qk.sessions`. */
  reviews: (owner?: OwnerFilter) =>
    ["sessions", "security-reviews", ...(owner ? [owner.ownerType, owner.ownerId] : [])] as const,
  /** Under `qk.session(id)` so invalidating the session row clears this too. */
  engagement: (sessionId: string) => ["sessions", sessionId, "security"] as const,
  /** The coverage ledger (NOT_ASSESSED, M-P2d). Under the engagement prefix. */
  coverage: (sessionId: string) => ["sessions", sessionId, "security", "coverage"] as const,
  /** Prefix for every findings page of a session, so one invalidation after
   * a review/filing write clears every filter combination at once. */
  findingsPrefix: (sessionId: string) => ["sessions", sessionId, "security", "findings"] as const,
  findings: (sessionId: string, filters: SecurityFindingsFilters) =>
    [
      "sessions",
      sessionId,
      "security",
      "findings",
      filters.severity ?? "",
      filters.status ?? "",
      filters.cellId ?? "",
      filters.path ?? "",
    ] as const,
};

/** `GET /api/sessions?kind=security` — the hub's engagement list. `owner`
 * MUST reach the query key, or switching workspaces answers from the
 * previous workspace's cache. */
export function useSecurityReviews(
  owner?: OwnerFilter,
  opts?: Partial<UseQueryOptions<ListSessionsResponse>>,
) {
  return useQuery<ListSessionsResponse>({
    queryKey: qkSecurity.reviews(owner),
    queryFn: () => api.listSessions(owner, "security"),
    ...opts,
  });
}

/** `GET /api/sessions/:id/security` — one session's engagement + cells.
 * The hub reads the engagement's status and repo per row; the panel reads
 * the cells and passes `refetchInterval` to poll while running. */
export function useEngagement(
  sessionId: string,
  opts?: Partial<UseQueryOptions<GetSessionSecurityResponse>>,
) {
  return useQuery<GetSessionSecurityResponse>({
    queryKey: qkSecurity.engagement(sessionId),
    queryFn: () => api.getSessionSecurity(sessionId),
    enabled: !!sessionId,
    ...opts,
  });
}

/**
 * `GET /api/sessions/:id/security/findings` — cursor-paged behind an
 * infinite query; `keepPreviousData` keeps the last page on screen while a
 * filter change refetches, so the list never flashes empty mid-triage.
 * `pollMs` refetches on the engagement's cadence while it runs (the panel
 * is the only consumer, so "panel visible" == "query mounted").
 */
export function useSecurityFindings(
  sessionId: string,
  filters: SecurityFindingsFilters,
  pollMs?: number | false,
) {
  return useInfiniteQuery({
    queryKey: qkSecurity.findings(sessionId, filters),
    queryFn: ({ pageParam }) =>
      api.listSecurityFindings(sessionId, {
        ...filters,
        cursor: pageParam === "" ? undefined : pageParam,
      }),
    initialPageParam: "",
    getNextPageParam: (last: ListSecurityFindingsResponse) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: !!sessionId,
    refetchInterval: pollMs ?? false,
  });
}

/**
 * `GET /api/sessions/:id/security/coverage` — the coverage ledger (NOT_ASSESSED,
 * M-P2d). The panel reads the rollup (assessed/not_assessed counts + the gap
 * list) to show coverage honesty. `pollMs` refetches while the engagement runs.
 */
export function useSecurityCoverage(
  sessionId: string,
  opts?: Partial<UseQueryOptions<ListSecurityCoverageResponse>>,
) {
  return useQuery<ListSecurityCoverageResponse>({
    queryKey: qkSecurity.coverage(sessionId),
    queryFn: () => api.getSecurityCoverage(sessionId),
    enabled: !!sessionId,
    ...opts,
  });
}

/** Every loaded finding, flattened across pages. */
export function flattenFindings(
  pages: ListSecurityFindingsResponse[] | undefined,
): SecurityFindingWire[] {
  return pages?.flatMap((p) => p.findings) ?? [];
}

/**
 * Re-scan / iterate: create a NEW security review that re-scans a prior one
 * (POST /api/sessions with `rescanOf`). The server reuses the prior repo
 * binding and plan, resolves the LATEST default-branch SHA at sec_start, links
 * the new engagement to the prior one, and carries refutations forward. The
 * caller passes the prior session id and its repo full name (for the workspace
 * path); the workspace is derived the same way the hub's New review card does.
 * Invalidates the sessions list so the new review appears in the hub.
 */
export function useRescanReview() {
  const qc = useQueryClient();
  return useMutation<CreateSessionResponse, Error, { rescanOf: string; workspace: string }>({
    mutationFn: ({ rescanOf, workspace }) =>
      api.createSession({ workspace, kind: "security", rescanOf }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.sessions() });
    },
  });
}

/**
 * POST .../security/plan/cells — replace the plan from the step editor's
 * structured steps during planning (dynamic-config M-F2). The server assigns
 * dense ordinals in array order and validates against the persona registry.
 * Invalidates the engagement query so the panel re-reads the saved plan.
 */
export function useSetPlanCells(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<SecuritySetPlanResponse, Error, SecurityPlanCellInput[]>({
    mutationFn: (cells) => api.setSecurityPlanCells(sessionId, cells),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qkSecurity.engagement(sessionId) });
    },
  });
}

/**
 * POST .../security/config — edit the engagement's focus, known invariants, and
 * loaded threat categories during planning (dynamic-config M-F3, M-P2a; session
 * admin). Invalidates the engagement query so the panel re-reads the saved
 * values.
 */
export function useSetEngagementConfig(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<
    SecuritySetConfigResponse,
    Error,
    { focus?: string | null; invariants?: string[]; categories?: string[] }
  >({
    mutationFn: (body) => api.setSecurityConfig(sessionId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qkSecurity.engagement(sessionId) });
    },
  });
}

/** POST .../security/cancel — stop a planning or running engagement (spec
 * §Cancel). Invalidates the engagement query so the panel re-reads the
 * cancelled status and the failed cells. */
export function useCancelEngagement(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<GetSessionSecurityResponse, Error, void>({
    mutationFn: () => api.cancelSecurityReview(sessionId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qkSecurity.engagement(sessionId) });
    },
  });
}

/** POST .../findings/:findingId/status — human verify/refute. Invalidates
 * every findings page of the session (any filter may hold the row). */
export function useReviewFinding(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<
    SecurityReviewFindingResponse,
    Error,
    { findingId: string; status: "verified" | "refuted"; reason: string }
  >({
    mutationFn: ({ findingId, status, reason }) =>
      api.reviewSecurityFinding(sessionId, findingId, { status, reason }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qkSecurity.findingsPrefix(sessionId) });
    },
  });
}

/** POST .../findings/:findingId/comments — add a human note to a finding
 * (view-gated; any viewer may comment). Invalidates every findings page so
 * the new note appears under the finding, whatever filter holds the row. */
export function useAddFindingComment(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<
    SecurityAddFindingCommentResponse,
    Error,
    { findingId: string; body: string }
  >({
    mutationFn: ({ findingId, body }) =>
      api.addSecurityFindingComment(sessionId, findingId, { body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qkSecurity.findingsPrefix(sessionId) });
    },
  });
}

/** POST .../findings/:findingId/issues — file one issue. Idempotent on the
 * server: a repeat answers `created: false` with the existing link. */
export function useFileIssue(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<
    SecurityFileIssueResponse,
    Error,
    { findingId: string; provider: "github" | "linear"; repo?: string; teamId?: string }
  >({
    mutationFn: ({ findingId, ...body }) => api.fileSecurityIssue(sessionId, findingId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qkSecurity.findingsPrefix(sessionId) });
    },
  });
}

/** POST .../issues/digest — one digest issue from many findings. */
export function useFileDigest(sessionId: string) {
  return useMutation<
    SecurityDigestIssueResponse,
    Error,
    { provider: "github" | "linear"; findingIds: string[]; repo?: string; teamId?: string }
  >({
    mutationFn: (body) => api.fileSecurityDigest(sessionId, body),
  });
}

export type SecurityExportFormat = "md" | "sarif" | "json";

/** The export route URL for one format + filter set (spec §Export). The
 * export scope takes the same filters as the findings list, minus the
 * path filter — the route does not accept it. */
export function exportUrl(
  sessionId: string,
  format: SecurityExportFormat,
  filters: SecurityFindingsFilters = {},
): string {
  const qs = new URLSearchParams({ format });
  if (filters.severity) qs.set("severity", filters.severity);
  if (filters.status) qs.set("status", filters.status);
  if (filters.cellId) qs.set("cellId", filters.cellId);
  return `/api/sessions/${encodeURIComponent(sessionId)}/security/export?${qs.toString()}`;
}

/** The corrective error text an API failure carries, for inline display.
 * The route bodies put it in `{ error }`; fall back to the raw message. */
export function apiErrorText(err: unknown): string {
  if (err instanceof ApiError && typeof err.payload === "object" && err.payload !== null) {
    const payload = err.payload as { error?: unknown };
    if (typeof payload.error === "string") return payload.error;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Authenticated export download: fetch → Blob → object-URL anchor click.
 * Never a bare `<a href>` to the route — a 4xx there navigates the tab to
 * raw JSON (the valet-design lesson named in the spec); this path surfaces
 * the failure to the caller instead. Returns the filename it saved as.
 */
export async function downloadSecurityExport(
  sessionId: string,
  format: SecurityExportFormat,
  filters: SecurityFindingsFilters = {},
): Promise<string> {
  const res = await fetch(exportUrl(sessionId, format, filters));
  if (!res.ok) {
    let detail = "";
    try {
      const body: unknown = await res.json();
      if (typeof body === "object" && body !== null) {
        const e = (body as { error?: unknown }).error;
        if (typeof e === "string") detail = e;
      }
    } catch {
      // Non-JSON error body — the status alone has to do.
    }
    throw new Error(detail || `Export failed (${res.status}). Try again.`);
  }
  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename = match?.[1] ?? `valet-security-${sessionId}.${format}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  // Firefox honours `download` only on an in-DOM anchor; a synchronous
  // revoke races the save — defer it a tick (same as ~/lib/download).
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return filename;
}
