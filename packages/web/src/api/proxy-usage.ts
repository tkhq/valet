/**
 * TanStack Query hooks for the recording-gateway usage API.
 * Consumes `GET /api/proxy/usage/summary`, `GET /api/proxy/requests`, and
 * `GET /api/proxy/requests/:id` (LLM recording gateway, Task 9 backend).
 *
 * Routed through the central `api` client so 401→login handling and the
 * 30-second request timeout apply the same way as every other page.
 */
import { useQuery, useMutation, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import type {
  ProxyUsageSummary,
  ProxyRequestListItem,
  ProxyRequestDetail,
  ProxySettingsResponse,
} from "@valet/api/wire";
import { api } from "~/api/client";

export const qkProxy = {
  summary: (window: string) => ["proxy", "usage", "summary", window] as const,
  requests: (filters: ProxyRequestFilters) => ["proxy", "requests", filters] as const,
  detail: (id: string) => ["proxy", "requests", id] as const,
  settings: () => ["proxy", "settings"] as const,
};

export interface ProxyRequestFilters {
  user?: string;
  model?: string;
  harness?: string;
  from?: number;
  to?: number;
  cursor?: string;
  limit?: number;
}

export interface ProxyRequestListResponse {
  items: ProxyRequestListItem[];
  nextCursor?: string;
}

export function useProxyUsageSummary(
  window: string = "7d",
  opts?: Partial<UseQueryOptions<ProxyUsageSummary>>,
) {
  return useQuery<ProxyUsageSummary>({
    queryKey: qkProxy.summary(window),
    queryFn: () => api.proxyUsageSummary(window),
    staleTime: 60_000,
    ...opts,
  });
}

export function useProxyRequests(
  filters: ProxyRequestFilters = {},
  opts?: Partial<UseQueryOptions<ProxyRequestListResponse>>,
) {
  return useQuery<ProxyRequestListResponse>({
    queryKey: qkProxy.requests(filters),
    queryFn: async () => {
      const raw = await api.proxyRequests(filters);
      // The backend returns `{ requests, nextCursor }` but the hook exposes
      // `{ items, nextCursor }` so callers don't need to know the key name.
      return { items: raw.requests, nextCursor: raw.nextCursor };
    },
    staleTime: 30_000,
    ...opts,
  });
}

export function useProxyRequestDetail(
  id: string,
  opts?: Partial<UseQueryOptions<ProxyRequestDetail>>,
) {
  return useQuery<ProxyRequestDetail>({
    queryKey: qkProxy.detail(id),
    queryFn: () => api.proxyRequestDetail(id),
    enabled: !!id,
    staleTime: 5 * 60_000,
    ...opts,
  });
}

export function useProxySettings(
  opts?: Partial<UseQueryOptions<ProxySettingsResponse>>,
) {
  return useQuery<ProxySettingsResponse>({
    queryKey: qkProxy.settings(),
    queryFn: () => api.proxySettings(),
    staleTime: 60_000,
    ...opts,
  });
}

export function useSetProxyMode() {
  const qc = useQueryClient();
  return useMutation<ProxySettingsResponse, Error, "centralized" | "passthrough">({
    mutationFn: (mode) => api.setProxyMode(mode),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qkProxy.settings() });
    },
  });
}

export function useSetProxyEnabled() {
  const qc = useQueryClient();
  return useMutation<ProxySettingsResponse, Error, boolean>({
    mutationFn: (enabled) => api.updateProxySettings({ enabled }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qkProxy.settings() });
    },
  });
}
