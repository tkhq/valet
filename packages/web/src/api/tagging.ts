import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

export function useEditTagKey() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (input: { key: string; label: string; definition: string }) => api.editTagKey("tool_intent", input.key, input),
    onSuccess: () => client.invalidateQueries({ queryKey: ["usage"] }) });
}
export function useMergeTagKey() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (input: { key: string; into: string }) => api.mergeTagKey("tool_intent", input.key, input.into),
    onSuccess: () => client.invalidateQueries({ queryKey: ["usage"] }) });
}
