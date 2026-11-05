/**
 * Admin audit log (`GET /api/org/audit-log`,
 * docs/specs/2026-11-03-admin-audit-log-design.md). Newest first; each page
 * is keyset-paginated, and Load more fetches the next one.
 */
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "./client";

export const qkAuditLog = {
  all: () => ["audit-log"] as const,
};

export function useAdminAuditLog() {
  return useInfiniteQuery({
    queryKey: qkAuditLog.all(),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.listAdminAudit(pageParam ? { cursor: pageParam } : undefined),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}
