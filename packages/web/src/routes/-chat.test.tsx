// @vitest-environment jsdom
/**
 * `/chat` on a team workspace: which conversation opens, what the strip
 * above it says, and what the page does when the queries it needs do not
 * answer the way it hoped.
 *
 * The rail's choice logic is covered in `-chat-assistant.test.ts`; these
 * cases are about the page around it — the URL it leaves alone, the notice
 * it shows, and the gates it waits on.
 */
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  AssistantSummary,
  EnsureAssistantSessionResponse,
  GetSessionResponse,
  ListAssistantsResponse,
  ListTeamsResponse,
  ListThreadsResponse,
  MeResponse,
  OrgResponse,
  TeamSummary,
} from "@valet/api/wire";

let searchParams: { assistant?: string; thread?: string; child?: string } = {};
let scopeKey = "user";
let teamsData: ListTeamsResponse | undefined = { teams: [] };
let orgData: OrgResponse | undefined;
let meData: MeResponse | undefined;
let assistantsData: ListAssistantsResponse | undefined = { assistants: [] };
let assistantsError: Error | null = null;
const navigateSpy = vi.fn();
// The page component is not exported; the route factory mock captures it.
let pageComponent: (() => ReactElement) | undefined;

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: { component: () => ReactElement }) => {
    pageComponent = config.component;
    return { ...config, fullPath: "/chat", useSearch: () => searchParams };
  },
  useNavigate: () => navigateSpy,
}));

// The session reads and the ensure go through the client, so the order they
// fire in is observable here: `calls` records each request as it starts and
// the ensure again as it answers.
const calls: string[] = [];
const ensureAssistantSession =
  vi.fn<(assistantId: string) => Promise<EnsureAssistantSessionResponse>>();
const getSession = vi.fn<(id: string) => Promise<GetSessionResponse>>();
const listThreads = vi.fn<(id: string) => Promise<ListThreadsResponse>>();

vi.mock("~/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      ensureAssistantSession: (assistantId: string) => {
        calls.push("ensure");
        return ensureAssistantSession(assistantId).then((r) => {
          calls.push("ensure:done");
          return r;
        });
      },
      getSession: (id: string) => {
        calls.push("getSession");
        return getSession(id);
      },
      listThreads: (id: string) => {
        calls.push("listThreads");
        return listThreads(id);
      },
    },
  };
});

vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useTeams: () => ({ data: teamsData, isLoading: false, error: null }),
    useOrg: () => ({ data: orgData, isLoading: false, error: null }),
    useMe: () => ({ data: meData, isLoading: meData === undefined, error: null }),
  };
});

vi.mock("~/api/assistants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/assistants")>();
  return {
    ...actual,
    useAssistants: () => ({ data: assistantsData, isLoading: false, error: assistantsError }),
    useCreateAssistant: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  };
});

vi.mock("~/api/orchestrator", () => ({
  useOrchestratorInfo: () => ({
    data: { sessionId: "assistant:asst_own", name: "Aurora" },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useEnsureOrchestrator: () => ({
    mutate: (_: undefined, opts?: { onSuccess?: (r: { sessionId: string }) => void }) =>
      opts?.onSuccess?.({ sessionId: "assistant:asst_own" }),
  }),
}));

vi.mock("~/lib/workspace-scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/workspace-scope")>();
  return {
    ...actual,
    useWorkspaceScope: () => ({
      key: scopeKey,
      teamId: scopeKey === "user" ? undefined : scopeKey,
      available: ["user", scopeKey],
      setKey: vi.fn(),
    }),
  };
});

vi.mock("~/hooks/use-invalidate-messages-on-queue-state", () => ({
  useInvalidateMessagesOnQueueState: () => {},
}));

// The real view is a WS, a transcript and a composer. What matters here is
// its contract with the session read: it mounts on `useSession` and renders
// a terminal error when that read fails, which is the screen this page must
// never leave a person on.
vi.mock("~/components/session/session-view", async () => {
  const { useSession, useThreads } = await import("~/api/queries");
  return {
    SessionView: ({ sessionId }: { sessionId: string }) => {
      const session = useSession(sessionId);
      useThreads(sessionId);
      if (session.isLoading) return <div>Loading session…</div>;
      if (session.error || !session.data) return <div>Failed to load session</div>;
      return <div data-testid="session-view" data-session={sessionId} />;
    },
  };
});

vi.mock("~/components/session/child-panel", () => ({
  ChildPanel: () => <div data-testid="child-panel" />,
}));

await import("./chat");
const { useSession, useThreads } = await import("~/api/queries");

function ChatPage(): ReactElement {
  if (!pageComponent) throw new Error("createFileRoute mock captured no component");
  return pageComponent();
}

/** Stands in for the rail's thread tree: a sibling of the page that reads
 * the same session, mounted by the root layout rather than by the page. */
function EarlyReader({ sessionId }: { sessionId: string }): ReactElement {
  useSession(sessionId);
  useThreads(sessionId);
  return <></>;
}

let client = new QueryClient();

function renderPage(extra?: ReactElement) {
  return render(
    <QueryClientProvider client={client}>
      {extra}
      <ChatPage />
    </QueryClientProvider>,
  );
}

function sessionRow(id: string): GetSessionResponse {
  return {
    id,
    title: "Triage",
    workspace: "acme/site",
    status: "active",
    kind: "code",
    runState: "idle",
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    owner: { type: "team", id: "team_1" },
    messageCount: 0,
    profile: "headless",
    docker: false,
  };
}

function team(over: Partial<TeamSummary> = {}): TeamSummary {
  return {
    id: "team_1",
    orgId: "org_1",
    name: "Platform",
    origin: "local",
    externalId: null,
    createdAt: 1,
    memberCount: 3,
    callerRole: "member",
    defaultModel: null,
    ...over,
  };
}

function org(): OrgResponse {
  return {
    id: "org_1",
    name: "Acme",
    createdAt: 0,
    ssoTeamGroups: [],
    allowPublicArtifacts: false,
    plugins: [],
    callerRole: "member",
    features: { organizations: true, ssoTeamSync: false },
  };
}

function me(orgRole: "admin" | "member" = "member"): MeResponse {
  return {
    id: "u1",
    email: "member@example.com",
    name: "Member",
    avatarUrl: null,
    role: "member",
    orgId: "org_1",
    orgRole,
    defaultModel: null,
    defaultReasoning: null,
    newThreadBehavior: "keep_current",
  };
}

function mine(): AssistantSummary {
  return {
    id: "asst_own",
    owner: { type: "user", id: "u1" },
    name: "Aurora",
    sessionId: "assistant:asst_own",
    isDefault: true,
    createdAt: 1,
  };
}

function teamAssistant(): AssistantSummary {
  return {
    id: "asst_team",
    owner: { type: "team", id: "team_1" },
    name: "Triage",
    sessionId: "assistant:asst_team",
    isDefault: true,
    createdAt: 2,
  };
}

beforeEach(() => {
  searchParams = {};
  scopeKey = "team_1";
  teamsData = { teams: [team()] };
  orgData = org();
  meData = me();
  assistantsData = { assistants: [mine(), teamAssistant()] };
  assistantsError = null;
  navigateSpy.mockClear();
  calls.length = 0;
  vi.clearAllMocks();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  ensureAssistantSession.mockImplementation((id) => Promise.resolve({ sessionId: `assistant:${id}` }));
  getSession.mockImplementation((id) => Promise.resolve(sessionRow(id)));
  listThreads.mockResolvedValue({ threads: [] });
});

describe("ChatPage on a team workspace", () => {
  it("keeps an unreachable ?assistant= in the URL and says which assistant opened instead", async () => {
    searchParams = { assistant: "asst_nope" };
    renderPage();
    expect((await screen.findByTestId("session-view")).getAttribute("data-session")).toBe(
      "assistant:asst_team",
    );
    expect(screen.getByText(/That assistant is not available\./)).toBeTruthy();
    // A rewrite to the team default would drop the notice one frame later,
    // and the reader would never learn their link went nowhere.
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("rewrites the URL to the team default only when nothing was asked for", () => {
    renderPage();
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(navigateSpy.mock.calls[0]?.[0]).toMatchObject({ replace: true });
  });

  it("falls back to your own conversation with a notice when the list cannot load", async () => {
    assistantsData = undefined;
    assistantsError = new Error("network");
    renderPage();
    // Not a full-page error: the conversation still mounts, and the strip
    // above it names the corrective action, same as the personal path.
    expect((await screen.findByTestId("session-view")).getAttribute("data-session")).toBe(
      "assistant:asst_own",
    );
    expect(screen.getByRole("status").textContent).toContain("Cannot load your assistants");
    expect(screen.getByRole("status").textContent).toContain("Reload the page.");
  });
});

describe("ChatPage on an empty team", () => {
  beforeEach(() => {
    assistantsData = { assistants: [mine()] };
  });

  it("waits for /api/me before choosing the notice copy", () => {
    // `canAdminister` reads the caller's org role. Deciding before it lands
    // shows an org admin "Ask a team admin" for a beat, with no button.
    meData = undefined;
    renderPage();
    expect(screen.queryByText(/Ask a team admin/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Create an assistant/ })).toBeNull();
    expect(screen.getByText(/Loading/)).toBeTruthy();
  });

  it("offers the create action to an org admin who is a plain team member", () => {
    meData = me("admin");
    renderPage();
    expect(screen.getByText(/No assistant in Platform yet\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create an assistant" })).toBeTruthy();
    expect(screen.queryByText(/Ask a team admin/)).toBeNull();
  });

  it("tells a plain member to ask a team admin", () => {
    renderPage();
    expect(screen.getByText(/Ask a team admin to create one\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create an assistant" })).toBeNull();
  });
});

describe("ChatPage on an assistant whose session does not exist yet", () => {
  // Creating a team seeds its default assistant as a row alone. The list
  // names a session id for it, but no call has created that session, so
  // every read of it 404s until the ensure runs.
  let resolveEnsure: (() => void) | undefined;

  beforeEach(() => {
    searchParams = { assistant: "asst_team" };
    ensureAssistantSession.mockImplementation(
      () =>
        new Promise<EnsureAssistantSessionResponse>((resolve) => {
          resolveEnsure = () => resolve({ sessionId: "assistant:asst_team" });
        }),
    );
  });

  it("reads nothing about the session until the ensure has answered", async () => {
    renderPage();
    await waitFor(() => expect(resolveEnsure).toBeDefined());
    expect(screen.getByText(/Opening/)).toBeTruthy();
    expect(calls).toEqual(["ensure"]);

    await act(async () => {
      resolveEnsure?.();
    });
    expect((await screen.findByTestId("session-view")).getAttribute("data-session")).toBe(
      "assistant:asst_team",
    );
    expect(calls.indexOf("getSession")).toBeGreaterThan(calls.indexOf("ensure:done"));
    expect(calls.indexOf("listThreads")).toBeGreaterThan(calls.indexOf("ensure:done"));
  });

  it("recovers a read another component started before the session existed", async () => {
    // The order seen in the browser: the read goes out first, the ensure
    // answers while it is still out, and the read's 404 lands last. The
    // page must end on the conversation, not on the cached 404.
    const pending: Array<() => void> = [];
    const ready = { ensured: false };
    getSession.mockImplementation((id) =>
      ready.ensured
        ? Promise.resolve(sessionRow(id))
        : new Promise<GetSessionResponse>((_, reject) => {
            pending.push(() => reject(new Error(`GET /sessions/${id} → 404`)));
          }),
    );
    listThreads.mockImplementation(() =>
      ready.ensured
        ? Promise.resolve({ threads: [] })
        : new Promise<ListThreadsResponse>((_, reject) => {
            pending.push(() => reject(new Error("GET threads → 404")));
          }),
    );

    renderPage(<EarlyReader sessionId="assistant:asst_team" />);
    await waitFor(() => expect(resolveEnsure).toBeDefined());
    await waitFor(() => expect(pending).toHaveLength(2));

    await act(async () => {
      ready.ensured = true;
      resolveEnsure?.();
    });
    await act(async () => {
      for (const reject of pending.splice(0)) reject();
    });

    expect((await screen.findByTestId("session-view")).getAttribute("data-session")).toBe(
      "assistant:asst_team",
    );
    expect(screen.queryByText("Failed to load session")).toBeNull();
  });
});
