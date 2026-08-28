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

/** Key marker for a scoped query whose owner has not resolved. Not a valid
 * `ownerType`, so it can never collide with a real owner pair. */
const UNRESOLVED_OWNER = "owner-unresolved";

/** The workspace, as TRAILING key elements, so the bare prefix still
 * invalidates every workspace at once. Same shape as `qkMemory`'s.
 *
 * A held query sends no owner but must not read the unscoped cache entry:
 * a warm org-wide answer would render under a "This workspace" label. Hence
 * the third state. */
function ownerKey(owner: OwnerFilter | undefined, held: boolean): readonly string[] {
  if (owner) return [owner.ownerType, owner.ownerId];
  return held ? [UNRESOLVED_OWNER] : [];
}

export const qkEvents = {
  catalog: () => ["events", "catalog"] as const,
  feed: (service?: string, key?: string, owner?: OwnerFilter, held = false) =>
    ["events", "feed", service ?? "", key ?? "", ...ownerKey(owner, held)] as const,
  detail: (id: string) => ["events", "detail", id] as const,
  subscriptions: (owner?: OwnerFilter, held = false) =>
    ["events", "subscriptions", ...ownerKey(owner, held)] as const,
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
 * subscriptions. Undefined keeps the whole org's feed, unless the caller
 * also disabled the query, which means "one workspace, owner still
 * unknown". */
export function useEvents(
  params?: { service?: string; key?: string },
  owner?: OwnerFilter,
  opts?: Partial<UseQueryOptions<ListEventsResponse>>,
) {
  // Held for a missing owner, not unscoped on purpose — see `ownerKey`.
  const held = owner === undefined && opts?.enabled === false;
  return useQuery<ListEventsResponse>({
    queryKey: qkEvents.feed(params?.service, params?.key, owner, held),
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

/** `owner` scopes the list to one workspace plus every org-owned
 * subscription. Undefined lists every subscription in the org; an undefined
 * owner on a DISABLED query is the held workspace list instead. */
export function useEventSubscriptions(
  owner?: OwnerFilter,
  opts?: Partial<UseQueryOptions<ListEventSubscriptionsResponse>>,
) {
  const held = owner === undefined && opts?.enabled === false;
  return useQuery<ListEventSubscriptionsResponse>({
    queryKey: qkEvents.subscriptions(owner, held),
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
