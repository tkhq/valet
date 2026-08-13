// @vitest-environment jsdom
/**
 * Sandbox hibernation plan, Task 5: the pause control + sleeping badge.
 * `SandboxChip` gains a `suspended` entry (dot + "sleeping — will wake on
 * message" tooltip label), and the header grows a pause button that posts
 * `usePauseSession`, is disabled unless `sandbox.state === "ready"`, and
 * surfaces the mutation's error text verbatim on failure (e.g. the 409
 * "a turn is running" / "sandbox is not ready to pause" bodies).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "~/components/primitives";
import type { ListAssistantsResponse, ListTeamsResponse, SessionDetail } from "@valet/api/wire";

const deleteMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const setModelMutate = vi.fn();
let pauseMutateAsync = vi.fn().mockResolvedValue({ status: "hibernated" });
let pauseIsPending = false;
/** The header resolves a team assistant's title and its admin controls from
 * these two lists: the assistant says who owns the session, the team says
 * what that owner is called and what the caller may do. Both empty by
 * default so the pause/delete cases below keep exercising a plain personal
 * session. */
let teamsData: ListTeamsResponse = { teams: [] };
let assistantsData: ListAssistantsResponse = { assistants: [] };

// importOriginal, not a bare replacement: vitest.config.ts sets
// `isolate: false` to share the module registry across test files in a
// worker (perf — avoids re-importing React/Radix/xyflow per file). Under
// that setting an incomplete `vi.mock("~/api/queries", ...)` in ANY file
// can end up governing the module for OTHER files sharing the worker —
// spreading the real module keeps every export present no matter whose
// factory the shared registry ends up using.
vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useDeleteSession: () => ({ isPending: false, mutateAsync: deleteMutateAsync }),
    useSetSessionModel: () => ({ isPending: false, mutate: setModelMutate }),
    usePauseSession: () => ({ isPending: pauseIsPending, mutateAsync: pauseMutateAsync }),
  };
});

vi.mock("~/api/settings", () => ({
  useModels: () => ({ data: { models: [] }, isLoading: false, error: null }),
  useMe: () => ({ data: undefined, isLoading: false, error: null }),
  useOrg: () => ({ data: undefined, isLoading: false, error: null }),
  useTeams: () => ({ data: teamsData, isLoading: false, error: null }),
}));

vi.mock("~/api/orchestrator", () => ({
  useOrchestratorInfo: () => ({ data: undefined, isLoading: false, error: null }),
}));

vi.mock("~/api/assistants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/assistants")>();
  return {
    ...actual,
    useAssistants: () => ({ data: assistantsData, isLoading: false, error: null }),
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

import { SessionHeader, SandboxChip } from "./session-header";

function baseSession(): SessionDetail {
  return {
    id: "sess-1",
    workspace: "acme/repo",
    status: "active",
    runState: "idle",
    title: "Fix the bug",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastActivityAt: Date.now(),
    messageCount: 3,
    profile: "headless",
  };
}

function renderHeader(sandbox?: { state: string; epoch: number }) {
  return render(
    <TooltipProvider>
      <SessionHeader session={baseSession()} agentStatus="idle" conn="open" sandbox={sandbox} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  deleteMutateAsync.mockClear();
  setModelMutate.mockClear();
  pauseMutateAsync = vi.fn().mockResolvedValue({ status: "hibernated" });
  pauseIsPending = false;
  teamsData = { teams: [] };
  assistantsData = { assistants: [] };
});

describe("SandboxChip — suspended state", () => {
  it("renders the sleeping label for a suspended sandbox", () => {
    render(
      <TooltipProvider>
        <SandboxChip sandbox={{ state: "suspended", epoch: 1 }} />
      </TooltipProvider>,
    );
    expect(screen.getByLabelText("sleeping — will wake on message")).toBeTruthy();
  });
});

describe("SessionHeader — pause control", () => {
  it("disables the pause button while the sandbox is not ready", () => {
    renderHeader({ state: "provisioning", epoch: 1 });
    const button = screen.getByRole("button", { name: /pause/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("enables the pause button once the sandbox is ready and posts on click", async () => {
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    const button = screen.getByRole("button", { name: /pause/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    await user.click(button);
    expect(pauseMutateAsync).toHaveBeenCalledTimes(1);
  });

  it("surfaces the mutation's error text verbatim on a 409", async () => {
    pauseMutateAsync = vi.fn().mockRejectedValue(new Error("a turn is running"));
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    await user.click(screen.getByRole("button", { name: /pause/i }));

    await waitFor(() => {
      expect(screen.getByText("a turn is running")).toBeTruthy();
    });
  });
});

/**
 * A team's assistant is a shared session. Two things must hold that did not
 * before: it is titled with its own name, or failing that the TEAM's (the
 * header used to fall through to `useOrchestratorInfo`, i.e. the VIEWER's
 * own assistant name, for any id starting `orchestrator:`), and its
 * lifecycle controls are team-admin only — the API enforces the same rule,
 * so showing them to a plain member would only offer a 404.
 *
 * Ownership comes from the assistants list, not from parsing the session id.
 * The id used to carry the owning principal, which addressed exactly one
 * assistant per team and could not survive the second one.
 */
describe("SessionHeader — team assistant", () => {
  function teamSession(): SessionDetail {
    return { ...baseSession(), id: "assistant:asst_team", title: "Assistant" };
  }

  function renderTeamHeader() {
    return render(
      <TooltipProvider>
        <SessionHeader session={teamSession()} agentStatus="idle" conn="open" />
      </TooltipProvider>,
    );
  }

  function withTeam(callerRole: "admin" | "member" | null, assistantName?: string) {
    teamsData = {
      teams: [
        {
          id: "team_1",
          orgId: "org_1",
          name: "Platform",
          createdAt: 1,
          memberCount: 3,
          callerRole,
        },
      ],
    };
    assistantsData = {
      assistants: [
        {
          id: "asst_team",
          owner: { type: "team", id: "team_1" },
          ...(assistantName === undefined ? {} : { name: assistantName }),
          sessionId: "assistant:asst_team",
          isDefault: true,
          createdAt: 1,
        },
      ],
    };
  }

  it("titles an unnamed team assistant with the team's name, not the viewer's own", () => {
    withTeam("member");
    renderTeamHeader();
    expect(screen.getByText("Platform")).toBeTruthy();
    expect(screen.queryByText("Assistant")).toBeNull();
  });

  it("titles a named team assistant with its own name", () => {
    // A team owns several, so the team's name no longer identifies which
    // conversation you are reading.
    withTeam("member", "Triage");
    renderTeamHeader();
    expect(screen.getByText("Triage")).toBeTruthy();
  });

  it("marks it as shared with a Team badge", () => {
    withTeam("member");
    renderTeamHeader();
    expect(screen.getByText("Team")).toBeTruthy();
  });

  /**
   * The workspace chip is a real filesystem path on a real session, but an
   * assistant's is synthetic — `~/.valet/orchestrator/{type}-{id}` — and
   * on a team it rendered as `team-team_99235d43-…`, the principal type
   * joined to an id that already carries it. An internal identifier, shown
   * to a user, for no reason. These two cases pin that it stays hidden.
   */
  it("does not show the internal workspace path on a team assistant", () => {
    withTeam("member");
    render(
      <TooltipProvider>
        <SessionHeader
          session={{ ...teamSession(), workspace: "/root/.valet/orchestrator/team-team_1" }}
          agentStatus="idle"
          conn="open"
        />
      </TooltipProvider>,
    );
    expect(screen.queryByText(/team-team_1/)).toBeNull();
    expect(screen.queryByText(/orchestrator/)).toBeNull();
  });

  it("still shows the workspace on an ordinary session, where it names a real place", () => {
    withTeam("member");
    render(
      <TooltipProvider>
        <SessionHeader session={baseSession()} agentStatus="idle" conn="open" />
      </TooltipProvider>,
    );
    expect(screen.getByText("repo")).toBeTruthy();
  });

  it("hides pause and delete from a plain team member", () => {
    withTeam("member");
    renderTeamHeader();
    expect(screen.queryByRole("button", { name: /pause/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
  });

  it("shows pause and delete to a team admin", () => {
    withTeam("admin");
    renderTeamHeader();
    expect(screen.getByRole("button", { name: /pause/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /delete/i })).toBeTruthy();
  });

  it("keeps the controls on a personal session", () => {
    renderHeader({ state: "ready", epoch: 1 });
    expect(screen.getByRole("button", { name: /pause/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /delete/i })).toBeTruthy();
  });
});
