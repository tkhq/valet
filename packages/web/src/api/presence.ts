/**
 * Query hooks for the Presence hub (docs/specs/2026-10-16-presence-hub-design.md
 * Part B): the places a workspace is present in, one place's page, and the
 * titles of the threads that listeners pin.
 */
import { useMemo } from "react";
import { skipToken, useQueries, useQuery } from "@tanstack/react-query";
import type { EventSubscriptionWire, ListPresencePlacesResponse, PresencePlaceDetailResponse, PresencePlaceWire } from "@valet/api/wire";
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
  // A new array each render would hand `useQueries` new options every time;
  // the queries change only when the pinned threads do.
  const queries = useMemo(() => {
    const bySession = new Map<string, Set<string>>();
    for (const sub of listeners) {
      const thread = sub.target.kind === "assistant" ? sub.target.thread : undefined;
      if (thread?.mode !== "existing") continue;
      const ids = bySession.get(thread.sessionId) ?? new Set<string>();
      ids.add(thread.threadId);
      bySession.set(thread.sessionId, ids);
    }
    return [...bySession].map(([sessionId, ids]) => {
      const threadIds = [...ids].sort();
      return {
        queryKey: qkPresence.threadTitles(sessionId, threadIds),
        queryFn: () => api.listThreads(sessionId, { fixedIds: threadIds, fixedOnly: true }),
        staleTime: 60_000,
      };
    });
  }, [listeners]);
  const results = useQueries({ queries });
  const titles: Record<string, { title: string | null | undefined }> = {};
  for (const result of results) {
    for (const thread of result.data?.threads ?? []) titles[thread.id] = { title: thread.title };
  }
  return titles;
}

/**
 * The place key for a thread's channel key. A Slack channel key
 * (`slack:C123`) names no Slack workspace, and a place key does
 * (`slack:T1/C123`). The org connects one Slack workspace, so its top row in
 * the places list supplies it. With no such row the key stays as it is, and
 * the places API resolves it.
 */
export function placeSubjectFor(channelKey: string, places: readonly PresencePlaceWire[] | undefined): string {
  const channel = /^slack:([^/]+)$/.exec(channelKey)?.[1];
  if (channel === undefined) return channelKey;
  const workspaces = (places ?? []).filter((place) => place.service === "slack" && place.parent === null);
  const team = workspaces.length === 1 ? /^slack:([^/]+)$/.exec(workspaces[0]!.subject)?.[1] : undefined;
  return team !== undefined && team !== channel ? `slack:${team}/${channel}` : channelKey;
}

/** `placeSubjectFor` over the active workspace's places. */
export function usePlaceSubject(channelKey: string): string {
  return placeSubjectFor(channelKey, usePresencePlaces().data?.places);
}
