// @vitest-environment jsdom
/**
 * AssistantEditorPage tests: the two pure helpers and the six required render
 * behaviors. Mock harness mirrors `-settings.sections.test.tsx`: vi.mock of
 * @tanstack/react-router plus importOriginal spreads on every api module so
 * vitest.config.ts's isolate:false does not bleed mocks across suites.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type {
  AssistantSummary,
  AssistantBehavior,
  PluginSummary,
  TeamSummary,
} from "@valet/api/wire";
import { integrationOptions, canEditAssistant } from "./assistants.$assistantId";

// ── mocks ─────────────────────────────────────────────────────────────────

const patchMutate = vi.fn();
const archiveMutate = vi.fn();
const navigateMock = vi.fn();
let assistantsData: AssistantSummary[] = [];
let pluginsData: PluginSummary[] = [];
let skillsData: { skills: { name: string; origin: string }[]; nextCursor: null } = {
  skills: [],
  nextCursor: null,
};
let teamsData: TeamSummary[] = [];
let meData: { id: string; orgRole: "admin" | "member" } = {
  id: "u1",
  orgRole: "member",
};

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  useParams: (_opts?: unknown) => ({ assistantId: "asst_1" }),
  useNavigate: () => navigateMock,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock("~/api/assistants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/assistants")>();
  return {
    ...actual,
    useAssistants: () => ({ data: { assistants: assistantsData }, isLoading: false, error: null }),
    usePatchAssistant: () => ({ mutate: patchMutate, isPending: false, error: null }),
    useArchiveAssistant: () => ({ mutate: archiveMutate, isPending: false, error: null }),
  };
});

vi.mock("~/api/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/integrations")>();
  return {
    ...actual,
    usePlugins: () => ({ data: { plugins: pluginsData }, isLoading: false, error: null }),
  };
});

vi.mock("~/api/skills", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/skills")>();
  return {
    ...actual,
    useSkills: () => ({ data: skillsData, isLoading: false, error: null }),
  };
});

vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useMe: () => ({ data: meData, isLoading: false, error: null }),
    useTeams: () => ({ data: { teams: teamsData }, isLoading: false, error: null }),
  };
});

// ── fixtures ──────────────────────────────────────────────────────────────

function makeAssistant(overrides: Partial<AssistantSummary> = {}): AssistantSummary {
  return {
    id: "asst_1",
    owner: { type: "user", id: "u1" },
    sessionId: "assistant:asst_1",
    isDefault: true,
    createdAt: 1000,
    ...overrides,
  };
}

function makeTeam(overrides: Partial<TeamSummary> = {}): TeamSummary {
  return {
    id: "team_1",
    orgId: "org_1",
    name: "Engineering",
    origin: "local",
    externalId: null,
    createdAt: 1000,
    memberCount: 3,
    callerRole: "member",
    ...overrides,
  };
}

function makePlugin(
  name: string,
  service: string,
  actions: { id: string; name: string }[] = [],
  displayName?: string,
): PluginSummary {
  return {
    name,
    version: "1.0.0",
    displayName,
    actionCount: actions.length,
    services: [],
    actionServices: actions.length > 0
      ? [
          {
            service,
            actions: actions.map((a) => ({
              ...a,
              riskLevel: "low" as const,
              requiresApproval: false,
            })),
          },
        ]
      : [],
  };
}

// ── import the component ──────────────────────────────────────────────────

// Imported after mocks so vi.mock hoisting applies.
const { AssistantEditorPage } = await import("./assistants.$assistantId");

// ── pure helper tests ─────────────────────────────────────────────────────

describe("integrationOptions()", () => {
  it("returns empty array when plugins is undefined", () => {
    expect(integrationOptions(undefined)).toEqual([]);
  });

  it("flattens actionServices into one row per routing service, labelled by displayName ?? name", () => {
    const plugins: PluginSummary[] = [
      makePlugin("github", "github", [{ id: "github.create_issue", name: "Create issue" }], "GitHub"),
      makePlugin("bare-plugin", "bare", [{ id: "bare.ping", name: "Ping" }]),
    ];
    const opts = integrationOptions(plugins);
    expect(opts).toHaveLength(2);
    expect(opts[0]).toEqual({
      service: "github",
      label: "GitHub",          // displayName wins
      actions: [{ id: "github.create_issue", name: "Create issue" }],
    });
    expect(opts[1]).toEqual({
      service: "bare",
      label: "bare-plugin",    // falls back to name
      actions: [{ id: "bare.ping", name: "Ping" }],
    });
  });

  it("includes dynamic services with no static actions", () => {
    const plugins: PluginSummary[] = [
      {
        name: "mcp-plugin",
        version: "1.0.0",
        actionCount: 0,
        services: [],
        actionServices: [{ service: "mcp", dynamic: true, actions: [] }],
      },
    ];
    const opts = integrationOptions(plugins);
    expect(opts).toHaveLength(1);
    expect(opts[0]?.service).toBe("mcp");
  });

  it("excludes services with no actions and no dynamic flag", () => {
    const plugins: PluginSummary[] = [
      {
        name: "empty-plugin",
        version: "1.0.0",
        actionCount: 0,
        services: [],
        actionServices: [{ service: "empty", actions: [] }],
      },
    ];
    expect(integrationOptions(plugins)).toHaveLength(0);
  });
});

describe("canEditAssistant()", () => {
  it("user-owned assistant → always true", () => {
    const assistant = makeAssistant({ owner: { type: "user", id: "u1" } });
    expect(canEditAssistant(assistant, [], { id: "u1", orgRole: "member" })).toBe(true);
  });

  it("team assistant + callerRole member + orgRole member → false", () => {
    const assistant = makeAssistant({ owner: { type: "team", id: "team_1" } });
    const teams = [makeTeam({ id: "team_1", callerRole: "member" })];
    expect(canEditAssistant(assistant, teams, { id: "u1", orgRole: "member" })).toBe(false);
  });

  it("team assistant + callerRole admin → true", () => {
    const assistant = makeAssistant({ owner: { type: "team", id: "team_1" } });
    const teams = [makeTeam({ id: "team_1", callerRole: "admin" })];
    expect(canEditAssistant(assistant, teams, { id: "u1", orgRole: "member" })).toBe(true);
  });

  it("team assistant + orgRole admin → true regardless of callerRole", () => {
    const assistant = makeAssistant({ owner: { type: "team", id: "team_1" } });
    const teams = [makeTeam({ id: "team_1", callerRole: "member" })];
    expect(canEditAssistant(assistant, teams, { id: "u1", orgRole: "admin" })).toBe(true);
  });
});

// ── render tests ──────────────────────────────────────────────────────────

describe("AssistantEditorPage", () => {
  beforeEach(() => {
    patchMutate.mockClear();
    archiveMutate.mockClear();
    navigateMock.mockClear();
    assistantsData = [];
    pluginsData = [];
    skillsData = { skills: [], nextCursor: null };
    teamsData = [];
    meData = { id: "u1", orgRole: "member" };
  });

  it("renders 'assistant does not exist' message when id not found", () => {
    assistantsData = [];
    render(<AssistantEditorPage />);
    expect(screen.getByText(/does not exist or you cannot view it/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /open \/chat/i })).toBeTruthy();
  });

  it("team assistant ownership clause names the team", () => {
    teamsData = [makeTeam({ id: "team_1", name: "Engineering" })];
    assistantsData = [
      makeAssistant({ id: "asst_1", owner: { type: "team", id: "team_1" } }),
    ];
    meData = { id: "u1", orgRole: "admin" };
    render(<AssistantEditorPage />);
    expect(
      screen.getByText(/This assistant belongs to Engineering\. Everyone on the team can use it\./),
    ).toBeTruthy();
  });

  it("member viewing a team assistant sees inputs disabled and the read-only note", () => {
    meData = { id: "u1", orgRole: "member" };
    teamsData = [makeTeam({ id: "team_1", callerRole: "member" })];
    assistantsData = [
      makeAssistant({ id: "asst_1", owner: { type: "team", id: "team_1" }, name: "Eng Bot" }),
    ];
    render(<AssistantEditorPage />);

    // The read-only note must appear.
    expect(screen.getByText("Only team admins can edit this assistant.")).toBeTruthy();

    // The name input is disabled.
    const nameInput = screen.getByLabelText("Name") as HTMLInputElement;
    expect(nameInput.disabled).toBe(true);
  });

  it("saving identity fires usePatchAssistant mutate with { id, body: { name, personality } }", async () => {
    assistantsData = [
      makeAssistant({ id: "asst_1", name: "Old Name", personality: "Helpful." }),
    ];
    meData = { id: "u1", orgRole: "member" };
    render(<AssistantEditorPage />);

    const nameInput = screen.getByLabelText("Name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "New Name" } });

    const identitySaveBtn = screen.getByRole("button", { name: "Save identity" });
    fireEvent.click(identitySaveBtn);

    await waitFor(() =>
      expect(patchMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "asst_1",
          body: expect.objectContaining({ name: "New Name" }),
        }),
        expect.anything(),
      ),
    );
  });

  it("choosing allowlist mode and selecting a skill fires mutate with behavior.skills allowlist", async () => {
    assistantsData = [makeAssistant({ id: "asst_1", name: "Bot" })];
    skillsData = {
      skills: [
        { name: "code-review", origin: "plugin" },
        { name: "ste-writing", origin: "local" },
      ],
      nextCursor: null,
    };
    meData = { id: "u1", orgRole: "member" };
    render(<AssistantEditorPage />);

    // Switch to allowlist mode.
    const allowlistRadio = screen.getByRole("radio", { name: "Only these skills" });
    fireEvent.click(allowlistRadio);

    // Check one skill.
    const checkbox = screen.getByRole("checkbox", { name: "code-review" });
    fireEvent.click(checkbox);

    // Save.
    const skillsSaveBtn = screen.getByRole("button", { name: "Save skills" });
    fireEvent.click(skillsSaveBtn);

    await waitFor(() =>
      expect(patchMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "asst_1",
          body: expect.objectContaining({
            behavior: expect.objectContaining({
              skills: { mode: "allowlist", names: ["code-review"] },
            }),
          }),
        }),
        expect.anything(),
      ),
    );
  });

  it("an allowlisted skill name missing from the catalog renders a 'not found' chip", () => {
    const behavior: AssistantBehavior = {
      skills: { mode: "allowlist", names: ["ghost-skill"] },
    };
    assistantsData = [makeAssistant({ id: "asst_1", name: "Bot", behavior })];
    skillsData = { skills: [], nextCursor: null }; // ghost-skill not in catalog
    meData = { id: "u1", orgRole: "member" };
    render(<AssistantEditorPage />);

    expect(screen.getByText(/ghost-skill/)).toBeTruthy();
    expect(screen.getByText(/not found/i)).toBeTruthy();
  });
});
