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
import type { OwnerFilter } from "./client";
import { api } from "./client";
import { useOrchestratorInfo } from "./orchestrator";
import { qk } from "./queries";

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

/**
 * The display name of the assistant that owns a workspace's memory and
 * threads, for hint copy like "Talk to {name}". A team scope names the team's
 * default assistant; personal scope keeps the caller's own assistant name
 * (from orchestrator info, which answers before the assistants list on a cold
 * load). Falls back to a generic phrase so the copy is never blank or wrong.
 */
export function useScopedAssistantName(owner?: OwnerFilter): string {
  const info = useOrchestratorInfo();
  const isTeam = owner?.ownerType === "team";
  // Only a team scope needs the list; personal reads from `info`.
  const assistantsQ = useAssistants({ enabled: isTeam });
  if (isTeam) {
    const teamAssistant = defaultAssistantFor(assistantsQ.data?.assistants, "team", owner.ownerId);
    const named = teamAssistant?.name?.trim();
    return named && named.length > 0 ? named : "the team's assistant";
  }
  return info.data?.name ?? "your assistant";
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

/** Rename, promote to default, or rewrite persona/behavior. `isDefault:
 * true` demotes the previous default in the same write, so no separate
 * demote call exists. */
export function usePatchAssistant() {
  const qc = useQueryClient();
  return useMutation<PatchAssistantResponse, Error, { id: string; body: PatchAssistantRequest }>({
    mutationFn: ({ id, body }) => api.patchAssistant(id, body),
    onSuccess: (updated) => {
      // Write the response into the cache SYNCHRONOUSLY, before the refetch:
      // the editor's section saves build each PATCH body from the cached
      // row's `behavior`, so a save issued right after another must read the
      // first save's result, not the pre-save fetch — or it silently reverts
      // it. The invalidate still runs as the authoritative re-read.
      qc.setQueryData<ListAssistantsResponse>(qkAssistants.list(), (prev) =>
        prev === undefined
          ? prev
          : {
              assistants: prev.assistants.map((a) => {
                if (a.id === updated.id) return updated;
                // A promote demotes the owner's previous default server-side;
                // mirror it, or defaultAssistantFor keeps resolving the OLD
                // default (it sorts first) until the refetch lands.
                if (
                  updated.isDefault &&
                  a.isDefault &&
                  a.owner.type === updated.owner.type &&
                  a.owner.id === updated.owner.id
                ) {
                  return { ...a, isDefault: false };
                }
                return a;
              }),
            },
      );
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
  const qc = useQueryClient();
  return useMutation<EnsureAssistantSessionResponse, Error, string>({
    mutationFn: (assistantId) => api.ensureAssistantSession(assistantId),
    onSuccess: ({ sessionId }) => {
      // The session query almost certainly ran first and 404'd: the chat page
      // knows the session id from the assistants list and mounts on it while
      // this call is still in flight. On a first-ever load nothing has
      // created the row yet, so that read fails and the page shows "Failed
      // to load session" — the one screen a brand-new install opens on.
      // Invalidating here makes the read retry the moment the row exists.
      qc.invalidateQueries({ queryKey: qk.session(sessionId) });
    },
  });
}
