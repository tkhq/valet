/**
 * TanStack Query hooks for the unified spend dashboard.
 * Consumes `GET /api/usage/breakdown`, `GET /api/usage/items`.
 * Routed through the central `api` client for 401→login handling.
 */
import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import type {
  UsageDrillResponse,
  UsagePeriodSelection,
  UsageBreakdownResponse,
  UsageSessionsResponse,
  UsageScopeName,
  UsageToolEfficiencyResponse,
  UsageOutcomesResponse,
  UsageUseCase,
} from "@valet/api/wire";
import { api } from "~/api/client";

export const qkUsage = {
  breakdown: (period: UsagePeriodSelection, scope: UsageScopeName = "me", teamId?: string) =>
    ["usage", "breakdown", period, scope, teamId] as const,
  sessions: (window: string, useCase?: "orchestrator" | "session") =>
    ["usage", "sessions", window, useCase] as const,
  items: (period: UsagePeriodSelection, scope: UsageScopeName, useCase: UsageUseCase, teamId?: string) =>
    ["usage", "items", period, scope, useCase, teamId] as const,
  toolEfficiency: (period: UsagePeriodSelection, scope: UsageScopeName, teamId?: string) =>
    ["usage", "tool-efficiency", period, scope, teamId] as const,
  outcomes: (period: UsagePeriodSelection, scope: UsageScopeName, teamId?: string) =>
    ["usage", "outcomes", period, scope, teamId] as const,
};

export function useUsageOutcomes(
  period: UsagePeriodSelection,
  scope: UsageScopeName,
  teamId?: string,
  opts?: Partial<UseQueryOptions<UsageOutcomesResponse>>,
) {
  return useQuery<UsageOutcomesResponse>({
    queryKey: qkUsage.outcomes(period, scope, teamId),
    queryFn: () => api.usageOutcomes(period, scope, teamId),
    staleTime: 60_000,
    ...opts,
  });
}

export function useUsageToolEfficiency(
  period: UsagePeriodSelection,
  scope: UsageScopeName,
  teamId?: string,
  opts?: Partial<UseQueryOptions<UsageToolEfficiencyResponse>>,
) {
  return useQuery<UsageToolEfficiencyResponse>({
    queryKey: qkUsage.toolEfficiency(period, scope, teamId),
    queryFn: () => api.usageToolEfficiency(period, scope, teamId),
    staleTime: 60_000,
    ...opts,
  });
}

export function useUsageBreakdown(
  period: UsagePeriodSelection,
  scope: UsageScopeName = "me",
  teamId?: string,
  opts?: Partial<UseQueryOptions<UsageBreakdownResponse>>,
) {
  return useQuery<UsageBreakdownResponse>({
    queryKey: qkUsage.breakdown(period, scope, teamId),
    queryFn: () => api.usageBreakdown(period, scope, teamId),
    staleTime: 60_000,
    ...opts,
  });
}

export function useUsageItems(
  period: UsagePeriodSelection,
  scope: UsageScopeName,
  useCase: UsageUseCase,
  teamId?: string,
  opts?: Partial<UseQueryOptions<UsageDrillResponse>>,
) {
  return useQuery<UsageDrillResponse>({
    queryKey: qkUsage.items(period, scope, useCase, teamId),
    queryFn: () => api.usageItems(period, scope, useCase, teamId),
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
