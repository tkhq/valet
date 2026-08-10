/**
 * Query/mutation hooks for the events system: the org activity feed,
 * per-event detail (payload + delivery attempts), the plugin trigger
 * catalog, and event-subscription CRUD. Thin wrappers over `api` client
 * methods, mirroring `settings.ts`/`workflows.ts` conventions.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type {
  CreateEventSubscriptionRequest,
  CreateEventSubscriptionResponse,
  GetEventCatalogResponse,
  GetEventResponse,
  ListEventsResponse,
  ListEventSubscriptionsResponse,
  PatchEventSubscriptionRequest,
  PatchEventSubscriptionResponse,
} from "@valet/api/wire";
import { api } from "./client";

export const qkEvents = {
  catalog: () => ["events", "catalog"] as const,
  feed: (service?: string, key?: string) => ["events", "feed", service ?? "", key ?? ""] as const,
  detail: (id: string) => ["events", "detail", id] as const,
  subscriptions: () => ["events", "subscriptions"] as const,
};

export function useEventCatalog(opts?: Partial<UseQueryOptions<GetEventCatalogResponse>>) {
  return useQuery<GetEventCatalogResponse>({
    queryKey: qkEvents.catalog(),
    queryFn: () => api.getEventCatalog(),
    // The catalog only changes on a plugin registry change (a deploy).
    staleTime: 5 * 60_000,
    ...opts,
  });
}

export function useEvents(
  params?: { service?: string; key?: string },
  opts?: Partial<UseQueryOptions<ListEventsResponse>>,
) {
  return useQuery<ListEventsResponse>({
    queryKey: qkEvents.feed(params?.service, params?.key),
    queryFn: () => api.listEvents(params),
    // New events arrive from external webhooks at any time.
    refetchInterval: 30_000,
    ...opts,
  });
}

export function useEvent(id: string | null, opts?: Partial<UseQueryOptions<GetEventResponse>>) {
  return useQuery<GetEventResponse>({
    queryKey: qkEvents.detail(id ?? ""),
    queryFn: () => api.getEvent(id ?? ""),
    enabled: id !== null,
    ...opts,
  });
}

export function useEventSubscriptions(
  opts?: Partial<UseQueryOptions<ListEventSubscriptionsResponse>>,
) {
  return useQuery<ListEventSubscriptionsResponse>({
    queryKey: qkEvents.subscriptions(),
    queryFn: () => api.listEventSubscriptions(),
    ...opts,
  });
}

export function useCreateEventSubscription() {
  const qc = useQueryClient();
  return useMutation<CreateEventSubscriptionResponse, Error, CreateEventSubscriptionRequest>({
    mutationFn: (body) => api.createEventSubscription(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkEvents.subscriptions() });
    },
  });
}

export function usePatchEventSubscription() {
  const qc = useQueryClient();
  return useMutation<
    PatchEventSubscriptionResponse,
    Error,
    { id: string; body: PatchEventSubscriptionRequest }
  >({
    mutationFn: ({ id, body }) => api.patchEventSubscription(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkEvents.subscriptions() });
    },
  });
}

export function useDeleteEventSubscription() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => api.deleteEventSubscription(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkEvents.subscriptions() });
    },
  });
}
