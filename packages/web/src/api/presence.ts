/**
 * Query hooks for the Presence hub (docs/specs/2026-10-16-presence-hub-design.md
 * Part B): the places a workspace is present in and one place's page. A
 * pinned thread's title is `usePinnedThreadTitles` in `./listener`.
 */
import { skipToken, useQuery } from "@tanstack/react-query";
import type { ListPresencePlacesResponse, PresencePlaceDetailResponse, PresencePlaceWire } from "@valet/api/wire";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { api } from "./client";

/** The workspace key the presence reads take: `user`, or a team id. It is a
 * trailing key element, so `["presence"]` still clears every workspace. */
export const qkPresence = {
  all: ["presence"] as const,
  places: (scope: string) => ["presence", "places", scope] as const,
  place: (scope: string, subject: string) => ["presence", "place", scope, subject] as const,
};

/** The switcher's workspace as the `scope` the presence reads take. */
export function usePresenceScope(): string {
  return useWorkspaceScope().teamId ?? "user";
}

/** The places the active workspace is present in. The Presence rail
 * refreshes them every 60 seconds (spec Part B step 7). */
export function usePresencePlaces(options: { enabled?: boolean; staleTime?: number; refetchInterval?: number } = {}) {
  const scope = usePresenceScope();
  return useQuery<ListPresencePlacesResponse>({
    queryKey: qkPresence.places(scope),
    queryFn: () => api.listPresencePlaces(scope),
    staleTime: options.staleTime ?? 30_000,
    enabled: options.enabled ?? true,
    ...(options.refetchInterval !== undefined ? { refetchInterval: options.refetchInterval } : {}),
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

const SLACK_SUBJECT_RE = /^slack:([^/]+)(?:\/([^/]+)(?:\/[^/]+)?)?$/;
const GITHUB_SUBJECT_RE = /^github:([^/#@]+)\/([^/#@]+)(?:#(\d+)|@[0-9a-f]+)?$/i;
const LINEAR_SUBJECT_RE = /^linear:(?:team\/)?[A-Za-z0-9_-]+$/;

/**
 * The place a subject belongs to, or null when it names none. It mirrors
 * the server's `placeOfSubject` (packages/api/src/services/presence-places.ts),
 * so a link names the key the places API lists: a Slack thread belongs to
 * its channel, a GitHub owner and repository are lowercase, and a commit
 * (`@<sha>`) belongs to its repository.
 */
export function placeOfSubject(subject: string): string | null {
  const slack = SLACK_SUBJECT_RE.exec(subject);
  if (slack) return slack[2] ? `slack:${slack[1]}/${slack[2]}` : `slack:${slack[1]}`;
  const github = GITHUB_SUBJECT_RE.exec(subject);
  if (github) {
    const repo = `github:${github[1]!.toLowerCase()}/${github[2]!.toLowerCase()}`;
    return github[3] ? `${repo}#${github[3]}` : repo;
  }
  return LINEAR_SUBJECT_RE.test(subject) ? subject : null;
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

/** `placeSubjectFor` over the active workspace's places. Only a
 * channel-only Slack key reads the places list, and the read stays fresh
 * for five minutes: a thread page shows this link, and the org's Slack
 * workspace rarely changes. */
export function usePlaceSubject(channelKey: string): string {
  const places = usePresencePlaces({ enabled: /^slack:[^/]+$/.test(channelKey), staleTime: 5 * 60_000 });
  return placeSubjectFor(channelKey, places.data?.places);
}
