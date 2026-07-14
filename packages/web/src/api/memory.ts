/**
 * Memory queries (assistant-centered web UI, decision 7). House pattern: a
 * query-key factory per resource file, mirroring `~/api/queries` and
 * `~/api/orchestrator`. The dashboard memory card uses `tree` + `doc`; the
 * Task 6 explorer adds `search` on top of the same factory.
 */
import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import type { GetMemoryTreeResponse } from "@valet/api/wire";
import { api, ApiError } from "./client";
import type { GetMemoryDocResponse } from "./memory-types";

export const qkMemory = {
  tree: () => ["memory", "tree"] as const,
  doc: (path: string) => ["memory", "doc", path] as const,
};

export function useMemoryTree(opts?: UseQueryOptions<GetMemoryTreeResponse>) {
  return useQuery<GetMemoryTreeResponse>({
    queryKey: qkMemory.tree(),
    queryFn: () => api.getMemoryTree(),
    ...opts,
  });
}

/**
 * A single doc read (e.g. today's journal for the dashboard card, or the
 * detail pane in the Task 6 explorer). 404 (no file at this path yet — the
 * common case for "today's journal" before the assistant has written
 * anything) is a normal, expected outcome, not a card-blanking error —
 * callers branch on `query.error instanceof ApiError && error.status ===
 * 404` to show an in-voice empty state instead of a retry.
 */
export function useMemoryDoc(
  path: string,
  opts?: UseQueryOptions<GetMemoryDocResponse>,
) {
  return useQuery<GetMemoryDocResponse>({
    queryKey: qkMemory.doc(path),
    queryFn: () => api.getMemoryDoc(path),
    retry: (failureCount, error) => {
      if (error instanceof ApiError && error.status === 404) return false;
      return failureCount < 2;
    },
    ...opts,
  });
}
