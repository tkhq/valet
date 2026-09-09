import { useQuery } from "@tanstack/react-query";
import type { GetChangelogResponse } from "@valet/api/wire";
import { api } from "./client";

export const qkChangelog = {
  manifest: () => ["changelog"] as const,
};

export function useChangelog() {
  return useQuery<GetChangelogResponse>({
    queryKey: qkChangelog.manifest(),
    queryFn: api.getChangelog,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
