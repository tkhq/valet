import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "~/api/client";
import { qkHome } from "~/api/home";
import { prefillComposerDraft } from "~/stores/composer-drafts";

/** Opens Home with `prompt` in the composer as an editable draft. Nothing is
 * sent until the person sends it, and a draft they already typed stays. */
export function useAskValet(): (prompt: string) => Promise<void> {
  const navigate = useNavigate();
  const qc = useQueryClient();
  return async (prompt) => {
    const home = await qc.fetchQuery({ queryKey: qkHome.conversation, queryFn: () => api.ensureHomeConversation(), staleTime: Infinity });
    prefillComposerDraft(home.sessionId, home.threadId, prompt);
    await navigate({ to: "/" });
  };
}
