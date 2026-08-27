/**
 * TanStack Query hooks for the recording-gateway usage API.
 * Consumes `GET /api/proxy/usage/summary`, `GET /api/proxy/requests`, and
 * `GET /api/proxy/requests/:id` (LLM recording gateway, Task 9 backend).
 */
import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import type {
  ProxyUsageSummary,
  ProxyRequestListItem,
  ProxyRequestDetail,
} from "@valet/api/wire";

const BASE = "/api";

async function proxyGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export const qkProxy = {
  summary: (window: string) => ["proxy", "usage", "summary", window] as const,
  requests: (filters: ProxyRequestFilters) => ["proxy", "requests", filters] as const,
  detail: (id: string) => ["proxy", "requests", id] as const,
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
    queryFn: () => proxyGet(`/proxy/usage/summary?window=${encodeURIComponent(window)}`),
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
    queryFn: () => {
      const qs = new URLSearchParams();
      if (filters.user) qs.set("user", filters.user);
      if (filters.model) qs.set("model", filters.model);
      if (filters.harness) qs.set("harness", filters.harness);
      if (filters.from !== undefined) qs.set("from", String(filters.from));
      if (filters.to !== undefined) qs.set("to", String(filters.to));
      if (filters.cursor) qs.set("cursor", filters.cursor);
      if (filters.limit !== undefined) qs.set("limit", String(filters.limit));
      const tail = qs.toString() ? `?${qs}` : "";
      return proxyGet(`/proxy/requests${tail}`);
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
    queryFn: () => proxyGet(`/proxy/requests/${encodeURIComponent(id)}`),
    enabled: !!id,
    staleTime: 5 * 60_000,
    ...opts,
  });
}
