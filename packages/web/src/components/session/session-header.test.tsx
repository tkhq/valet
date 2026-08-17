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
let replaceMutateAsync = vi.fn().mockResolvedValue({ ok: true });
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
    useReplaceSandbox: () => ({ isPending: false, mutateAsync: replaceMutateAsync }),
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
    owner: { type: "user", id: "u1" },
    title: "Fix the bug",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastActivityAt: Date.now(),
    messageCount: 3,
    profile: "headless",
    docker: false,
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
  replaceMutateAsync = vi.fn().mockResolvedValue({ ok: true });
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

describe("SessionHeader — overflow menu", () => {
  it("has no direct trash button; the ⋯ menu holds Replace sandbox and Delete session", async () => {
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    expect(screen.queryByRole("button", { name: "Delete session" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Session menu" }));
    expect(screen.getByRole("menuitem", { name: /replace sandbox/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /delete session/i })).toBeTruthy();
  });

  it("Replace sandbox posts the replace mutation without any confirm", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    await user.click(screen.getByRole("button", { name: "Session menu" }));
    await user.click(screen.getByRole("menuitem", { name: /replace sandbox/i }));

    expect(replaceMutateAsync).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("surfaces the replace mutation's 409 error text verbatim", async () => {
    replaceMutateAsync = vi.fn().mockRejectedValue(new Error("a turn is running. Wait for it to finish, then retry."));
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    await user.click(screen.getByRole("button", { name: "Session menu" }));
    await user.click(screen.getByRole("menuitem", { name: /replace sandbox/i }));

    await waitFor(() => {
      expect(screen.getByText(/a turn is running/i)).toBeTruthy();
    });
  });

  it("Delete session confirms with copy naming threads, history, and child sessions", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    await user.click(screen.getByRole("button", { name: "Session menu" }));
    await user.click(screen.getByRole("menuitem", { name: /delete session/i }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const message = String(confirmSpy.mock.calls[0]?.[0] ?? "");
    expect(message).toMatch(/threads/i);
    expect(message).toMatch(/child sessions/i);
    expect(deleteMutateAsync).toHaveBeenCalledWith("sess-1");
    confirmSpy.mockRestore();
  });

  it("a declined confirm does not delete", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    renderHeader({ state: "ready", epoch: 1 });

    await user.click(screen.getByRole("button", { name: "Session menu" }));
    await user.click(screen.getByRole("menuitem", { name: /delete session/i }));

    expect(deleteMutateAsync).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
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
          origin: "local",
          externalId: null,
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

  it("titles an unnamed team assistant the way the rail does, not with the viewer's own name", () => {
    withTeam("member");
    renderTeamHeader();
    // The same `assistantLabel` the rail uses. It used to fall back to the
    // TEAM's name here, so one assistant was called "Default assistant" in
    // the rail and "Platform" in the header — two names for one thing.
    expect(screen.getByText("Default assistant")).toBeTruthy();
    // The guarantee this test has always been about: never the viewer's own
    // assistant name.
    expect(screen.queryByText("Assistant")).toBeNull();
    // The team is still named, on the badge, so dropping it from the title
    // costs no information.
    expect(screen.getByText("Platform")).toBeTruthy();
  });

  it("titles a named team assistant with its own name", () => {
    // A team owns several, so the team's name no longer identifies which
    // conversation you are reading.
    withTeam("member", "Triage");
    renderTeamHeader();
    expect(screen.getByText("Triage")).toBeTruthy();
  });

  it("marks it as shared with a badge naming the owning team", () => {
    withTeam("member");
    renderTeamHeader();
    // Queried as the BADGE, not as text anywhere in the header. Asserting the
    // text alone would be satisfied by any element carrying it, so the test
    // would stop being about the badge the moment something else rendered the
    // team's name — which is exactly what the title used to do.
    //
    // The team's own name, not the bare word "Team": a person on several
    // teams cannot tell them apart from a generic label.
    expect(screen.getByTestId("owning-team").textContent).toBe("Platform");
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

  // Delete lives behind the ⋯ menu, so the menu trigger is what a
  // non-admin must not see. Asserting on the trigger, not on a Delete
  // button, keeps this pinned to the control that actually gates the action.
  it("hides pause and the session menu from a plain team member", () => {
    withTeam("member");
    renderTeamHeader();
    expect(screen.queryByRole("button", { name: /pause/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Session menu" })).toBeNull();
  });

  it("shows pause and the session menu to a team admin", () => {
    withTeam("admin");
    renderTeamHeader();
    expect(screen.getByRole("button", { name: /pause/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Session menu" })).toBeTruthy();
  });

  it("keeps the controls on a personal session", () => {
    renderHeader({ state: "ready", epoch: 1 });
    expect(screen.getByRole("button", { name: /pause/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Session menu" })).toBeTruthy();
  });
});
