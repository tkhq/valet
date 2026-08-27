/**
 * TanStack Query hooks for the unified spend dashboard.
 * Consumes `GET /api/usage/breakdown` and `GET /api/usage/sessions`.
 * Routed through the central `api` client for 401→login handling.
 */
import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import type { UsageBreakdownResponse, UsageSessionsResponse } from "@valet/api/wire";
import { api } from "~/api/client";

export const qkUsage = {
  breakdown: (window: string) => ["usage", "breakdown", window] as const,
  sessions: (window: string, useCase?: "orchestrator" | "session") =>
    ["usage", "sessions", window, useCase] as const,
};

export function useUsageBreakdown(
  window: string = "7d",
  opts?: Partial<UseQueryOptions<UsageBreakdownResponse>>,
) {
  return useQuery<UsageBreakdownResponse>({
    queryKey: qkUsage.breakdown(window),
    queryFn: () => api.usageBreakdown(window),
    staleTime: 60_000,
    ...opts,
  });
}

export function useUsageSessions(
  window: string = "7d",
  useCase?: "orchestrator" | "session",
  opts?: Partial<UseQueryOptions<UsageSessionsResponse>>,
) {
  return useQuery<UsageSessionsResponse>({
    queryKey: qkUsage.sessions(window, useCase),
    queryFn: () => api.usageSessions(window, useCase),
    staleTime: 60_000,
    ...opts,
  });
}
