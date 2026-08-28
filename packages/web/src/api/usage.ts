/**
 * TanStack Query hooks for the unified spend dashboard.
 * Consumes `GET /api/usage/breakdown`, `GET /api/usage/items`.
 * Routed through the central `api` client for 401→login handling.
 */
import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import type {
  UsageDrillResponse,
  UsageBreakdownResponse,
  UsageScopeRequest,
  UsageSessionsResponse,
  UsageUseCase,
} from "@valet/api/wire";
import { api } from "~/api/client";

export const qkUsage = {
  breakdown: (window: string, scope: UsageScopeRequest = "me") =>
    ["usage", "breakdown", window, scope] as const,
  sessions: (window: string, useCase?: "orchestrator" | "session") =>
    ["usage", "sessions", window, useCase] as const,
  items: (window: string, scope: UsageScopeRequest, useCase: UsageUseCase) =>
    ["usage", "items", window, scope, useCase] as const,
};

export function useUsageBreakdown(
  window: string = "7d",
  scope: UsageScopeRequest = "me",
  opts?: Partial<UseQueryOptions<UsageBreakdownResponse>>,
) {
  return useQuery<UsageBreakdownResponse>({
    queryKey: qkUsage.breakdown(window, scope),
    queryFn: () => api.usageBreakdown(window, scope),
    staleTime: 60_000,
    ...opts,
  });
}

export function useUsageItems(
  window: string,
  scope: UsageScopeRequest,
  useCase: UsageUseCase,
  opts?: Partial<UseQueryOptions<UsageDrillResponse>>,
) {
  return useQuery<UsageDrillResponse>({
    queryKey: qkUsage.items(window, scope, useCase),
    queryFn: () => api.usageItems(window, scope, useCase),
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
