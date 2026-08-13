/**
 * Assistants: the rows a principal owns, and the writes that create, rename
 * and archive them (`docs/specs/2026-08-13-assistants-design.md`).
 *
 * House pattern: a query-key factory per resource file, mirroring
 * `~/api/queries`. Every write invalidates the one list key, because the
 * list is what the whole client reads — the rail, the chat route and the
 * session header all resolve an assistant from it.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type {
  AssistantSummary,
  CreateAssistantRequest,
  CreateAssistantResponse,
  EnsureAssistantSessionResponse,
  ListAssistantsResponse,
  PatchAssistantRequest,
  PatchAssistantResponse,
} from "@valet/api/wire";
import { api } from "./client";

export const qkAssistants = {
  list: () => ["assistants"] as const,
};

export function useAssistants(opts?: Partial<UseQueryOptions<ListAssistantsResponse>>) {
  return useQuery<ListAssistantsResponse>({
    queryKey: qkAssistants.list(),
    queryFn: () => api.listAssistants(),
    ...opts,
  });
}

/**
 * The assistant a principal's machine-driven paths target, and the one a
 * link means when it says "open this team's assistant" — a caller that knows
 * only an owner has no basis for choosing between several, which is the same
 * problem workflow nodes and channel bindings resolve this way.
 *
 * Undefined when the list has not arrived, or when the owner has no
 * assistant the caller may open. A caller must not link at all in that case:
 * there is no id to link to.
 */
export function defaultAssistantFor(
  assistants: AssistantSummary[] | undefined,
  ownerType: "user" | "team" | "org",
  ownerId: string,
): AssistantSummary | undefined {
  const owned = (assistants ?? []).filter(
    (a) => a.owner.type === ownerType && a.owner.id === ownerId,
  );
  return owned.find((a) => a.isDefault) ?? owned[0];
}

export function useCreateAssistant() {
  const qc = useQueryClient();
  return useMutation<CreateAssistantResponse, Error, CreateAssistantRequest>({
    mutationFn: (body) => api.createAssistant(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkAssistants.list() });
    },
  });
}

/** Rename, or promote to default. `isDefault: true` demotes the previous
 * default in the same write, so no separate demote call exists. */
export function usePatchAssistant() {
  const qc = useQueryClient();
  return useMutation<PatchAssistantResponse, Error, { id: string; body: PatchAssistantRequest }>({
    mutationFn: ({ id, body }) => api.patchAssistant(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkAssistants.list() });
    },
  });
}

/** The default cannot be archived while it is the default — promote another
 * one first. The API enforces it; the menu says so before you try. */
export function useArchiveAssistant() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api.archiveAssistant(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkAssistants.list() });
    },
  });
}

/**
 * Get-or-create one assistant's session.
 *
 * Creating an assistant writes only its row, so a new assistant has no
 * session until somebody opens it — and every ordinary session route reads
 * the app row this call creates. Without it a freshly created assistant
 * lists correctly and 404s on the first click.
 *
 * Idempotent, so the chat page calls it on mount for whichever assistant is
 * active, default or not. It does NOT invalidate the assistants list: the
 * list's contents do not change, only the session behind one of its rows.
 */
export function useEnsureAssistantSession() {
  return useMutation<EnsureAssistantSessionResponse, Error, string>({
    mutationFn: (assistantId) => api.ensureAssistantSession(assistantId),
  });
}
