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
  RedeliverEventResponse,
} from "@valet/api/wire";
import { api, type OwnerFilter } from "./client";

/** The workspace, as trailing key elements. Same shape as `qkMemory`'s:
 * trailing, so the bare prefix stays the key that invalidates every
 * workspace at once. An absent owner adds nothing, which is the key an
 * unscoped list already had. */
function ownerKey(owner?: OwnerFilter): readonly string[] {
  return owner ? [owner.ownerType, owner.ownerId] : [];
}

export const qkEvents = {
  catalog: () => ["events", "catalog"] as const,
  feed: (service?: string, key?: string, owner?: OwnerFilter) =>
    ["events", "feed", service ?? "", key ?? "", ...ownerKey(owner)] as const,
  detail: (id: string) => ["events", "detail", id] as const,
  subscriptions: (owner?: OwnerFilter) => ["events", "subscriptions", ...ownerKey(owner)] as const,
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

/** `owner` narrows the feed to events delivered to that owner's
 * subscriptions. Undefined keeps the whole org's feed, which is what the
 * page's "All" state sends. */
export function useEvents(
  params?: { service?: string; key?: string },
  owner?: OwnerFilter,
  opts?: Partial<UseQueryOptions<ListEventsResponse>>,
) {
  return useQuery<ListEventsResponse>({
    queryKey: qkEvents.feed(params?.service, params?.key, owner),
    queryFn: () => api.listEvents(params, owner),
    // New events arrive from external webhooks at any time.
    refetchInterval: 30_000,
    ...opts,
  });
}

export function useEvent(id: string, opts?: Partial<UseQueryOptions<GetEventResponse>>) {
  return useQuery<GetEventResponse>({
    queryKey: qkEvents.detail(id),
    queryFn: () => api.getEvent(id),
    // Deliveries advance (pending -> delivered/failed) while a row stays
    // expanded; poll so the badge follows.
    refetchInterval: 15_000,
    ...opts,
  });
}

/**
 * Replays one event through the subscriptions that match it now. The server
 * writes NEW delivery rows, so the detail query is refetched to show them.
 */
export function useRedeliverEvent(id: string) {
  const qc = useQueryClient();
  return useMutation<RedeliverEventResponse, Error, void>({
    mutationFn: () => api.redeliverEvent(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkEvents.detail(id) });
    },
  });
}

/** `owner` scopes the list to one workspace — your own subscriptions, or one
 * team's — plus every org-owned subscription, which belongs to no single
 * workspace. Undefined lists every subscription in the org. */
export function useEventSubscriptions(
  owner?: OwnerFilter,
  opts?: Partial<UseQueryOptions<ListEventSubscriptionsResponse>>,
) {
  return useQuery<ListEventSubscriptionsResponse>({
    queryKey: qkEvents.subscriptions(owner),
    queryFn: () => api.listEventSubscriptions(owner),
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
