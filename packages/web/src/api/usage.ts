/**
 * TanStack Query hooks for the unified spend dashboard.
 * Consumes `GET /api/usage/breakdown`, `GET /api/usage/items`.
 * Routed through the central `api` client for 401→login handling.
 */
import type { UseQueryOptions } from "@tanstack/react-query";
import type {
  UsageDrillResponse,
  UsagePeriodSelection,
  UsageBreakdownResponse,
  UsageScopeName,
  UsageToolEfficiencyResponse,
  UsageOutcomesResponse,
  UsageUseCase,
} from "@valet/api/wire";
import { api } from "~/api/client";
import { useCancellableQuery } from "./use-cancellable-query";

export const qkUsage = {
  breakdown: (period: UsagePeriodSelection, scope: UsageScopeName = "me", teamId?: string) =>
    ["usage", "breakdown", period, scope, teamId] as const,
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
  return useCancellableQuery<UsageOutcomesResponse>({
    queryKey: qkUsage.outcomes(period, scope, teamId),
    queryFn: ({ signal }) => api.usageOutcomes(period, scope, teamId, signal),
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
  return useCancellableQuery<UsageToolEfficiencyResponse>({
    queryKey: qkUsage.toolEfficiency(period, scope, teamId),
    queryFn: ({ signal }) => api.usageToolEfficiency(period, scope, teamId, signal),
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
  return useCancellableQuery<UsageBreakdownResponse>({
    queryKey: qkUsage.breakdown(period, scope, teamId),
    queryFn: ({ signal }) => api.usageBreakdown(period, scope, teamId, signal),
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
  return useCancellableQuery<UsageDrillResponse>({
    queryKey: qkUsage.items(period, scope, useCase, teamId),
    queryFn: ({ signal }) => api.usageItems(period, scope, useCase, teamId, signal),
    staleTime: 60_000,
    ...opts,
  });
}
