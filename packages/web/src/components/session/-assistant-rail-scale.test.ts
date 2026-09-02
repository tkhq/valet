/**
 * How the rail turns the assistants list into the rows it draws: grouping by
 * owner, resolving `?assistant=`, and naming a row.
 *
 * The rail used to hold every owner's assistants at once and needed a row
 * cap to stay bounded — measured at 42% of the sidebar with nine teams. The
 * workspace switcher retired that: the rail now draws one workspace, so its
 * height follows one owner's list however many teams you are on. The cap and
 * its fair-share pass are gone, and so are their cases.
 */
import { describe, expect, it } from "vitest";
import type { AssistantSummary, TeamSummary } from "@valet/api/wire";
import {
  assistantLabel,
  findAssistant,
  groupAssistants,
  ownDefaultAssistant,
  scopedDefaultAssistant,
} from "./assistant-rail";

function team(id: string, name = id, callerRole: "admin" | "member" | null = "member"): TeamSummary {
  return {
    id,
    orgId: "org_1",
    name,
    origin: "local",
    externalId: null,
    createdAt: 0,
    memberCount: 2,
    callerRole,
    defaultModel: null,
  };
}

function own(id: string, over: Partial<AssistantSummary> = {}): AssistantSummary {
  return {
    id,
    owner: { type: "user", id: "u1" },
    sessionId: `assistant:${id}`,
    isDefault: false,
    createdAt: 0,
    ...over,
  };
}

function ownedBy(teamId: string, id: string, over: Partial<AssistantSummary> = {}): AssistantSummary {
  return { ...own(id, over), owner: { type: "team", id: teamId } };
}

describe("groupAssistants", () => {
  const teams = [team("t1", "Platform"), team("t2", "Design")];

  it("puts your own assistants first, then each team in the given order", () => {
    const groups = groupAssistants(
      [ownedBy("t2", "d1"), own("mine"), ownedBy("t1", "p1")],
      teams,
    );
    expect(groups.map((g) => g.key)).toEqual(["user", "t1", "t2"]);
    expect(groups[0]?.label).toBe("Your assistants");
    expect(groups[1]?.label).toBe("Platform");
  });

  it("keeps every assistant a team owns, not just one", () => {
    const groups = groupAssistants(
      [ownedBy("t1", "p1"), ownedBy("t1", "p2"), ownedBy("t1", "p3")],
      teams,
    );
    expect(groups.map((g) => g.assistants.map((a) => a.id))).toEqual([["p1", "p2", "p3"]]);
  });

  it("drops assistants of a team the caller may not open", () => {
    // `eligibleTeams` has already removed the team, so its assistant has no
    // group to sit in — an org admin does not get a team's assistant in
    // their own sidebar just because they administer the org.
    expect(groupAssistants([ownedBy("t9", "x1")], teams)).toEqual([]);
  });

  it("drops org-owned assistants, which no route creates and no header names", () => {
    const orgOwned: AssistantSummary = { ...own("o1"), owner: { type: "org", id: "org_1" } };
    expect(groupAssistants([orgOwned], teams)).toEqual([]);
  });

  it("renders nothing while the list is unresolved", () => {
    expect(groupAssistants(undefined, teams)).toEqual([]);
  });

  it("omits a team that owns no assistant rather than heading an empty group", () => {
    expect(groupAssistants([own("mine")], teams).map((g) => g.key)).toEqual(["user"]);
  });
});

describe("findAssistant and ownDefaultAssistant", () => {
  const groups = groupAssistants(
    [own("mine"), own("second", { isDefault: true }), ownedBy("t1", "p1")],
    [team("t1", "Platform")],
  );

  it("finds an assistant the caller can reach", () => {
    expect(findAssistant(groups, "p1")?.id).toBe("p1");
  });

  it("returns nothing for an id the caller cannot reach", () => {
    expect(findAssistant(groups, "asst_nope")).toBeUndefined();
  });

  it("returns nothing when no assistant is named", () => {
    expect(findAssistant(groups, undefined)).toBeUndefined();
  });

  it("falls back to the default of your own assistants", () => {
    expect(ownDefaultAssistant(groups)?.id).toBe("second");
  });
});

describe("scopedDefaultAssistant", () => {
  const groups = groupAssistants(
    [
      own("mine"),
      own("second", { isDefault: true }),
      ownedBy("t1", "p1"),
      ownedBy("t1", "p2", { isDefault: true }),
    ],
    [team("t1", "Platform")],
  );

  it("opens the active team's default, not your own — the reported bug", () => {
    expect(scopedDefaultAssistant(groups, "t1")?.id).toBe("p2");
  });

  it("opens your own default when the scope is personal", () => {
    expect(scopedDefaultAssistant(groups, "user")?.id).toBe("second");
  });

  it("falls back to the first when a workspace marks no default", () => {
    const noDefault = groupAssistants([ownedBy("t1", "p1"), ownedBy("t1", "p2")], [team("t1")]);
    expect(scopedDefaultAssistant(noDefault, "t1")?.id).toBe("p1");
  });

  it("is undefined for a workspace that owns no assistant, so the caller can tell", () => {
    // A team with no assistant returns undefined rather than borrowing your
    // own default — the caller decides whether to fall back or create one.
    expect(scopedDefaultAssistant(groupAssistants([own("mine")], [team("t1")]), "t1")).toBeUndefined();
  });
});

describe("assistantLabel", () => {
  it("uses the name someone chose", () => {
    expect(assistantLabel(own("a", { name: "Aurora" }))).toBe("Aurora");
  });

  it("says an unnamed assistant is untitled rather than inventing a name", () => {
    expect(assistantLabel(own("a"))).toBe("Untitled assistant");
    expect(assistantLabel(own("a", { name: "  " }))).toBe("Untitled assistant");
  });

  it("names an unnamed default for what it is", () => {
    expect(assistantLabel(own("a", { isDefault: true }))).toBe("Default assistant");
  });
});
