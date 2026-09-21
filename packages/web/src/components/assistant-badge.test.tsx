// @vitest-environment jsdom
/**
 * AssistantBadge: the pill on a row whose work an assistant owns. It reads
 * as the assistant when the assistant has a name and as the owner when it
 * is an unnamed default, links to the assistant editor either way, keeps
 * the team name when the assistant cannot be resolved, and says nothing
 * about a personal row that belongs to the reader's own default assistant.
 *
 * Mocks `~/api/settings` for the teams list and the caller's identity, and
 * `@tanstack/react-router` the way the route suites do — the real `Link`
 * wants a router this suite has no reason to mount. `params` is serialized
 * onto the stub so a case can read the assistant the badge navigates to.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ListAssistantsResponse, ListTeamsResponse } from "@valet/api/wire";
import { TooltipProvider } from "~/components/primitives";

let teamsData: ListTeamsResponse = { teams: [] };
let assistantsData: ListAssistantsResponse = { assistants: [] };
let meId: string | undefined = "u1";
/** Whether `useMe` has FAILED rather than being in flight. Both answer no
 * identity, and the quiet rule has to survive each. Same fixture shape as
 * the subscriptions panel suite. */
let meFailed = false;

vi.mock("~/api/settings", () => ({
  useTeams: () => ({ data: teamsData, isLoading: false, error: null }),
  useMe: () => ({
    data: meId === undefined ? undefined : { id: meId, orgRole: "member" },
    isLoading: meId === undefined && !meFailed,
    isError: meFailed,
    error: meFailed ? new Error("identity unavailable") : null,
  }),
}));

vi.mock("~/api/assistants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/assistants")>();
  return {
    ...actual,
    useAssistants: () => ({ data: assistantsData, isLoading: false, error: null }),
  };
});

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    params,
    ...rest
  }: {
    children: ReactNode;
    params?: unknown;
    [key: string]: unknown;
  }) => (
    <a data-params={JSON.stringify(params)} {...rest}>
      {children}
    </a>
  ),
}));

import { AssistantBadge } from "./assistant-badge";

function team(over: Partial<ListTeamsResponse["teams"][number]> = {}) {
  return {
    id: "team_1",
    orgId: "org_1",
    name: "Design",
    origin: "local" as const,
    externalId: null,
    createdAt: 1,
    memberCount: 3,
    callerRole: "member" as const,
    defaultModel: null,
    ...over,
  };
}

function assistant(
  over: Partial<ListAssistantsResponse["assistants"][number]> = {},
): ListAssistantsResponse["assistants"][number] {
  return {
    id: "asst_team_1",
    owner: { type: "team", id: "team_1" },
    sessionId: "assistant:asst_team_1",
    isDefault: true,
    createdAt: 1,
    ...over,
  };
}

function show(props: {
  ownerType: "user" | "team" | "org";
  ownerId: string;
  assistantId?: string;
}) {
  return render(
    <TooltipProvider>
      <AssistantBadge {...props} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  teamsData = { teams: [team()] };
  assistantsData = { assistants: [] };
  meId = "u1";
  meFailed = false;
});

describe("AssistantBadge", () => {
  it("names a pinned persona and links to its editor", () => {
    assistantsData = {
      assistants: [
        assistant(),
        assistant({
          id: "asst_persona",
          name: "Release Captain",
          isDefault: false,
          sessionId: "assistant:asst_persona",
        }),
      ],
    };
    const { container } = show({
      ownerType: "team",
      ownerId: "team_1",
      assistantId: "asst_persona",
    });

    expect(screen.getByText("Release Captain")).toBeTruthy();
    const link = container.querySelector("a");
    expect(link?.getAttribute("to")).toBe("/assistants/$assistantId");
    expect(JSON.parse(link?.getAttribute("data-params") ?? "null")).toEqual({
      assistantId: "asst_persona",
    });
  });

  // A team's unnamed default is the assistant every machine-driven path
  // targets when nobody chose. It has no name of its own, so the row reads
  // as the team and still opens the assistant.
  it("reads as the owning team when the row runs on an unnamed default", () => {
    assistantsData = { assistants: [assistant()] };
    const { container } = show({ ownerType: "team", ownerId: "team_1" });

    expect(screen.getByText("Design")).toBeTruthy();
    expect(screen.queryByText("Default Orchestrator")).toBeNull();
    const link = container.querySelector("a");
    expect(link?.getAttribute("to")).toBe("/assistants/$assistantId");
    expect(JSON.parse(link?.getAttribute("data-params") ?? "null")).toEqual({
      assistantId: "asst_team_1",
    });
  });

  it("reads as the assistant when a default carries a name", () => {
    assistantsData = { assistants: [assistant({ name: "Platform Bot" })] };
    show({ ownerType: "team", ownerId: "team_1" });

    expect(screen.getByText("Platform Bot")).toBeTruthy();
    expect(screen.queryByText("Design")).toBeNull();
  });

  // `GET /api/assistants` does not list org-owned assistants today, so this
  // is a guard on the branch, not on a state the product reaches. It holds
  // the rule for the day the route lists them.
  it("reads as the org when an org row runs on an unnamed default (forward guard)", () => {
    assistantsData = {
      assistants: [
        assistant({
          id: "asst_org",
          owner: { type: "org", id: "org_1" },
          sessionId: "assistant:asst_org",
        }),
      ],
    };
    const { container } = show({ ownerType: "org", ownerId: "org_1" });

    expect(screen.getByText("Org")).toBeTruthy();
    expect(container.querySelector("a")?.getAttribute("to")).toBe("/assistants/$assistantId");
  });

  // The editor opens read-only for a reader who cannot administer the
  // assistant, so the tooltip promises an edit only to a reader who can.
  it("names the destination and the workspace on hover, and who may edit", () => {
    assistantsData = { assistants: [assistant()] };
    const member = show({ ownerType: "team", ownerId: "team_1" });
    fireEvent.focus(member.container.querySelector("a") as HTMLAnchorElement);
    expect(screen.getAllByText("Open Default Orchestrator · Design").length).toBeGreaterThan(0);

    teamsData = { teams: [team({ callerRole: "admin" })] };
    const admin = show({ ownerType: "team", ownerId: "team_1" });
    fireEvent.focus(admin.container.querySelector("a") as HTMLAnchorElement);
    expect(screen.getAllByText("Edit Default Orchestrator · Design").length).toBeGreaterThan(0);
  });

  // A stale id, or an assistant the caller may not open. The row is still
  // team-owned, so the badge keeps the ownership signal and drops the link.
  it("keeps the team name, unlinked, when the assistant cannot be resolved", () => {
    const { container } = show({ ownerType: "team", ownerId: "team_1" });

    expect(screen.getByText("Design")).toBeTruthy();
    expect(container.querySelector("a")).toBeNull();
  });

  it("says nothing about a personal row the reader's own default assistant owns", () => {
    assistantsData = {
      assistants: [
        assistant({
          id: "asst_mine",
          owner: { type: "user", id: "u1" },
          sessionId: "assistant:asst_mine",
        }),
      ],
    };
    const { container } = show({ ownerType: "user", ownerId: "u1" });

    expect(container.textContent).toBe("");
    expect(container.querySelector("a")).toBeNull();
  });

  // The identity query answers after the first paint. A row the reader owns
  // must not flash its badge in and then out, but a row whose assistant is
  // somebody else's must not be hidden for the wait either.
  it("keeps a personal row's badge while the reader is unknown, unless the row is theirs", () => {
    meId = undefined;
    assistantsData = {
      assistants: [
        assistant({
          id: "asst_org",
          owner: { type: "org", id: "org_1" },
          sessionId: "assistant:asst_org",
        }),
        assistant({
          id: "asst_mine",
          owner: { type: "user", id: "u1" },
          sessionId: "assistant:asst_mine",
        }),
      ],
    };
    const shared = show({ ownerType: "user", ownerId: "u1", assistantId: "asst_org" });
    expect(shared.container.textContent).toBe("Org");

    const own = show({ ownerType: "user", ownerId: "u1" });
    expect(own.container.textContent).toBe("");
  });

  // An identity read that FAILS answers no reader for the rest of the
  // session. The quiet rule has to hold then too, or every personal row
  // badges its own default assistant for ever.
  it("stays quiet on the reader's own row when the identity read fails", () => {
    meId = undefined;
    meFailed = true;
    assistantsData = {
      assistants: [
        assistant({
          id: "asst_mine",
          owner: { type: "user", id: "u1" },
          sessionId: "assistant:asst_mine",
        }),
      ],
    };
    const { container } = show({ ownerType: "user", ownerId: "u1" });

    expect(container.textContent).toBe("");
  });

  it("names a persona on a personal row", () => {
    assistantsData = {
      assistants: [
        assistant({
          id: "asst_scribe",
          owner: { type: "user", id: "u1" },
          sessionId: "assistant:asst_scribe",
          name: "Scribe",
          isDefault: false,
        }),
      ],
    };
    show({ ownerType: "user", ownerId: "u1", assistantId: "asst_scribe" });

    expect(screen.getByText("Scribe")).toBeTruthy();
  });
});
