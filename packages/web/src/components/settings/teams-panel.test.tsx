// @vitest-environment jsdom
/**
 * TeamsPanel role gating: mutation controls (team actions menu, role
 * dropdown, remove, add-member) render only for a team admin or an org
 * admin. The API enforces the same gate (`canMutateTeam`); this suite pins
 * that the UI stops offering controls that would 404.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { OrgDirectoryUserWire } from "@valet/api/wire";

/** Renders a real anchor so `getByRole("link")` and href assertions work
 * without mounting a router. */
function RouterLinkStub({
  to,
  search,
  children,
  className,
}: {
  to: string;
  search?: Record<string, string | undefined>;
  children: ReactNode;
  className?: string;
}) {
  const params = Object.entries(search ?? {}).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  const qs = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
  return (
    <a href={`${to}${qs}`} className={className}>
      {children}
    </a>
  );
}

vi.mock("@tanstack/react-router", () => ({
  Link: RouterLinkStub,
}));

/** Shared across renders so the add-member tests can assert on the call. */
const addMemberMutate = vi.fn();
const patchTeamMutate = vi.fn();
let addMemberError: Error | null = null;
let addMemberPending = false;

let callerRole: "admin" | "member" | null = "member";
let orgRole: "admin" | "member" = "member";
let origin: "local" | "config" | "idp" = "local";
/** The org's team-sync gate. Off is the product default, so it is the default here. */
let ssoTeamSync = false;

const teamsData = () => ({
  teams: [
    {
      id: "team_1",
      orgId: "org_1",
      name: "Platform",
      origin,
      externalId: origin === "idp" ? "/platform" : null,
      createdAt: 1,
      memberCount: 2,
      callerRole,
      defaultModel: teamDefaultModel,
    },
  ],
});
let teamDefaultModel: string | null = null;

// The Assistant link points at the team's DEFAULT assistant, whose id only
// the assistants list carries.
vi.mock("~/api/assistants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/assistants")>();
  return {
    ...actual,
    useAssistants: () => ({
      data: {
        assistants: [
          {
            id: "asst_team_1",
            owner: { type: "team" as const, id: "team_1" },
            sessionId: "assistant:asst_team_1",
            isDefault: true,
            createdAt: 1,
          },
        ],
      },
      isLoading: false,
      error: null,
    }),
  };
});

vi.mock("~/api/settings", () => ({
  useTeams: () => ({ data: teamsData(), isLoading: false, error: null }),
  useMe: () => ({ data: { orgRole }, isLoading: false, error: null }),
  useOrg: () => ({
    data: { features: { organizations: true, ssoTeamSync } },
    isLoading: false,
    error: null,
  }),
  useTeamMembers: () => ({
    data: {
      members: [
        { userId: "u1", role: "admin" },
        { userId: "u2", role: "member" },
      ],
    },
    isLoading: false,
    error: null,
  }),
  useCreateTeam: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteTeam: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useAddTeamMember: () => ({
    mutate: addMemberMutate,
    isPending: addMemberPending,
    error: addMemberError,
  }),
  useRemoveTeamMember: () => ({ mutate: vi.fn(), isPending: false }),
  useSetTeamMemberRole: () => ({ mutate: vi.fn(), isPending: false }),
  usePatchTeam: () => ({ mutate: patchTeamMutate, isPending: false, error: null }),
  // The default-model combobox reads the org catalog through this hook.
  useModels: () => ({
    data: {
      models: [
        {
          id: "anthropic/claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
          providerId: "anthropic",
          providerKind: "anthropic",
          providerName: "Anthropic",
          active: true,
        },
        {
          id: "custom_1/llama-3",
          name: "Llama 3",
          providerId: "custom_1",
          providerKind: "openai_compatible",
          providerName: "My Router",
          active: true,
        },
      ],
    },
    isLoading: false,
    error: null,
  }),
}));

import { TeamsPanel } from "./teams-panel";

const orgMembers: OrgDirectoryUserWire[] = [
  { userId: "u1", name: "One", email: "one@dev", avatarUrl: null },
  { userId: "u2", name: "Two", email: "two@dev", avatarUrl: null },
  { userId: "u3", name: "Three", email: "three@dev", avatarUrl: null },
  { userId: "u4", name: "Four", email: "four@dev", avatarUrl: null },
  // u6 sits BEFORE u5 so the prefix-ranking test proves ordering: "ada" is a
  // mid-string match for Zed Prada and a prefix match for Ada Lovelace.
  { userId: "u6", name: "Zed Prada", email: "zprada@dev", avatarUrl: null },
  { userId: "u5", name: "Ada Lovelace", email: "ada@dev", avatarUrl: null },
];

function openTeam() {
  render(<TeamsPanel orgMembers={orgMembers} />);
  fireEvent.click(screen.getByRole("button", { name: "Expand Platform" }));
}

/**
 * A mirrored team hides its controls only while the sync actually runs. The
 * gate is the org's `ssoTeamSync` feature, so the same row reads two ways.
 */
describe("TeamsPanel — mirrored teams follow the team-sync gate", () => {
  beforeEach(() => {
    callerRole = "admin";
    orgRole = "admin";
    origin = "idp";
  });

  afterEach(() => {
    origin = "local";
    ssoTeamSync = false;
  });

  it("hides the controls while team sync is on", () => {
    ssoTeamSync = true;
    openTeam();
    expect(screen.getByText("Identity provider")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Platform actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add member/ })).toBeNull();
  });

  it("returns the controls, and says why, while team sync is off", () => {
    // Nothing reasserts this team any more, so a hidden control would leave
    // a team nobody can change. The badge and the note are what stop that
    // reading as "this team was never mirrored".
    ssoTeamSync = false;
    openTeam();
    expect(screen.getByText("Identity provider (paused)")).toBeTruthy();
    expect(screen.getByText(/team sync is off/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Platform actions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add member/ })).toBeTruthy();
  });
});

describe("TeamsPanel — team default model (TKAI-255)", () => {
  beforeEach(() => {
    patchTeamMutate.mockClear();
    teamDefaultModel = null;
  });

  it("team admin picks a model → PATCH with the catalog id", () => {
    callerRole = "admin";
    orgRole = "member";
    openTeam();
    const combobox = screen.getByRole("combobox", { name: "Default model" });
    fireEvent.focus(combobox);
    fireEvent.click(screen.getByText("Sonnet 4.5"));
    expect(patchTeamMutate).toHaveBeenCalledWith({
      id: "team_1",
      body: { defaultModel: "anthropic/claude-sonnet-4-5" },
    });
  });

  it("plain member sees the value read-only, no combobox", () => {
    callerRole = "member";
    orgRole = "member";
    teamDefaultModel = "anthropic/claude-sonnet-4-5";
    openTeam();
    expect(screen.queryByRole("combobox", { name: "Default model" })).toBeNull();
    // Curated catalog entry → friendly label, not the raw id.
    expect(screen.getByText("Sonnet 4.5")).toBeTruthy();
    // The hint reaches members too — they are the ones whose sessions the
    // setting shapes, and whose personal default wins.
    expect(screen.getByText(/personal\s+default wins/)).toBeTruthy();
  });

  it("plain member sees the catalog name for a non-curated model, not the raw id", () => {
    callerRole = "member";
    orgRole = "member";
    teamDefaultModel = "custom_1/llama-3";
    openTeam();
    expect(screen.getByText("Llama 3")).toBeTruthy();
    expect(screen.queryByText("custom_1/llama-3")).toBeNull();
  });

  it("plain member with no team override reads 'Organization default'", () => {
    callerRole = "member";
    orgRole = "member";
    openTeam();
    expect(screen.getByText("Organization default")).toBeTruthy();
  });
});

describe("TeamsPanel role gating", () => {
  it("hides mutation controls from a plain team member", () => {
    callerRole = "member";
    orgRole = "member";
    openTeam();
    expect(screen.queryByRole("button", { name: "Platform actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add member/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove One/ })).toBeNull();
  });

  it("shows mutation controls to a team admin", () => {
    callerRole = "admin";
    orgRole = "member";
    openTeam();
    expect(screen.getByRole("button", { name: "Platform actions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add member/ })).toBeTruthy();
  });

  it("shows mutation controls to an org admin who is not on the team", () => {
    callerRole = null;
    orgRole = "admin";
    openTeam();
    expect(screen.getByRole("button", { name: "Platform actions" })).toBeTruthy();
  });
});

/**
 * The add-member control is a popover typeahead (see `AddMemberPicker`).
 * These tests pin its contract: search narrows the list, the highlight is
 * the Enter target and arrow keys move it, the DOM row count is capped, a
 * failed add is reported, and a member already on the team never appears.
 */
describe("TeamsPanel — add-member picker", () => {
  beforeEach(() => {
    callerRole = "admin";
    orgRole = "admin";
    addMemberMutate.mockClear();
    addMemberError = null;
    addMemberPending = false;
  });

  function openPicker() {
    openTeam();
    fireEvent.click(screen.getByRole("button", { name: /Add member/ }));
  }

  it("opens a search input listing only members not on the team", () => {
    openPicker();
    expect(screen.getByRole("combobox", { name: /Search members/ })).toBeTruthy();
    // u1/u2 are on the team already; the addable list is the other three.
    expect(screen.getByRole("option", { name: /Three/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Four/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Ada Lovelace/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /One/ })).toBeNull();
  });

  it("filters by name and by email as the query changes", () => {
    openPicker();
    const input = screen.getByRole("combobox", { name: /Search members/ });
    fireEvent.change(input, { target: { value: "love" } });
    expect(screen.getByRole("option", { name: /Ada Lovelace/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Three/ })).toBeNull();
    fireEvent.change(input, { target: { value: "four@dev" } });
    expect(screen.getByRole("option", { name: /Four/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Ada Lovelace/ })).toBeNull();
  });

  it("says so when nothing matches", () => {
    openPicker();
    fireEvent.change(screen.getByRole("combobox", { name: /Search members/ }), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("No matching members.")).toBeTruthy();
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("adds a member on click", () => {
    openPicker();
    fireEvent.click(screen.getByRole("option", { name: /Ada Lovelace/ }));
    expect(addMemberMutate).toHaveBeenCalledWith({
      teamId: "team_1",
      body: { userId: "u5", role: "member" },
    });
  });

  it("marks the highlighted row as the Enter target", () => {
    openPicker();
    const input = screen.getByRole("combobox", { name: /Search members/ });
    fireEvent.change(input, { target: { value: "@dev" } });
    const options = screen.getAllByRole("option");
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    expect(options[1]?.getAttribute("aria-selected")).toBe("false");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0]?.id);
  });

  it("moves the highlight with arrow keys and adds it on Enter", () => {
    openPicker();
    const input = screen.getByRole("combobox", { name: /Search members/ });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const options = screen.getAllByRole("option");
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[1]?.id);
    fireEvent.keyDown(input, { key: "Enter" });
    // Addable order is u3, u4, …; one ArrowDown lands on u4.
    expect(addMemberMutate).toHaveBeenCalledWith({
      teamId: "team_1",
      body: { userId: "u4", role: "member" },
    });
  });

  it("ranks a prefix match above a mid-string match", () => {
    openPicker();
    fireEvent.change(screen.getByRole("combobox", { name: /Search members/ }), {
      target: { value: "ada" },
    });
    const options = screen.getAllByRole("option");
    // Zed Prada precedes Ada Lovelace in the roster; the prefix match wins.
    expect(options[0]?.textContent).toContain("Ada Lovelace");
    expect(options[1]?.textContent).toContain("Zed Prada");
  });

  it("ignores the Enter that commits an IME composition", () => {
    openPicker();
    fireEvent.keyDown(screen.getByRole("combobox", { name: /Search members/ }), {
      key: "Enter",
      isComposing: true,
    });
    expect(addMemberMutate).not.toHaveBeenCalled();
  });

  it("caps the rendered rows and says how many are hidden", () => {
    const many: OrgDirectoryUserWire[] = Array.from({ length: 60 }, (_, i) => ({
      userId: `x${i}`,
      name: `User ${String(i).padStart(2, "0")}`,
      email: `x${i}@dev`,
      avatarUrl: null,
    }));
    render(<TeamsPanel orgMembers={[...orgMembers.slice(0, 2), ...many]} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand Platform" }));
    fireEvent.click(screen.getByRole("button", { name: /Add member/ }));
    expect(screen.getAllByRole("option")).toHaveLength(50);
    expect(screen.getByText(/10 more matches/)).toBeTruthy();
  });

  it("keeps the trigger mounted but inert when nobody is addable", () => {
    // u1 and u2 are both on the team, so nothing is addable.
    render(<TeamsPanel orgMembers={orgMembers.slice(0, 2)} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand Platform" }));
    const trigger = screen.getByRole("button", { name: /Add member/ });
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(trigger);
    expect(screen.queryByRole("combobox", { name: /Search members/ })).toBeNull();
  });

  it("reports a failed add next to the picker", () => {
    addMemberError = new Error("You are not an admin of this team.");
    openTeam();
    expect(screen.getByText(/Failed to add the member/)).toBeTruthy();
  });

  it("adds the first match on Enter", () => {
    openPicker();
    const input = screen.getByRole("combobox", { name: /Search members/ });
    fireEvent.change(input, { target: { value: "ada" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(addMemberMutate).toHaveBeenCalledWith({
      teamId: "team_1",
      body: { userId: "u5", role: "member" },
    });
  });

  it("does not add on Enter when nothing matches", () => {
    openPicker();
    const input = screen.getByRole("combobox", { name: /Search members/ });
    fireEvent.change(input, { target: { value: "zzz" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(addMemberMutate).not.toHaveBeenCalled();
  });
});

/**
 * The Assistant control is a plain cross-link into `/chat`, which owns the
 * get-or-create. Settings is no longer the door to a team's assistant — it
 * is one entrance among several (the chat rail, the dashboard card, the
 * owner badges), so this row creates nothing and needs no pending or error
 * state of its own.
 */
describe("TeamsPanel — team assistant link", () => {
  beforeEach(() => {
    callerRole = "member";
    orgRole = "member";
  });

  it("shows the Assistant link to a plain member, not just admins", () => {
    render(<TeamsPanel orgMembers={orgMembers} />);
    expect(screen.getByRole("link", { name: /Assistant/ })).toBeTruthy();
  });

  it("points at the team's default assistant on /chat", () => {
    // A team owns several assistants now, so the link names one: the
    // default. The rail is where the others are chosen.
    render(<TeamsPanel orgMembers={orgMembers} />);
    const link = screen.getByRole("link", { name: /Assistant/ });
    expect(link.getAttribute("href")).toBe("/chat?assistant=asst_team_1");
  });
});
