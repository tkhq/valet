/**
 * Which workspace you are working in — your own, or one of your teams.
 *
 * This used to be derived from the open assistant alone, which is correct on
 * `/chat` and useless everywhere else: `/skills`, `/workflows` and `/events`
 * have no assistant in the URL, so the switcher always read "Personal" there
 * and every one of those pages was implicitly personal. The gap showed up as
 * a second Owner dropdown inside each create form, asking again what the
 * switcher in the nav already claimed to answer.
 *
 * So the scope is held here and persisted, and the surfaces read it.
 *
 * The open assistant still WINS when there is one. That keeps the property
 * the derived version had and which a plain persisted value would lose: the
 * control cannot disagree with what is on screen. Following a notification
 * into a team conversation moves the scope on arrival, rather than leaving
 * the nav insisting you are somewhere else.
 *
 * A stored key naming a team you have left resolves back to your own
 * workspace. The alternative is a scope pointing at a workspace whose every
 * list answers 404.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useSearch } from "@tanstack/react-router";
import type { AssistantSummary } from "@valet/api/wire";
import { useAssistants } from "~/api/assistants";
import { useOrg, useTeams } from "~/api/settings";
import { eligibleTeams } from "~/components/session/assistant-rail";

const STORAGE_KEY = "valet:workspace";

/** Your own workspace. Not a team id, and never a user id — the key is a
 * routing value, not a principal. `useWorkspaceScope().teamId` is what
 * addresses a resource. */
export const PERSONAL = "user";

function loadStored(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? PERSONAL;
  } catch {
    return PERSONAL;
  }
}

export interface WorkspaceScope {
  /** `"user"` for your own workspace, else a team id. */
  key: string;
  /**
   * The team id when scoped to a team, `undefined` when personal.
   *
   * This is the shape the create routes already take (`teamId?: string`,
   * absent meaning you), so a form passes it straight through instead of
   * asking the user a question the nav has answered.
   */
  teamId: string | undefined;
  /** The keys the caller may actually switch to, own workspace first. */
  available: string[];
  setKey(next: string): void;
}

const WorkspaceScopeContext = createContext<WorkspaceScope | null>(null);

/**
 * The workspace the open assistant belongs to, or `undefined` when no
 * assistant is open — which is every route except `/chat`.
 */
export function workspaceOfAssistant(active: AssistantSummary | undefined): string | undefined {
  if (!active) return undefined;
  return active.owner.type === "team" ? active.owner.id : PERSONAL;
}

export function WorkspaceScopeProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState<string>(() => loadStored());

  const setKey = useCallback((next: string) => {
    setStored(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Non-persistent environments still get the in-session behaviour.
    }
  }, []);

  // `strict: false` because this provider sits above the route tree and must
  // read the same search param from any route, including those that declare
  // none.
  const search = (useSearch({ strict: false }) ?? {}) as { assistant?: string };
  const assistantsQ = useAssistants();
  const teamsQ = useTeams();
  const orgQ = useOrg();

  const teams = eligibleTeams(teamsQ.data?.teams, orgQ.data?.features.organizations);
  const available = useMemo(() => [PERSONAL, ...teams.map((t) => t.id)], [teams]);

  const open = (assistantsQ.data?.assistants ?? []).find((a) => a.id === search.assistant);
  const derived = workspaceOfAssistant(open);

  // Resolve before the effect runs, not after: a scope that is briefly wrong
  // would let a list fire one request against the previous workspace.
  //
  // Only fall back once the teams query has ANSWERED. While it is loading,
  // `available` holds your own workspace alone, and treating that as proof
  // the team is gone would drop a team scope on every page load.
  const teamsKnown = teamsQ.data !== undefined || orgQ.data !== undefined;
  const settled = teamsKnown && !available.includes(stored) ? PERSONAL : stored;
  const key = derived ?? settled;

  // Persist what the open assistant decided, so leaving `/chat` keeps the
  // workspace you were last actually in.
  useEffect(() => {
    if (key !== stored) setKey(key);
  }, [key, stored, setKey]);

  const value = useMemo<WorkspaceScope>(
    () => ({
      key,
      teamId: key === PERSONAL ? undefined : key,
      available,
      setKey,
    }),
    [key, available, setKey],
  );

  return <WorkspaceScopeContext.Provider value={value}>{children}</WorkspaceScopeContext.Provider>;
}

/**
 * The active workspace, falling back to your own outside the provider.
 *
 * The fallback is safe in the direction that matters. Personal scope can
 * only ever UNDER-scope — it shows your own rows, and a missed team scope
 * reads as an empty list, which is visible. It cannot over-scope, because
 * no default names a team, so no component can be tricked into rendering
 * one workspace's data under another workspace's name.
 *
 * An earlier version threw here. That is stricter than the risk warrants and
 * pushes a router and a query client into every unit test of every component
 * that happens to read the scope, for a failure mode the default cannot
 * produce.
 */
const PERSONAL_SCOPE: WorkspaceScope = {
  key: PERSONAL,
  teamId: undefined,
  available: [PERSONAL],
  setKey: () => {},
};

export function useWorkspaceScope(): WorkspaceScope {
  return useContext(WorkspaceScopeContext) ?? PERSONAL_SCOPE;
}
