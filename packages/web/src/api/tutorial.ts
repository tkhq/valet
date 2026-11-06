import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TutorialStateResponse, UpdateTutorialRequest } from "@valet/api/wire";
import { api } from "./client";

export const qkTutorial = { state: ["tutorial", "state"] as const };

/** The person's tour state: whether it is due and where to resume. */
export function useTutorialState(enabled = true) {
  return useQuery({ queryKey: qkTutorial.state, queryFn: () => api.tutorial(), staleTime: Infinity, enabled });
}

/** Save the resume step, or finish or skip. The reply replaces the cached state. */
export function useSaveTutorial() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateTutorialRequest) => api.updateTutorial(body),
    onSuccess: (state) => qc.setQueryData<TutorialStateResponse>(qkTutorial.state, state),
  });
}

/** Org admin: show the tour to every member again on their next load. */
export function useResetTutorialForEveryone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.resetTutorial(),
    onSuccess: () => qc.invalidateQueries({ queryKey: qkTutorial.state }),
  });
}
