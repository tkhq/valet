/**
 * Query hooks for the Presence hub (docs/specs/2026-10-16-presence-hub-design.md
 * Part B): the places a workspace is present in, one place's page, and the
 * titles of the threads that listeners pin.
 */
import { skipToken, useQueries, useQuery } from "@tanstack/react-query";
import type { EventSubscriptionWire, ListPresencePlacesResponse, PresencePlaceDetailResponse } from "@valet/api/wire";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import type { ThreadTitles } from "~/components/presence/sentences";
import { api } from "./client";

/** The workspace key the presence reads take: `user`, or a team id. It is a
 * trailing key element, so `["presence"]` still clears every workspace. */
export const qkPresence = {
  all: ["presence"] as const,
  places: (scope: string) => ["presence", "places", scope] as const,
  place: (scope: string, subject: string) => ["presence", "place", scope, subject] as const,
  threadTitles: (sessionId: string, threadIds: readonly string[]) =>
    ["presence", "thread-titles", sessionId, ...threadIds] as const,
};

/** The switcher's workspace as the `scope` the presence reads take. */
export function usePresenceScope(): string {
  return useWorkspaceScope().teamId ?? "user";
}

/** The places the active workspace is present in. */
export function usePresencePlaces() {
  const scope = usePresenceScope();
  return useQuery<ListPresencePlacesResponse>({
    queryKey: qkPresence.places(scope),
    queryFn: () => api.listPresencePlaces(scope),
    staleTime: 30_000,
  });
}

/** One place's page: its listeners, threads, and recent activity. */
export function usePresencePlace(subject: string) {
  const scope = usePresenceScope();
  return useQuery<PresencePlaceDetailResponse>({
    queryKey: qkPresence.place(scope, subject),
    queryFn: subject !== "" ? () => api.getPresencePlace(scope, subject) : skipToken,
    // Active threads and activity change while the page is open.
    refetchInterval: 15_000,
  });
}

/**
 * The titles of the threads that listeners pin with an `existing` policy, so
 * a sentence reads `works in the thread Platform CI`. One read per assistant
 * session. A thread the read does not return (archived, or not visible)
 * reads as a generic name in the sentence.
 */
export function usePinnedThreadTitles(listeners: readonly EventSubscriptionWire[]): ThreadTitles {
  const bySession = new Map<string, Set<string>>();
  for (const sub of listeners) {
    const thread = sub.target.kind === "assistant" ? sub.target.thread : undefined;
    if (thread?.mode !== "existing") continue;
    const ids = bySession.get(thread.sessionId) ?? new Set<string>();
    ids.add(thread.threadId);
    bySession.set(thread.sessionId, ids);
  }
  const reads = [...bySession].map(([sessionId, ids]) => ({ sessionId, threadIds: [...ids].sort() }));
  const results = useQueries({
    queries: reads.map(({ sessionId, threadIds }) => ({
      queryKey: qkPresence.threadTitles(sessionId, threadIds),
      queryFn: () => api.listThreads(sessionId, { fixedIds: threadIds, fixedOnly: true }),
      staleTime: 60_000,
    })),
  });
  const titles: Record<string, { title: string | null | undefined }> = {};
  for (const result of results) {
    for (const thread of result.data?.threads ?? []) titles[thread.id] = { title: thread.title };
  }
  return titles;
}
