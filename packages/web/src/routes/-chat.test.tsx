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
import { render, screen } from "@testing-library/react";
import type {
  AssistantSummary,
  ListAssistantsResponse,
  ListTeamsResponse,
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
    // Answers at once, so the page's "opened" gate passes and the
    // conversation mounts inside the same render pass the test reads.
    useEnsureAssistantSession: () => ({
      mutate: (id: string, opts?: { onSuccess?: (r: { sessionId: string }) => void }) =>
        opts?.onSuccess?.({ sessionId: `assistant:${id}` }),
    }),
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

vi.mock("~/components/session/session-view", () => ({
  SessionView: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="session-view" data-session={sessionId} />
  ),
}));

vi.mock("~/components/session/child-panel", () => ({
  ChildPanel: () => <div data-testid="child-panel" />,
}));

await import("./chat");

function ChatPage(): ReactElement {
  if (!pageComponent) throw new Error("createFileRoute mock captured no component");
  return pageComponent();
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
});

describe("ChatPage on a team workspace", () => {
  it("keeps an unreachable ?assistant= in the URL and says which assistant opened instead", () => {
    searchParams = { assistant: "asst_nope" };
    render(<ChatPage />);
    expect(screen.getByTestId("session-view").getAttribute("data-session")).toBe(
      "assistant:asst_team",
    );
    expect(screen.getByText(/That assistant is not available\./)).toBeTruthy();
    // A rewrite to the team default would drop the notice one frame later,
    // and the reader would never learn their link went nowhere.
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("rewrites the URL to the team default only when nothing was asked for", () => {
    render(<ChatPage />);
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(navigateSpy.mock.calls[0]?.[0]).toMatchObject({ replace: true });
  });

  it("falls back to your own conversation with a notice when the list cannot load", () => {
    assistantsData = undefined;
    assistantsError = new Error("network");
    render(<ChatPage />);
    // Not a full-page error: the conversation still mounts, and the strip
    // above it names the corrective action, same as the personal path.
    expect(screen.getByTestId("session-view").getAttribute("data-session")).toBe(
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

  it("offers the create action to an org admin who is a plain team member", () => {
    meData = me("admin");
    render(<ChatPage />);
    expect(screen.getByText(/No assistant in Platform yet\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create an assistant" })).toBeTruthy();
    expect(screen.queryByText(/Ask a team admin/)).toBeNull();
  });

  it("tells a plain member to ask a team admin", () => {
    render(<ChatPage />);
    expect(screen.getByText(/Ask a team admin to create one\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create an assistant" })).toBeNull();
  });
});
