import { readAppPageHint } from "@valet/shared";
import { AppPageHintContext } from "~/lib/app-page-hint";
import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { qk } from "~/api/queries";
import { api } from "~/api/client";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { AssistantPanel } from "~/components/session/assistant-panel";
import { prefillComposerDraft, useComposerDraftStore } from "~/stores/composer-drafts";

type Conversation = { sessionId: string; threadId: string };
type Assistant = { open: (prompt?: string) => void; panel: ReactNode; close: () => void; isOpen: boolean };
const Context = createContext<Assistant | null>(null);
export function useWorkspaceAssistant() {
  const context = useContext(Context);
  if (!context) throw new Error("Workspace assistant provider is missing");
  return context;
}

/** Opening Ask Valet runs even while the browser reports offline. A paused
 * mutation never settles, so the panel showed neither an error nor Retry;
 * the request now fails at once and the panel offers Retry. */
export const ENSURE_CONVERSATION_MUTATION = { networkMode: "always" } as const;

/** One durable workspace Thread, reused across app pages. No helper sessions. */
export function WorkspaceAssistantProvider({ children }: { children: ReactNode }) {
  const scope = useWorkspaceScope();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const qc = useQueryClient();
  // A mutation, not a direct call: the UI stress gallery's frozen client
  // refuses every mutation, so the gallery never sends this request.
  const ensureConversation = useMutation({ ...ENSURE_CONVERSATION_MUTATION, mutationFn: (key: string) => api.ensureWorkspaceConversation(key) });
  const conversations = useRef(new Map<string, Promise<Conversation>>());
  const [opened, setOpened] = useState<string>();
  const [loaded, setLoaded] = useState<Record<string, Conversation>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const workspace = scope.key;
  const requestGeneration = useRef(0);
  const activePath = useRef(pathname);
  activePath.current = pathname;
  const activeWorkspace = useRef(workspace);
  activeWorkspace.current = workspace;
  function close() { requestGeneration.current += 1; setOpened(undefined); }
  async function open(prompt?: string) {
    const draftOwner = useComposerDraftStore.getState().owner;
    const generation = ++requestGeneration.current;
    const mayNavigate = () => generation === requestGeneration.current && activeWorkspace.current === workspace && activePath.current === pathname;
    setOpened(workspace);
    setErrors((current) => ({ ...current, [workspace]: "" }));
    const workflowMatch = /^\/workflows\/([^/]+)$/.exec(pathname);
    if (workflowMatch) {
      try {
        const conversation = await api.ensureWorkflowConversation(decodeURIComponent(workflowMatch[1]!));
        const session = await api.getSession(conversation.sessionId);
        const ownerWorkspace = session.owner.type === "team" ? session.owner.id : "user";
        if (mayNavigate()) {
          setOpened(undefined);
          await navigate({ to: "/chat", search: { workspace: ownerWorkspace, thread: conversation.threadId } });
        }
      } catch (error) {
        setErrors((current) => ({ ...current, [workspace]: error instanceof Error ? error.message : "Could not open the workflow Thread." }));
      }
      return;
    }
    let pending = conversations.current.get(workspace);
    if (!pending) {
      pending = (async () => {
        const conversation = await ensureConversation.mutateAsync(workspace);
        await qc.invalidateQueries({ queryKey: qk.threads(conversation.sessionId) });
        return conversation;
      })();
      conversations.current.set(workspace, pending);
    }
    try {
      const conversation = await pending;
      if (prompt && useComposerDraftStore.getState().owner === draftOwner) prefillComposerDraft(conversation.sessionId, conversation.threadId, prompt);
      setLoaded((current) => ({ ...current, [workspace]: conversation }));
    } catch (error) {
      conversations.current.delete(workspace);
      setErrors((current) => ({ ...current, [workspace]: error instanceof Error ? error.message : "Could not open Valet." }));
    }
  }
  const conversation = loaded[workspace];
  const visible = opened === workspace && !/^\/workflows\/[^/]+$/.test(pathname);
  const panel = visible ? <aside aria-label="Valet assistant" data-ask-valet-dock="" className="absolute inset-0 z-40 flex min-h-0 flex-col border-l border-line bg-paper lg:static lg:w-[440px] lg:shrink-0">
      <AppPageHintContext.Provider value={readAppPageHint({ pathname, workspace })}><AssistantPanel title={`Valet · ${scope.teamId ? "Team workspace" : "Personal"}`} sessionId={conversation?.sessionId} threadId={conversation?.threadId} error={errors[workspace]} onRetry={() => void open()} onClose={close} onOpen={() => { if (conversation) { close(); void navigate({ to: "/chat", search: { workspace, thread: conversation.threadId } }); } }} scopeNotice={scope.teamId ? "Only you can see this conversation." : undefined} /></AppPageHintContext.Provider>
    </aside> : null;
  return <Context.Provider value={{ open: (prompt) => { void open(prompt); }, panel, close, isOpen: visible }}>{children}</Context.Provider>;
}

export function WorkspaceAssistantDock() { return useWorkspaceAssistant().panel; }
