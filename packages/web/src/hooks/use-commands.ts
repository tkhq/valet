/**
 * Fetches the merged command registry for a session.
 * Used by the composer autocomplete to populate the slash-command popup.
 */
import { useQuery } from "@tanstack/react-query";
import type { ListCommandsResponse } from "@valet/api/wire";
import { api } from "~/api/client";

export function useCommands(sessionId: string) {
  return useQuery<ListCommandsResponse>({
    queryKey: ["commands", sessionId],
    queryFn: () => api.listCommands(sessionId),
    enabled: !!sessionId,
    staleTime: 30_000,
  });
}
