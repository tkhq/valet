/**
 * Security engagement queries (valet-security design, §Web Surfaces). House
 * pattern: a query-key factory per resource file, mirroring `~/api/workflows`.
 * M7 ships the hub's reads; M8 extends this file with findings, triage
 * mutations, and polling.
 */
import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import type { GetSessionSecurityResponse, ListSessionsResponse } from "@valet/api/wire";
import { api, type OwnerFilter } from "./client";

export const qkSecurity = {
  /** Under the `["sessions"]` prefix on purpose: `useCreateSession`
   * invalidates that prefix, so a just-created review refreshes this list
   * with no extra wiring. The owner stays trailing, same as `qk.sessions`. */
  reviews: (owner?: OwnerFilter) =>
    ["sessions", "security-reviews", ...(owner ? [owner.ownerType, owner.ownerId] : [])] as const,
  /** Under `qk.session(id)` so invalidating the session row clears this too. */
  engagement: (sessionId: string) => ["sessions", sessionId, "security"] as const,
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
 * The hub reads the engagement's status and repo per row; M8's panel reads
 * the cells. */
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
