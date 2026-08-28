// @vitest-environment jsdom
/**
 * `/assistants` — the workspace-scoped assistants list (team dashboard
 * design follow-up): scoping by the active workspace, editor links, and
 * the empty state.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AssistantSummary } from "@valet/api/wire";

let assistantsData: AssistantSummary[] = [];
let scopeTeamId: string | undefined;

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("~/api/assistants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/assistants")>();
  return {
    ...actual,
    useAssistants: () => ({ data: { assistants: assistantsData }, error: null, refetch: vi.fn() }),
  };
});
vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useMe: () => ({ data: { id: "u1", orgRole: "member" as const }, error: null, refetch: vi.fn() }),
    useTeams: () => ({ data: { teams: [] }, error: null }),
    // WorkspaceClause reaches useOrg through useActiveWorkspace.
    useOrg: () => ({ data: { features: { organizations: true }, callerRole: "member" as const }, isLoading: false }),
  };
});
vi.mock("~/lib/workspace-scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/workspace-scope")>();
  return {
    ...actual,
    useWorkspaceScope: () => ({
      key: scopeTeamId ?? "user",
      teamId: scopeTeamId,
      available: ["user"],
      setKey: vi.fn(),
    }),
  };
});

const { AssistantsIndexPage, workspaceAssistants } = await import("./assistants.index");

function makeAssistant(overrides: Partial<AssistantSummary> = {}): AssistantSummary {
  return {
    id: "asst_1",
    owner: { type: "user", id: "u1" },
    sessionId: "assistant:asst_1",
    isDefault: false,
    createdAt: 1,
    ...overrides,
  };
}

describe("workspaceAssistants", () => {
  it("scopes to the caller's own for personal, the team's for a team scope", () => {
    const mine = makeAssistant({ id: "a-mine" });
    const theirs = makeAssistant({ id: "a-theirs", owner: { type: "user", id: "u2" } });
    const teams = makeAssistant({ id: "a-team", owner: { type: "team", id: "team_1" } });
    const all = [mine, theirs, teams];
    expect(workspaceAssistants(all, { teamId: undefined }, "u1").map((a) => a.id)).toEqual(["a-mine"]);
    expect(workspaceAssistants(all, { teamId: "team_1" }, "u1").map((a) => a.id)).toEqual(["a-team"]);
  });
});

describe("AssistantsIndexPage", () => {
  it("lists the personal workspace's assistants with editor links and the Default badge", () => {
    scopeTeamId = undefined;
    assistantsData = [
      makeAssistant({ id: "a1", name: "Wren", isDefault: true }),
      makeAssistant({ id: "a2", name: "Deploy Bot", personality: "Terse." }),
      makeAssistant({ id: "a3", owner: { type: "team", id: "team_1" }, name: "Sentinel" }),
    ];
    render(<AssistantsIndexPage />);
    expect(screen.getByText("Wren")).toBeTruthy();
    expect(screen.getByText("Default")).toBeTruthy();
    expect(screen.getByText("Terse.")).toBeTruthy();
    // The team's assistant stays out of the personal workspace list.
    expect(screen.queryByText("Sentinel")).toBeNull();
  });

  it("shows the empty state when the workspace has no assistants", () => {
    scopeTeamId = "team_9";
    assistantsData = [makeAssistant({ id: "a1", name: "Wren" })];
    render(<AssistantsIndexPage />);
    expect(screen.getByText(/No assistants in this workspace yet/)).toBeTruthy();
  });
});
