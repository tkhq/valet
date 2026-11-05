/**
 * The listeners and routines that feed a thread (docs/specs/
 * 2026-10-16-presence-hub-design.md Part G): the thread context card's
 * "Fed by" line. A separate file from `presence.ts` to avoid colliding with
 * parallel edits to that file during the presence hub build.
 */
import { useQuery } from "@tanstack/react-query";
import type { ListThreadFeedersResponse } from "@valet/api/wire";
import { ApiError, api } from "./client";

export const qkThreadFeeders = (sessionId: string, threadId: string) =>
  ["presence", "feeders", sessionId, threadId] as const;

const NO_FEEDERS: ListThreadFeedersResponse = { listeners: [], routines: [] };

/**
 * The listeners and routines that feed one thread. A thread the viewer
 * cannot read (404) resolves to an empty list rather than an error, so the
 * caller renders nothing instead of surfacing a failure. `enabled` lets a
 * caller skip the read until it knows the thread needs one.
 */
export function useThreadFeeders(sessionId: string, threadId: string, options: { enabled?: boolean } = {}) {
  return useQuery<ListThreadFeedersResponse>({
    queryKey: qkThreadFeeders(sessionId, threadId),
    queryFn: async () => {
      try {
        return await api.getThreadFeeders(sessionId, threadId);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return NO_FEEDERS;
        throw err;
      }
    },
    enabled: options.enabled ?? true,
    staleTime: 30_000,
  });
}
