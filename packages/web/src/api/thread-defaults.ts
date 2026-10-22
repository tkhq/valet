/** The model and reasoning a new thread starts with (`GET /api/sessions/:id/thread-defaults`). */
import { useQuery } from "@tanstack/react-query";
import { api } from "./client";

export const qkThreadDefaults = {
  all: ["thread-defaults"] as const,
  session: (sessionId: string) => ["thread-defaults", sessionId] as const,
};

export function useThreadDefaults(sessionId: string, enabled = true) {
  return useQuery({
    queryKey: qkThreadDefaults.session(sessionId),
    queryFn: () => api.getThreadDefaults(sessionId),
    enabled,
  });
}
