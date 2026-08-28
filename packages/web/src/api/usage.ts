/**
 * TanStack Query hooks for the unified spend dashboard.
 * Consumes `GET /api/usage/breakdown`, `GET /api/usage/items`.
 * Routed through the central `api` client for 401→login handling.
 */
import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import type {
  UsageDrillResponse,
  UsageBreakdownResponse,
  UsageSessionsResponse,
  UsageScopeName,
  UsageUseCase,
} from "@valet/api/wire";
import { api } from "~/api/client";

export const qkUsage = {
  breakdown: (window: string, scope: UsageScopeName = "me", teamId?: string) =>
    ["usage", "breakdown", window, scope, teamId] as const,
  sessions: (window: string, useCase?: "orchestrator" | "session") =>
    ["usage", "sessions", window, useCase] as const,
  items: (window: string, scope: UsageScopeName, useCase: UsageUseCase, teamId?: string) =>
    ["usage", "items", window, scope, useCase, teamId] as const,
};

export function useUsageBreakdown(
  window: string = "7d",
  scope: UsageScopeName = "me",
  teamId?: string,
  opts?: Partial<UseQueryOptions<UsageBreakdownResponse>>,
) {
  return useQuery<UsageBreakdownResponse>({
    queryKey: qkUsage.breakdown(window, scope, teamId),
    queryFn: () => api.usageBreakdown(window, scope, teamId),
    staleTime: 60_000,
    ...opts,
  });
}

export function useUsageItems(
  window: string,
  scope: UsageScopeName,
  useCase: UsageUseCase,
  teamId?: string,
  opts?: Partial<UseQueryOptions<UsageDrillResponse>>,
) {
  return useQuery<UsageDrillResponse>({
    queryKey: qkUsage.items(window, scope, useCase, teamId),
    queryFn: () => api.usageItems(window, scope, useCase, teamId),
    staleTime: 60_000,
    ...opts,
  });
}

/** Kept for backward compatibility with any other callers. */
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
