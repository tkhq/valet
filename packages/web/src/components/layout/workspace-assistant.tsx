import { readAppPageHint } from "@valet/shared";
import type { EnsureWorkspaceConversationRequest } from "@valet/api/wire";
import { AppPageHintContext } from "~/lib/app-page-hint";
import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, History, SquarePen } from "lucide-react";
import { qk } from "~/api/queries";
import { api } from "~/api/client";
import { relativeTime } from "~/lib/relative-time";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { AssistantPanel } from "~/components/session/assistant-panel";
import { prefillComposerDraft, useComposerDraftStore } from "~/stores/composer-drafts";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "~/components/primitives";

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

/** Ask Valet, reused across app pages. Opening the panel from closed starts a
 * new conversation, unless the latest one runs a turn or waits for an approval.
 * A contextual prompt starts a new conversation unless the panel is open. */
export function WorkspaceAssistantProvider({ children }: { children: ReactNode }) {
  const scope = useWorkspaceScope();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const qc = useQueryClient();
  // A mutation, not a direct call: the UI stress gallery's frozen client
  // refuses every mutation, so the gallery never sends this request.
  const ensureConversation = useMutation({ ...ENSURE_CONVERSATION_MUTATION,
    mutationFn: ({ workspace, request }: { workspace: string; request: EnsureWorkspaceConversationRequest }) => api.ensureWorkspaceConversation(workspace, request) });
  // In-flight requests by workspace and body. The latest start in each
  // workspace decides which conversation the panel shows.
  const starting = useRef(new Map<string, Promise<Conversation>>());
  const latestStart = useRef(new Map<string, number>());
  // Two contextual prompts can share one request; only the later one fills the draft.
  const latestPrompt = useRef(new Map<string, number>());
  const lastRequest = useRef<EnsureWorkspaceConversationRequest>({ fresh: true, unlessBusy: true });
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
    const shown = loaded[workspace];
    if (visible && shown) {
      if (prompt) prefillComposerDraft(shown.sessionId, shown.threadId, prompt);
      return;
    }
    // While the panel opens, a plain open keeps the request in flight, so it
    // cannot replace the conversation of a contextual prompt.
    if (visible && !prompt && !errors[workspace]) return;
    await start(prompt ? { fresh: true } : { fresh: true, unlessBusy: true }, prompt);
  }
  async function start(request: EnsureWorkspaceConversationRequest, prompt?: string) {
    const draftOwner = useComposerDraftStore.getState().owner;
    const generation = (latestStart.current.get(workspace) ?? 0) + 1;
    latestStart.current.set(workspace, generation);
    const isLatest = () => latestStart.current.get(workspace) === generation;
    if (prompt) latestPrompt.current.set(workspace, generation);
    const requestKey = `${workspace}\u0000${JSON.stringify(request)}`;
    lastRequest.current = request;
    setOpened(workspace);
    setErrors((current) => ({ ...current, [workspace]: "" }));
    setLoaded(({ [workspace]: _replaced, ...current }) => current);
    let pending = starting.current.get(requestKey);
    if (!pending) {
      pending = (async () => {
        try {
          const conversation = await ensureConversation.mutateAsync({ workspace, request });
          await qc.invalidateQueries({ queryKey: qk.threads(conversation.sessionId) });
          return conversation;
        } finally {
          starting.current.delete(requestKey);
        }
      })();
      starting.current.set(requestKey, pending);
    }
    try {
      const conversation = await pending;
      if (prompt && latestPrompt.current.get(workspace) === generation && useComposerDraftStore.getState().owner === draftOwner) prefillComposerDraft(conversation.sessionId, conversation.threadId, prompt);
      if (isLatest()) setLoaded((current) => ({ ...current, [workspace]: conversation }));
    } catch (error) {
      if (isLatest()) setErrors((current) => ({ ...current, [workspace]: error instanceof Error ? error.message : "Could not open Valet." }));
    }
  }
  const conversation = loaded[workspace];
  const visible = opened === workspace && !/^\/workflows\/[^/]+$/.test(pathname);
  const actions = conversation && <ConversationActions workspace={workspace} current={conversation.threadId} onNew={() => void start({ fresh: true })}
    onSelect={(next) => setLoaded((current) => ({ ...current, [workspace]: next }))} />;
  const panel = visible ? <aside aria-label="Valet assistant" data-ask-valet-dock="" className="absolute inset-0 z-40 flex min-h-0 flex-col border-l border-line bg-paper lg:static lg:w-[440px] lg:shrink-0">
      <AppPageHintContext.Provider value={readAppPageHint({ pathname, workspace })}><AssistantPanel title={`Valet · ${scope.teamId ? "Team workspace" : "Personal"}`} sessionId={conversation?.sessionId} threadId={conversation?.threadId} error={errors[workspace]} actions={actions} onRetry={() => void start(lastRequest.current)} onClose={close} onOpen={() => { if (conversation) { close(); void navigate({ to: "/chat", search: { workspace, thread: conversation.threadId } }); } }} scopeNotice={scope.teamId ? "Only you can see this conversation." : undefined} /></AppPageHintContext.Provider>
    </aside> : null;
  return <Context.Provider value={{ open: (prompt) => { void open(prompt); }, panel, close, isOpen: visible }}>{children}</Context.Provider>;
}

/** New chat, and a menu of the viewer's recent Ask Valet conversations. */
function ConversationActions({ workspace, current, onNew, onSelect }: {
  workspace: string;
  current: string;
  onNew: () => void;
  onSelect: (conversation: Conversation) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const recent = useQuery({ queryKey: qk.workspaceConversations(workspace), queryFn: () => api.listWorkspaceConversations(workspace), enabled: menuOpen });
  const items = recent.data?.conversations ?? [];
  return <>
    <button type="button" aria-label="New chat" title="New chat" className="rounded p-2 hover:bg-ink-wash" onClick={onNew}><SquarePen className="h-4 w-4" /></button>
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Recent conversations" title="Recent conversations" className="rounded p-2 hover:bg-ink-wash"><History className="h-4 w-4" /></button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-xs text-muted">Recent</DropdownMenuLabel>
        {recent.error ? <p role="alert" className="px-2 py-1.5 text-muted">Could not load conversations. Close the menu and open it again.</p>
          : !recent.data ? <p className="px-2 py-1.5 text-muted">Loading…</p>
          : items.length === 0 ? <p className="px-2 py-1.5 text-muted">No conversations yet.</p>
          : items.map(item => <DropdownMenuItem key={item.threadId} aria-current={item.threadId === current ? "true" : undefined}
              onSelect={() => onSelect({ sessionId: item.sessionId, threadId: item.threadId })}>
              <span className="min-w-0 flex-1 truncate">{item.title || "New conversation"}</span>
              {item.threadId === current ? <Check aria-hidden /> : <span className="shrink-0 text-xs text-muted">{relativeTime(item.lastUserActivityAt)}</span>}
            </DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  </>;
}

export function WorkspaceAssistantDock() { return useWorkspaceAssistant().panel; }
