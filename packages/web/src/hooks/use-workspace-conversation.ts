import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { api } from "~/api/client";
import { useWorkspaceScope } from "~/lib/workspace-scope";

/** Resolve the runtime by workspace ownership. The server authorizes the owner. */
export function useOwnerConversation(workspace: string | undefined) {
  return useQuery({
    queryKey: ["workspace-conversation", workspace],
    enabled: workspace !== undefined,
    queryFn: async () => {
      if (workspace === undefined) throw new Error("Choose a workspace to open its threads.");
      const runtime = await api.ensureWorkspaceRuntime(workspace);
      if (workspace !== "user" && !runtime.workspaceSessionId) {
        throw new Error("The team chat API needs an update. Retry after the deployment finishes.");
      }
      // The CLI target is a private helper. The chat rail addresses the workspace
      // root to list sibling conversations and create explicitly shared threads.
      return { sessionId: runtime.workspaceSessionId ?? runtime.sessionId };
    },
    staleTime: Infinity,
    retry: false,
  });
}

/** The workspace the page shows: the `workspace` search value, else the switcher's scope. */
export function useCurrentWorkspace(): string | undefined {
  const scope = useWorkspaceScope();
  const search = useSearch({ strict: false });
  return search && "workspace" in search && typeof search.workspace === "string"
    ? search.workspace : scope.key;
}

/** Share the same owner-addressed ensure between the thread rail and page. */
export function useWorkspaceConversation() {
  return useOwnerConversation(useCurrentWorkspace());
}
