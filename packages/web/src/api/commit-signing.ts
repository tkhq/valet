/**
 * TanStack Query hooks for commit signing (agent commit signing design):
 * the user's enrollment state and keys, and the enroll mutation that posts
 * the passkey attestation the browser created with `@turnkey/sdk-browser`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  GetCommitSigningResponse,
  PostCommitSigningEnrollRequest,
  PostCommitSigningEnrollResponse,
} from "@valet/api/wire";
import { api } from "./client";

export const qkCommitSigning = {
  all: () => ["commit-signing"] as const,
};

export function useCommitSigning() {
  return useQuery<GetCommitSigningResponse>({
    queryKey: qkCommitSigning.all(),
    queryFn: () => api.getCommitSigning(),
  });
}

export function useEnrollCommitSigning() {
  const qc = useQueryClient();
  return useMutation<PostCommitSigningEnrollResponse, Error, PostCommitSigningEnrollRequest>({
    mutationFn: (body) => api.enrollCommitSigning(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qkCommitSigning.all() });
    },
  });
}
